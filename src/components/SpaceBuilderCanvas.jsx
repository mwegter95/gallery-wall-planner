/**
 * SpaceBuilderCanvas3D — Three.js 3D builder canvas.
 * Drag bg = orbit | Scroll = zoom | Click = select | Drag surface = move (XZ)
 * Shift+drag = move Y | Arrow keys = rotate selected | Dbl-click = crop editor
 * Edge snap: drag a surface near another's edge → release to connect
 */
import { useRef, useState, useEffect, useCallback } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { SURFACE_COLORS, warpSurface } from '../utils/spaceAssembler'
import { warpPerspectiveAsync } from '../utils/homography'
import { PointCloudBuffer, planesFromJSON } from '../utils/pointCloud'
import { reconstructPlanarSurfaces } from '../utils/scanReconstructionPipeline'
import { applyOrbitJoystickStep, radiusToSlider, scaleZoomRadius, ZOOM_MIN, ZOOM_MAX } from '../utils/cameraControls'
import { HANDLE_OFFSET, HANDLE_PAD, HANDLE_DIR, HANDLE_COLORS } from '../utils/warpHandles'
import { loadRecentScanBuffer, saveRecentScanBuffer } from '../utils/recentScanCache'
import { BASE, getJwt, getDeviceToken, getSnapshots } from '../utils/api'

const IN_TO_M   = 0.0254
const SNAP_DIST = 0.35
const EDGE_LIST = ['left', 'right', 'top', 'bottom']
const EDGE_LOCAL = {
  left:   new THREE.Vector3(-0.5, 0, 0),
  right:  new THREE.Vector3( 0.5, 0, 0),
  top:    new THREE.Vector3( 0,  0.5, 0),
  bottom: new THREE.Vector3( 0, -0.5, 0),
}
function edgeWorldMid(mesh, edge, wM, hM) {
  const v = EDGE_LOCAL[edge].clone(); v.x *= wM; v.y *= hM
  return v.applyMatrix4(mesh.matrixWorld)
}
function dims(s) { return { wM: s.widthIn * IN_TO_M, hM: s.heightIn * IN_TO_M } }

/**
 * Draw piece overlays on top of a base texture and return a composite data URL.
 * Base URL → offscreen canvas → draw each piece (image or solid colour) → JPEG.
 */
async function compositePiecesOntoTexture(surface, baseDataUrl, pieces) {
  return new Promise((resolve, reject) => {
    const base = new Image()
    base.onload = async () => {
      const canvas = document.createElement('canvas')
      canvas.width  = base.naturalWidth
      canvas.height = base.naturalHeight
      const ctx = canvas.getContext('2d')
      ctx.drawImage(base, 0, 0)

      const cW = canvas.width
      const cH = canvas.height

      for (const piece of pieces) {
        const px = (piece.x      / surface.widthIn)  * cW
        const py = (piece.y      / surface.heightIn) * cH
        const pw = (piece.width  / surface.widthIn)  * cW
        const ph = (piece.height / surface.heightIn) * cH

        if (piece.image) {
          await new Promise(res => {
            const img = new Image()
            img.crossOrigin = 'anonymous'
            img.onload  = () => { ctx.drawImage(img, px, py, pw, ph); res() }
            img.onerror = res  // skip on error
            img.src = piece.image
          })
        } else {
          // Solid colour fill
          ctx.fillStyle = piece.color || '#888888'
          ctx.fillRect(px, py, pw, ph)
          // Piece name label
          const fontSize = Math.max(10, Math.min(ph * 0.18, 22))
          ctx.font      = `bold ${fontSize}px sans-serif`
          ctx.fillStyle = '#ffffff'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(piece.name || '', px + pw / 2, py + ph / 2, pw)
        }
      }

      resolve(canvas.toDataURL('image/jpeg', 0.92))
    }
    base.onerror = reject
    base.src = baseDataUrl
  })
}

// ── Solid-disc splat shaders ────────────────────────────────────────────────
// Each LiDAR point renders as a solid opaque disc with a hard circular clip.
// depthWrite: true + opaque alpha means discs correctly occlude one another,
// so the point cloud reads as a solid coloured surface rather than a cloud of
// semi-transparent halos.
//
// splatScale is computed from a 10 cm voxel density and drives disc size
// so dense regions stay smooth while sparse areas stay readable.
//
// Sizing math (solid discs need ~10–20 % less radius than Gaussian blobs):
//   projectionMatrix[1][1] = cot(halfFOV_y) in column-major GLSL mat4.
//   At 55° FOV (cot≈2.05), depth 3 m, splatScale 1.0 → 7.0 * 2.05 / 3 ≈ 4.8 px.
//   Average inter-point gap at 3 m with 10 M points ≈ 1.15 px → gap completely
//   closed by a 2.4 px-radius opaque disc. Minimum 1.5 px ensures single-pixel
//   points are still visible at maximum zoom-out.

const SPLAT_VERT = /* glsl */`
  // aLocalSpacing: per-point adaptive splat diameter computed from local
  // LiDAR return density.  Dense areas → tiny splats; sparse → slightly larger.
  // Stored as a vertex attribute so the GPU can vary size per-point.
  attribute float aLocalSpacing;
  uniform float uViewH;     // FBO height [px] — updated by ResizeObserver
  uniform float uYOffset;   // floor-lift: raw_y + uYOffset = scene_y
  uniform float uFloorY;    // raw-space Y below which points are floor
  uniform float uCeilY;     // raw-space Y above which points are ceiling
  uniform float uRoomCX;    // raw-space X centre of room
  uniform float uRoomCZ;    // raw-space Z centre of room

  varying vec3 vColor;

  void main() {
    vColor = color;

    // Apply Y-offset so floor lands at y=0 in scene space.
    vec4 mvPos = modelViewMatrix * vec4(position.x, position.y + uYOffset, position.z, 1.0);

    // Procedural surface normal: floor → up, ceiling → down, walls → outward.
    vec3 norm;
    if (position.y <= uFloorY) {
      norm = vec3(0.0, 1.0, 0.0);
    } else if (position.y >= uCeilY) {
      norm = vec3(0.0, -1.0, 0.0);
    } else {
      float dx = position.x - uRoomCX;
      float dz = position.z - uRoomCZ;
      float len = max(length(vec2(dx, dz)), 0.001);
      norm = vec3(dx / len, 0.0, dz / len);
    }

    // View-dependent disc enlargement — cap at 1.4× to avoid bowling-ball look.
    vec3  mvN         = normalize(normalMatrix * norm);
    float cosView     = max(0.30, abs(mvN.z));
    float angleFactor = min(1.4, 1.0 / cosView);

    // Adaptive Wegter: per-point diameter drives gl_PointSize.
    gl_PointSize = clamp(aLocalSpacing * angleFactor * projectionMatrix[1][1] * uViewH * 0.5 / -mvPos.z, 1.0, 48.0);
    gl_Position  = projectionMatrix * mvPos;
  }
`

const SPLAT_FRAG = /* glsl */`
  varying vec3 vColor;
  uniform int uDiagMode; // 0=normal, 1=depth-false-color, 2=normal-dir

  void main() {
    // Hard circular clip — discard corners of the GL_POINT square.
    vec2  uv = gl_PointCoord - 0.5;
    float r2 = dot(uv, uv);
    if (r2 > 0.25) discard;

    vec3 col;
    if (uDiagMode == 1) {
      // Depth false-colour: near=warm, far=cool
      float d = gl_FragCoord.z;
      col = mix(vec3(1.0, 0.3, 0.0), vec3(0.0, 0.4, 1.0), clamp(d * 2.0 - 0.5, 0.0, 1.0));
    } else {
      // Normal colour grading: +35% saturation + gamma lift
      col = vColor;
      float luma = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(luma), col, 1.35);
      col = pow(clamp(col, 0.0, 1.0), vec3(0.88));
    }

    gl_FragColor = vec4(col, 1.0);
  }
`

// ── Projective-texturing splat shaders ───────────────────────────────────────
// SPLAT_VERT_PROJ extends the base splat vertex shader with two varyings that
// carry the fragment's world-space position and splat half-radius to the frag
// shader so it can project each sub-pixel of the disc onto the camera images.

const SPLAT_VERT_PROJ = /* glsl */`
  // WPA-4: per-point surface normal from CPU PCA (Jacobi on local LiDAR voxels).
  // Replaces the procedural room-centre radial approximation that mis-classified
  // wall points near corners and let opposite-wall cameras bleed through.
  attribute float aLocalSpacing;
  attribute vec3  aNormal;       // outward surface normal (estimated on CPU)
  attribute float aCamAssign;    // WPA-4: packed top-3 camera assignment from CPU pre-pass
  uniform float uViewH;
  uniform float uYOffset;
  uniform float uFloorY;
  uniform float uCeilY;
  uniform float uRoomCX;
  uniform float uRoomCZ;

  varying vec3  vColor;
  varying vec3  vWorldPos;
  varying float vSplatR;
  varying vec3  vNorm;
  varying float vCamAssign;      // WPA-4: forwarded camera assignment to fragment shader

  void main() {
    vColor = color;

    vec4 mvPos = modelViewMatrix * vec4(position.x, position.y + uYOffset, position.z, 1.0);

    // Use the CPU-estimated PCA normal; fall back to radial if attribute absent.
    vec3 norm = normalize(aNormal);

    vNorm = norm;
    vCamAssign = aCamAssign;

    vec3  mvN         = normalize(normalMatrix * norm);
    float cosView     = max(0.30, abs(mvN.z));
    float angleFactor = min(1.4, 1.0 / cosView);

    vWorldPos = vec3(position.x, position.y + uYOffset, position.z);
    vSplatR   = aLocalSpacing * angleFactor * 0.5;

    gl_PointSize = clamp(aLocalSpacing * angleFactor * projectionMatrix[1][1] * uViewH * 0.5 / -mvPos.z, 1.0, 48.0);
    gl_Position  = projectionMatrix * mvPos;
  }
`

// makeProjFragShader — Wegter Projection Algorithm v4 (WPA-4)
//
// WPA-4 over WPA-2.2:
//
//   BUG FIX — V-axis double-flip removed
//     WPA-2.x sampled at vec2(u, 1.0 − v).  With flipY=false textures the
//     mapping is already correct (v=0 = top of image); the extra (1−v) caused
//     every photo to appear vertically mirrored / 180°-rotated on the wall.
//     WPA-4 samples directly at vec2(u, v).
//
//   BUG FIX — Per-point PCA normals replace procedural room-centre radial
//     WPA-2 estimated surface normals as "outward from room centre in XZ".
//     This is wrong for any non-axis-aligned surface and allows cameras
//     looking at the opposite wall to contribute non-zero facing scores for
//     corner / edge points.  WPA-4 uses per-point normals pre-computed on the
//     CPU via Jacobi eigendecomposition of the 27-voxel-neighbourhood
//     covariance matrix (see minEigenvec3 + upgradeProjectiveTexturing JS).
//
//   NEW — In-plane "spin" alignment factor
//     For each camera, how well does its Y axis align with the surface's
//     vertical direction?  A camera that is "spun" (rolled around the view
//     vector) samples the wall at a rotated angle and contributes a stretched,
//     rotated image.  spinFactor = |dot(camY_world, surfaceUp)| penalises
//     heavily-rotated cameras while rewarding face-on captures.
//     Score: angRes × facing⁶ × cosView⁴ × spinFactor²
//     (cosView exponent restored to ⁴ from WPA-4's ² to suppress UW panoramic wrapping)
//
//   NEW — Hard facing cutoff at 0.35 (≈ 70° incidence angle)
//     Any camera whose surface-normal–camera-direction angle exceeds 70° is
//     completely excluded regardless of other score terms.
//
//   NEW — Tighter winner-takes-all blend (BLEND_RATIO 0.50, score⁵ weight)
//     Reduces the number of cameras that contribute to a single point from
//     typically 3-4 down to 1-2, sharpening the projected image.
//
// GLSL ES 1.00 constraints respected (same as WPA-2):
//   • No glslVersion THREE.GLSL3 — iOS Safari/WebKit gl_PointCoord bug
//   • No dynamic sampler indexing — static if-chain dispatch
//   • Local float/int arrays are safely loop-indexed in ES 1.00
function makeProjFragShader(nCams) {
  const samplerDecls = Array.from({ length: nCams }, (_, i) =>
    `uniform sampler2D uCamTex${i};`).join('\n    ')

  const sampleCases = Array.from({ length: nCams }, (_, i) =>
    `if (idx == ${i}) return texture2D(uCamTex${i}, uv).rgb;`).join('\n      ')

  return /* glsl */`
    precision highp float;
    precision highp int;
    #define N_CAMS      ${nCams}
    // WPA-5 UW FIX: raised from 0.50 back to WPA-2.1's proven 0.70.
    // At 0.50, cameras 30° off-axis (cv8≈0.317) could still blend; at 0.70 the
    // effective contribution window is ≈18° off-axis — enough to eliminate the
    // panoramic wrapping seen with the 102° UW camera.
    #define BLEND_RATIO 0.70
    // WPA-4: hard facing cutoff — cameras > 70° from surface normal are skipped.
    // Keep this strict to suppress panoramic-style duplication from highly oblique
    // cameras that otherwise survive with non-zero score terms.
    #define MIN_FACING  0.35

    ${samplerDecls}
    uniform mat4      uW2C[N_CAMS];
    uniform vec4      uCamK[N_CAMS];    // (fx_n, fy_n, cx_n, cy_n) normalised
    uniform float     uCamFx[N_CAMS];  // raw fx (pixels) for angular-res score
    uniform float     uCamOri[N_CAMS]; // 0=landscape, 1=portrait 90°CW
    // WPA-4: camera Y axis in world space (c2w column 1) for spin-alignment score
    uniform vec3      uCamY[N_CAMS];
    uniform int       uDiagMode;
    uniform float     uYOffset;

    varying vec3  vColor;
    varying vec3  vWorldPos;
    varying float vSplatR;
    varying vec3  vNorm;
    varying float vCamAssign;

    vec3 sampleCam(int idx, vec2 uv) {
      ${sampleCases}
      return vec3(0.0);
    }

    void main() {
      vec2 pc = gl_PointCoord - 0.5;
      if (dot(pc, pc) > 0.25) discard;

      // Project the point centre (not per-fragment disc position) so every
      // sub-pixel of a splat gets the same UV — no smearing as camera moves.
      vec3 fragRaw = vec3(vWorldPos.x, vWorldPos.y - uYOffset, vWorldPos.z);

      // WPA-4: surface "up" = worldUp projected onto the surface plane.
      // Used by the spin-alignment score.  For floor/ceiling (normal ≈ worldUp)
      // surfUpLen → 0 and spinFactor is clamped to 1 (no spin penalty).
      vec3 worldUp  = vec3(0.0, 1.0, 0.0);
      vec3 surfUpRaw = worldUp - dot(worldUp, vNorm) * vNorm;
      float surfUpLen = length(surfUpRaw);
      vec3 surfUp = surfUpLen > 0.01 ? surfUpRaw / surfUpLen : worldUp;

      // ── WPA-4: unpack per-point top-3 camera assignment ──────────────────
      // CPU pre-pass packed top-3 camera indices as:
      //   cam0 + cam1×32 + cam2×1024 + count×32768
      // Encoding uses 5 bits per index (fits 0-31, we have ≤ 24 cameras).
      // Float32 exact integer representation: max value ≈ 3×32768 = 98304 < 2^17.
      float _packed  = vCamAssign;
      float _cnt_f   = floor(_packed / 32768.0);
      int   _camCnt  = int(_cnt_f);
      float _rem     = mod(_packed, 32768.0);
      int   _cam0    = int(mod(_rem, 32.0));  _rem = floor(_rem / 32.0);
      int   _cam1    = int(mod(_rem, 32.0));  _rem = floor(_rem / 32.0);
      int   _cam2    = int(_rem);

      // ── Pass 1: score every camera, cache UV ─────────────────────────────
      float scores_arr[N_CAMS];
      float us_arr[N_CAMS];
      float vs_arr[N_CAMS];
      float bestScore = 0.0;

      for (int i = 0; i < N_CAMS; i++) {
        scores_arr[i] = 0.0;
        us_arr[i]     = 0.0;
        vs_arr[i]     = 0.0;

        // Skip cameras not in this point's top-3 CPU assignment.
        // This check is O(1) and avoids expensive projection for 21/24 cameras.
        // Reduces effective GPU work from 24→3 iterations per fragment.
        // GLSL ES 1.0 note: comparing float(loop_int) == float(varying_int) is
        // exact for small integers (all values < 32 here, well within float32).
        float _fi = float(i);
        bool _assigned = (float(_camCnt) > 0.0 && _fi == float(_cam0)) ||
                         (float(_camCnt) > 1.0 && _fi == float(_cam1)) ||
                         (float(_camCnt) > 2.0 && _fi == float(_cam2));
        if (!_assigned) continue;

        vec4  cp    = uW2C[i] * vec4(fragRaw, 1.0);
        if (cp.z >= -0.05) continue;
        float depth = -cp.z;

        // ── Pinhole projection ────────────────────────────────────────────
        // K is in sensor/display frame; uCamOri corrects for portrait rotation.
        // With flipY=false textures, v=0 = top of image, so no extra (1−v) flip.
        float u0 = uCamK[i].x * cp.x / depth + uCamK[i].z;
        float v0 = uCamK[i].y * (-cp.y) / depth + uCamK[i].w;
        float u  = u0;
        float v  = v0;
        int   ori = int(floor(uCamOri[i] + 0.5));
        if      (ori == 1) { u = 1.0 - v0; v = u0;        }
        else if (ori == 2) { u = 1.0 - u0; v = 1.0 - v0;  }
        else if (ori == 3) { u = v0;        v = 1.0 - u0;  }

        // Ultra-wide guardrail: when fx/fw is small (~0.40), pinhole projection
        // is less reliable near image periphery (lens distortion / off-axis error).
        // Increase UV margin for UW cameras while keeping wide cameras unchanged.
        float fxn = uCamK[i].x;
        // Ramp: denominator 0.11 ensures fxn=0.404 (640×480 UW) maps to uwT=1.0 exactly.
        // Was 0.18 → uwT=0.644 for UW (only 64% of cv8/mg/minCosView active).
        float uwT = clamp((0.52 - fxn) / 0.11, 0.0, 1.0); // 0=wide, 1=ultra-wide
        float mg = mix(0.08, 0.20, uwT);
        if (u < mg || u > 1.0 - mg || v < mg || v > 1.0 - mg) continue;

        // ── WPA-5 score = angRes × facing⁶ × cosView⁴ × spinFactor² ──────
        //
        // angRes: angular resolution at this depth — closer / higher-fx wins.
        float angRes  = uCamFx[i] / (depth * depth + 0.001);

        // facing⁶: how squarely the camera sees the surface normal.
        //   • Raised from facing⁴ (WPA-2.2) to facing⁶ for sharper falloff.
        //   • Hard cutoff at MIN_FACING (≈70° incidence) pre-filters far-off cameras.
        vec3  normCam  = (uW2C[i] * vec4(vNorm, 0.0)).xyz;
        float facing   = max(0.0, -normCam.z);
        if (facing < MIN_FACING) continue;   // WPA-4: hard cutoff
        float f2       = facing * facing;
        float f6       = f2 * f2 * f2;      // facing⁶

        // cosView⁴: off-axis penalty — restored to WPA-2.1 exponent.
        //   WPA-4 reduced this to cosView² reasoning that facing⁶ already handles
        //   oblique cameras — true for the main camera (76° DFOV), but the ultra-wide
        //   camera (~120° DFOV) places genuine scene points 50-60° off-axis where the
        //   pinhole model diverges from the real (barrel-distorted) lens.  At 55° off-
        //   axis: cosView⁴ ≈ 0.11 vs cosView² ≈ 0.33 — the 3× stronger penalty
        //   prevents the UW camera winning for edge projections that map to the wrong
        //   world location, which was the root cause of the panoramic-wrapping
        //   duplication (same fix as WPA-2.1 which first eliminated this artifact).
        float cpLen   = length(cp.xyz);
        float cosView = cpLen > 0.001 ? depth / cpLen : 0.0;
        float minCosView = mix(0.35, 0.62, uwT);
        if (cosView < minCosView) continue;
        float cv2     = cosView * cosView;
        float cv4     = cv2 * cv2;   // cosView⁴
        float cv8     = cv4 * cv4;
        float cv      = mix(cv4, cv8, uwT); // stronger off-axis penalty for UW

        // spinFactor²: how well the camera's "up" aligns with the surface's "up".
        //   Perfect face-on capture with phone upright = spinFactor 1.0.
        //   Camera rolled 90° relative to the wall = spinFactor ≈ 0 → penalised.
        //   Clamped to 0.25 min so a misaligned camera still contributes weakly
        //   (avoids coverage gaps when the user scans with a tilted phone).
        float spinRaw    = surfUpLen > 0.01 ? abs(dot(uCamY[i], surfUp)) : 1.0;
        float spinFactor = max(0.25, spinRaw);
        float sf2        = spinFactor * spinFactor;

        float score = angRes * f6 * cv * sf2;

        scores_arr[i] = score;
        us_arr[i]     = u;
        vs_arr[i]     = v;
        bestScore     = max(bestScore, score);
      }

      // ── Pass 2: soft winner-takes-all blend ───────────────────────────────
      // WPA-4: BLEND_RATIO 0.50 + score⁵ weight → typically 1-2 cameras win.
      vec3  accColor  = vec3(0.0);
      float accWeight = 0.0;

      if (bestScore > 0.001) {
        float thresh = bestScore * BLEND_RATIO;
        for (int i = 0; i < N_CAMS; i++) {
          if (scores_arr[i] < thresh) continue;
          float w3 = scores_arr[i] * scores_arr[i] * scores_arr[i];
          float w  = w3 * scores_arr[i] * scores_arr[i]; // score⁵
          // WPA-4 BUG FIX: sample at (u, v) — NOT (u, 1−v).
          // The old (1−v) was a double-flip: the projection formula already
          // accounts for image-Y-down vs camera-Y-up, and flipY=false means
          // v=0 in the shader directly maps to the top row of the JPEG.
          accColor  += sampleCam(i, vec2(us_arr[i], vs_arr[i])) * w;
          accWeight += w;
        }
      }

      vec3 col;
      if (accWeight > 0.0) {
        col = accColor / accWeight;
        col = pow(clamp(col, 0.0, 1.0), vec3(0.9));
      } else {
        // Fallback: vertex colour (on-device LiDAR colour)
        col = vColor;
        float luma = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(vec3(luma), col, 1.35);
        col = pow(clamp(col, 0.0, 1.0), vec3(0.88));
      }

      if (uDiagMode == 1) {
        float d = gl_FragCoord.z;
        col = mix(vec3(1.0, 0.3, 0.0), vec3(0.0, 0.4, 1.0), clamp(d * 2.0 - 0.5, 0.0, 1.0));
      } else if (uDiagMode == 2) {
        col = vColor;
      }

      gl_FragColor = vec4(col, 1.0);
    }
  `
}

function c2wToW2c(c2w) {
  return new THREE.Matrix4().fromArray(c2w).invert().toArray()
}

function applyUvOrientation(u0, v0, ori) {
  if (ori === 1) return [1 - v0, u0]
  if (ori === 2) return [1 - u0, 1 - v0]
  if (ori === 3) return [v0, 1 - u0]
  return [u0, v0]
}

// ── Jacobi eigendecomposition for 3×3 symmetric matrix ───────────────────────
// Returns the eigenvector corresponding to the MINIMUM eigenvalue — this is the
// surface normal direction (the direction of least point-cloud variance).
// Used by WPA-4 to estimate per-point normals from the LiDAR voxel grid.
//
// Algorithm: cyclic Jacobi sweeps (10 iterations, converges to ε < 1e-10).
// Input:  6 unique elements of the symmetric matrix A
// Output: [nx, ny, nz] unit eigenvector for min eigenvalue
function minEigenvec3(c00, c01, c02, c11, c12, c22) {
  // Flatten symmetric matrix A (row-major)
  const a = [c00, c01, c02, c01, c11, c12, c02, c12, c22]
  // Q accumulates rotation matrices; columns of Q converge to eigenvectors
  const q = [1, 0, 0,  0, 1, 0,  0, 0, 1]
  for (let it = 0; it < 20; it++) {
    // Find the off-diagonal element with the largest absolute value
    let maxV = 0, p = 0, r = 1
    if (Math.abs(a[1]) > maxV) { maxV = Math.abs(a[1]); p = 0; r = 1 }
    if (Math.abs(a[2]) > maxV) { maxV = Math.abs(a[2]); p = 0; r = 2 }
    if (Math.abs(a[5]) > maxV) { maxV = Math.abs(a[5]); p = 1; r = 2 }
    if (maxV < 1e-12) break
    // Jacobi rotation
    const app = a[p*3+p], arr = a[r*3+r], apr = a[p*3+r]
    const theta = (arr - app) / (2 * apr)
    const t     = Math.sign(theta) / (Math.abs(theta) + Math.sqrt(1 + theta * theta))
    const c     = 1 / Math.sqrt(1 + t * t)
    const s     = t * c
    // Update A
    a[p*3+p] = app - t * apr
    a[r*3+r] = arr + t * apr
    a[p*3+r] = 0; a[r*3+p] = 0
    for (let k = 0; k < 3; k++) {
      if (k === p || k === r) continue
      const akp = a[k*3+p], akr = a[k*3+r]
      a[k*3+p] = c*akp - s*akr; a[p*3+k] = a[k*3+p]
      a[k*3+r] = s*akp + c*akr; a[r*3+k] = a[k*3+r]
    }
    // Update Q (columns = eigenvectors)
    for (let k = 0; k < 3; k++) {
      const qkp = q[k*3+p], qkr = q[k*3+r]
      q[k*3+p] = c*qkp - s*qkr
      q[k*3+r] = s*qkp + c*qkr
    }
  }
  // Column of Q for the minimum eigenvalue
  let mi = 0
  if (a[4] < a[0])   mi = 1
  if (a[8] < a[mi*3+mi]) mi = 2
  return [q[mi], q[3+mi], q[6+mi]]
}

// upgradeProjectiveTexturing — replaces vertex-colour splat material with a
// photo-projective ShaderMaterial that samples all available snapshot cameras.
// Called fire-and-forget; the scan is already visible in vertex-colour mode.
//
// Wegter Photo-Projection Equation
// ─────────────────────────────────
// For each 3D point, the ideal splat diameter to seamlessly fill photo coverage is:
//   splatDiam = depth_from_best_camera / camFx_pixels * WEGTER_OVERLAP
// where WEGTER_OVERLAP = 2.5 ensures each splat covers ~2.5 photo pixels at that depth.
// This is depth-adaptive: close-up points get smaller splats (preserving detail),
// distant points get larger splats (bridging the wider LiDAR return spacing).
// Points not covered by any camera keep their geometry-density-based spacing.
const MAX_PROJ_CAMS  = 24
const WEGTER_OVERLAP = 2.5  // splat covers ~2.5 px of best-camera photo at that depth

function getSafeProjectiveCamLimit(maxFragTextures) {
  // Most mobile GPUs expose 16 fragment texture units. Keep headroom so
  // camera samplers never exhaust the budget and invalidate the shader.
  const texUnits = Number.isFinite(maxFragTextures) ? Math.floor(maxFragTextures) : 0
  if (texUnits > 0) return Math.max(4, Math.min(MAX_PROJ_CAMS, texUnits - 2))
  // Conservative fallback when renderer capabilities are unavailable.
  return Math.min(MAX_PROJ_CAMS, 12)
}

// Load a snapshot image via fetch (with auth headers) + canvas downscale.
//
// Why fetch instead of TextureLoader directly:
//   The snapshot URL goes through /api/ (Flask-CORS), not /uploads/ (nginx,
//   no CORS headers).  The fetch sends auth headers and gets a proper response.
//
// Why canvas downscale to 1024px:
//   16 ARKit photos at native 4032×3024 = ~800 MB GPU texture memory on iOS —
//   well past the point where WebGL context loss becomes likely.  At 1024px max
//   each texture is ~4 MB → 16 × 4 MB = 64 MB total, well within iOS limits.
//   Projection quality is limited by point density, not texture resolution.
const SNAP_TEX_MAX_PX = 1024
async function loadSnapshotTex(url) {
  const jwt    = getJwt()
  const device = getDeviceToken()
  const resp   = await fetch(`${BASE}${url}`, {
    headers: {
      'X-Device-Token': device,
      ...(jwt ? { Authorization: `Bearer ${jwt}`, 'X-Auth-Token': jwt } : {}),
    },
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`)
  const blob   = await resp.blob()
  const objUrl = URL.createObjectURL(blob)

  // Load into an Image to get natural dimensions, then paint onto a
  // size-capped canvas so the GPU upload is always ≤ SNAP_TEX_MAX_PX².
  const img = await new Promise((res, rej) => {
    const el = new Image()
    el.onload  = () => res(el)
    el.onerror = rej
    el.src = objUrl
  })
  URL.revokeObjectURL(objUrl)

  const scale = Math.min(1, SNAP_TEX_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.round(img.naturalWidth  * scale)
  const h = Math.round(img.naturalHeight * scale)
  const canvas = document.createElement('canvas')
  canvas.width  = w
  canvas.height = h
  // WPA-5: deblocking — a 1px Gaussian blur at the source image level removes
  // the hard DCT-block boundaries that JPEG introduces at low quality settings
  // (60–80 KB captures at 25% resolution).  At 1px the blur is sub-perceptual
  // for real scene detail (which spans dozens of pixels) but smooths the abrupt
  // 8-pixel-period colour steps produced by the discrete cosine transform.
  const ctx2d = canvas.getContext('2d')
  ctx2d.filter = 'blur(1px)'
  ctx2d.drawImage(img, 0, 0, w, h)
  ctx2d.filter = 'none'

  // WPA-4 sampling quality — mirrors the photoMesh.js pyramid/bicubic spec
  // on the GPU path instead of the (dead) CPU path:
  //
  //   generateMipmaps + LinearMipMapLinearFilter
  //     Equivalent to the 3-level image pyramid + automatic level selection:
  //     WebGL builds a full mip chain (box-filtered half-res → quarter-res → …)
  //     so distant wall points sample a pre-averaged mip level instead of
  //     randomly picking a single photo pixel — eliminates the "dotty" look.
  //
  //   magFilter: LinearFilter
  //     Close-up surfaces (coverage < 1.5 px/vertex) get smooth bilinear
  //     upsampling — equivalent to the Catmull-Rom bicubic path in photoMesh.js.
  //     (True bicubic would need a custom shader; hardware bilinear is ~90% as
  //     good and free.)
  //
  //   anisotropy: 4
  //     Reduces shimmer on oblique wall views (the camera is rarely perfectly
  //     perpendicular) — standard complement to trilinear mipmapping.
  const tex = new THREE.CanvasTexture(canvas)
  tex.flipY          = false
  tex.generateMipmaps = true
  tex.minFilter      = THREE.LinearMipMapLinearFilter  // trilinear — pyramid
  tex.magFilter      = THREE.LinearFilter              // bilinear close-up
  tex.anisotropy     = 4                               // reduce oblique shimmer
  return tex
}

/**
 * Select k snapshots from allSnaps using greedy farthest-point sampling on the
 * camera forward-direction sphere.
 *
 * Why this beats temporal stride:
 *   A room scan is typically shot by slowly rotating 360°.  Temporal stride
 *   (every N-th frame) picks shots that happen to be N frames apart — but if
 *   the user pauses on an interesting corner, those N frames all cover the same
 *   wall.  Angular-diversity selection guarantees that the chosen k cameras
 *   span the full set of unique viewing directions, covering every wall segment.
 *
 * Algorithm: O(total × k) greedy farthest-point on the unit sphere.
 *   1. Seed with the snapshot whose forward vector is most "horizontal" (best
 *      wall coverage candidate).
 *   2. Repeatedly pick the snapshot farthest (in angle) from all already-selected
 *      cameras — "farthest" = max(min angular distance to any selected camera).
 *   3. Repeat until k cameras are chosen.
 *
 * @param {Array} allSnaps   Full snapshot array from the server.
 * @param {number} k         Number of cameras to select.
 * @returns {Array}          Subset of allSnaps, sorted by original index.
 */
function selectBestSnapshots(allSnaps, k) {
  if (allSnaps.length <= k) return allSnaps

  // Camera forward vector = −column 3 of c2w (col-major: indices 8,9,10)
  // c2w is col-major 4×4: col0=[0..3], col1=[4..7], col2=[8..11], col3=[12..15]
  // Camera looks in −Z in camera space, so forward in world = −c2w_col2 = −(c2w[8],c2w[9],c2w[10])
  const fwds = allSnaps.map(s => {
    const x = -s.c2w[8], y = -s.c2w[9], z = -s.c2w[10]
    const len = Math.sqrt(x*x + y*y + z*z) || 1
    return [x/len, y/len, z/len]
  })

  // Seed: pick the snapshot whose forward vector is most horizontal (smallest |y|).
  // This biases toward wall-facing cameras as the starting point.
  let seedIdx = 0, seedMinAbsY = Infinity
  for (let i = 0; i < allSnaps.length; i++) {
    const absY = Math.abs(fwds[i][1])
    if (absY < seedMinAbsY) { seedMinAbsY = absY; seedIdx = i }
  }

  const selected = [seedIdx]
  // minAngDist[i] = minimum angular distance (radians) from point i to any selected camera
  const minAngDist = new Float32Array(allSnaps.length).fill(Math.PI)
  minAngDist[seedIdx] = 0

  // Init distances from seed
  for (let i = 0; i < allSnaps.length; i++) {
    if (i === seedIdx) continue
    const dot = fwds[seedIdx][0]*fwds[i][0] + fwds[seedIdx][1]*fwds[i][1] + fwds[seedIdx][2]*fwds[i][2]
    minAngDist[i] = Math.acos(Math.max(-1, Math.min(1, dot)))
  }

  const selectedSet = new Set([seedIdx])
  for (let iter = 1; iter < k; iter++) {
    // Pick the unselected snapshot with the LARGEST minimum angular distance from any selected
    let best = -1, bestD = -1
    for (let i = 0; i < allSnaps.length; i++) {
      if (selectedSet.has(i)) continue
      if (minAngDist[i] > bestD) { bestD = minAngDist[i]; best = i }
    }
    if (best < 0) break
    selected.push(best)
    selectedSet.add(best)
    // Update minAngDist for all remaining candidates
    for (let i = 0; i < allSnaps.length; i++) {
      if (selectedSet.has(i)) continue
      const dot = fwds[best][0]*fwds[i][0] + fwds[best][1]*fwds[i][1] + fwds[best][2]*fwds[i][2]
      const d = Math.acos(Math.max(-1, Math.min(1, dot)))
      if (d < minAngDist[i]) minAngDist[i] = d
    }
  }

  // Return in original temporal order (so the shader sees them in a sensible sequence)
  return selected.sort((a, b) => a - b).map(i => allSnaps[i])
}

async function upgradeProjectiveTexturing({ points, yOffset, roomId, diagRef, onDiagUpdate, onProgress, maxFragTextures }) {
  onProgress?.(5, 'Loading snapshots…')
  let data
  try {
    data = await getSnapshots(roomId)
  } catch (err) {
    console.warn('[projective] snapshot fetch failed:', err)
    if (diagRef) diagRef.current = { ...diagRef.current, projStatus: `Snapshot fetch failed: ${err.message}` }
    onDiagUpdate?.()
    onProgress?.(100, 'Snapshot fetch failed', false)
    return null
  }
  const allSnaps = data?.snapshots
  if (!allSnaps?.length) {
    console.warn('[projective] no snapshots for room', roomId)
    if (diagRef) diagRef.current = { ...diagRef.current, projStatus: 'No snapshots on server' }
    onDiagUpdate?.()
    onProgress?.(100, 'No snapshots found', false)
    return null
  }
  const projCamLimit = getSafeProjectiveCamLimit(maxFragTextures)
  onProgress?.(10, `Selecting best ${Math.min(allSnaps.length, projCamLimit)} of ${allSnaps.length} snapshots…`)

  let snaps = allSnaps
  if (snaps.length > projCamLimit) {
    console.warn(`[projective] capping snapshots to ${projCamLimit} (fragment texture units max=${maxFragTextures ?? 'unknown'})`)
    snaps = selectBestSnapshots(allSnaps, projCamLimit)
  }

  // Normalize intrinsics from legacy/padded wire layouts into canonical 9-float
  // column-major form expected by projection code:
  // [fx,0,0, 0,fy,0, cx,cy,1]
  snaps = snaps.map(s => {
    const kRaw = Array.isArray(s.K) ? s.K.map(v => Number(v)) : []
    let K = kRaw
    let kLayout = 'canonical9'

    // Common legacy layout from raw SIMD memory with per-column padding:
    // [fx,0,0,pad, 0,fy,0,pad, cx,cy,1,pad]
    if (kRaw.length >= 12 && !(kRaw[4] > 0) && (kRaw[5] > 0) && (kRaw[8] > 0)) {
      K = [kRaw[0], kRaw[1], kRaw[2], kRaw[4], kRaw[5], kRaw[6], kRaw[8], kRaw[9], kRaw[10]]
      kLayout = 'simd12-padded'
    }
    // Older shifted 9-float payloads dropped cy/1; recover a usable approximation.
    else if (kRaw.length >= 9 && !(kRaw[4] > 0) && (kRaw[5] > 0) && (kRaw[8] > 0)) {
      const cyGuess = s.fh > 0 ? s.fh * 0.5 : 0
      K = [kRaw[0], kRaw[1], kRaw[2], 0, kRaw[5], kRaw[6], kRaw[8], cyGuess, 1]
      kLayout = 'shifted9-recovered'
    }

    return { ...s, K, _kRawLen: kRaw.length, _kLayout: kLayout }
  })

  // ── Validate snapshot metadata (K, fw, fh, c2w must be populated) ────────
  // If any of these are missing the server returned defaults (K:[], fw:0, fh:0).
  // A camera with K[0]=0 produces score=NaN/0 → bestCamIdx=-1 for every point.
  const invalidSnaps = snaps.filter(s =>
    !Array.isArray(s.K) || s.K.length < 9 || !(s.K[0] > 0) ||
    !(s.fw > 0) || !(s.fh > 0) ||
    !Array.isArray(s.c2w) || s.c2w.length < 16
  )
  if (invalidSnaps.length > 0) {
    console.warn(
      `[projective] ${invalidSnaps.length}/${snaps.length} snaps have invalid K/fw/fh/c2w — ` +
      `first invalid: K=${JSON.stringify(invalidSnaps[0].K)}, fw=${invalidSnaps[0].fw}, ` +
      `fh=${invalidSnaps[0].fh}, c2w.length=${invalidSnaps[0].c2w?.length}`
    )
    snaps = snaps.filter(s =>
      Array.isArray(s.K) && s.K.length >= 9 && s.K[0] > 0 &&
      s.fw > 0 && s.fh > 0 &&
      Array.isArray(s.c2w) && s.c2w.length === 16
    )
    if (snaps.length === 0) {
      console.warn('[projective] all snapshots invalid — cannot apply photo projection')
      if (diagRef) diagRef.current = { ...diagRef.current, projStatus: 'Snapshots missing camera data (K/fw/fh/c2w). Check iOS upload.' }
      onDiagUpdate?.()
      onProgress?.(100, 'Snapshot metadata invalid', false)
      return null
    }
  }

  // Per-snapshot intrinsics summary — helps confirm K is populated after iOS SIMD-padding fix.
  console.info('[projective] Snapshot intrinsics:',
    snaps.map((s, i) =>
      `[${i}] K=[${s.K?.slice(0,9).map(v=>v?.toFixed(2)).join(',')}] fw=${s.fw} fh=${s.fh} ` +
      `rawKLen=${s._kRawLen ?? 0} layout=${s._kLayout || 'unknown'} ` +
      `pos=(${s.c2w?.slice(12,14).map(v=>v?.toFixed(2)).join(',')})`
    ).join(' | ')
  )

  // Load textures via fetch+blob so we get proper auth and error visibility.
  // A failed texture gets a 1×1 black placeholder — one bad photo won't abort
  // the whole projection (remaining cameras still contribute).
  let texLoaded = 0
  const black1x1 = (() => {
    const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
    t.needsUpdate = true
    return t
  })()
  const textures = await Promise.all(snaps.map(async (s, si) => {
    try {
      const tex = await loadSnapshotTex(s.url)
      texLoaded++
      onProgress?.(10 + Math.round(55 * texLoaded / snaps.length), `Loading textures (${texLoaded}/${snaps.length})…`)
      return tex
    } catch (err) {
      console.error(`[projective] snapshot ${si} (${s.url}) failed: ${err.message}`)
      texLoaded++
      return black1x1
    }
  }))

  onProgress?.(68, 'Computing photo projection…')

  const nCams   = snaps.length
  const w2cMats = snaps.map(s => new THREE.Matrix4().fromArray(c2wToW2c(s.c2w)))
  const camKVec = snaps.map(({ K, fw, fh }) =>
    new THREE.Vector4(K[0] / fw, K[4] / fh, K[6] / fw, K[7] / fh))
  const camFxArr = new Float32Array(snaps.map(({ K }) => K[0]))

  // Diagnostic: confirm camera data is populated before expensive CPU passes
  if (snaps.length > 0) {
    const s0 = snaps[0]
    console.info(
      '[projective] Snap[0] K:', s0.K?.slice(0, 9),
      '| fw:', s0.fw, 'fh:', s0.fh,
      '| c2w pos:', s0.c2w?.slice(12, 15)?.map(v => v.toFixed(3)),
      '| camKVec[0]:', camKVec[0],
      '| camFxArr[0]:', camFxArr[0]
    )
  }

  const oldUni = points.material?.uniforms
  if (!oldUni) {
    onProgress?.(100, 'Scene changed — retry', false)
    return null  // mesh was disposed while textures loaded
  }

  // ── Orientation from image dimensions ───────────────────────────────────
  // ARKit intrinsics (K) are in the native sensor frame (landscape).
  // If the loaded JPEG's display height > width, the phone was held portrait
  // and we need a 90° CW UV rotation (ori=1) to align with the K matrix.
  const camOriArr = new Float32Array(textures.map(tex => {
    const iw = tex.image?.naturalWidth  ?? tex.image?.width  ?? 1
    const ih = tex.image?.naturalHeight ?? tex.image?.height ?? 1
    return ih > iw ? 1.0 : 0.0   // portrait JPEG → ori 1 (90° CW)
  }))

  // ── WPA-2 photo-projection spacing pre-pass ─────────────────────────────
  // Sample ~20 K points; for each find the best camera using the WPA-2 score
  // (angular resolution × surface-facing²) and compute the Wegter splat diameter.
  // ── WPA-4: extract camera Y axes for spin-alignment uniform ───────────────
  // Camera Y axis in world = column 1 of c2w = elements [4,5,6] (column-major).
  const camYArr = snaps.map(({ c2w }) =>
    new THREE.Vector3(c2w[4], c2w[5], c2w[6]).normalize())

  const posAttr    = points.geometry.attributes.position
  const nPts       = posAttr.count
  const sampleStep = Math.max(1, Math.floor(nPts / 20000))
  const w2cElems   = w2cMats.map(m => m.elements)
  const photoSpacings = new Float32Array(nPts)

  // Approximate room geometry (for normal orientation fallback and floor/ceil).
  const floorY  = oldUni.uFloorY?.value  ?? -0.1
  const ceilY   = oldUni.uCeilY?.value   ?? 3.0
  const roomCX  = oldUni.uRoomCX?.value  ?? 0
  const roomCZ  = oldUni.uRoomCZ?.value  ?? 0

  // ── WPA-4: Per-point surface normal estimation via local PCA ────────────
  // Build a 15 cm voxel grid, accumulate position sums and cross-products per
  // cell, then for each point aggregate its 3×3×3 neighbourhood into a 3×3
  // covariance matrix and Jacobi-solve for the minimum eigenvector (= normal).
  //
  // Key integer: (bx+2048)*4096*4096 + (by+2048)*4096 + (bz+2048)
  //   Fits in a JS safe integer; avoids string concat overhead on 10M lookups.
  onProgress?.(70, 'Estimating surface normals…')
  const NORM_CELL = 0.15
  const normVox   = new Map()
  for (let i = 0; i < nPts; i++) {
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i)
    const bx = Math.round(x / NORM_CELL)
    const by = Math.round(y / NORM_CELL)
    const bz = Math.round(z / NORM_CELL)
    const key = (bx + 2048) * 16777216 + (by + 2048) * 4096 + (bz + 2048)
    let v = normVox.get(key)
    if (!v) { v = new Float64Array(10); normVox.set(key, v) } // [sx,sy,sz,sxx,sxy,sxz,syy,syz,szz,n]
    v[0]+=x; v[1]+=y; v[2]+=z
    v[3]+=x*x; v[4]+=x*y; v[5]+=x*z; v[6]+=y*y; v[7]+=y*z; v[8]+=z*z; v[9]++
  }

  // Per-voxel PCA normals — compute once per unique voxel, then propagate to
  // all points with a single O(1) lookup each.
  //
  // The previous approach ran 27-neighbour aggregation for every one of the N
  // points (O(N × 27) map lookups).  For N=8M that is ~216M Map.get() calls,
  // which blocks the JS thread for 20–60 s and looks like a hang.
  //
  // Fix: the 27-neighbour aggregation runs only for each unique voxel (V << N,
  // typically 50K–200K for a room-sized scan at 15 cm resolution), then every
  // point simply looks up its own voxel's pre-computed normal — O(N × 1).
  // Total map lookups: V×27 + N×1 ≈ 5M + 8M = 13M instead of 216M.
  const roomMidY = (floorY + ceilY) * 0.5

  // Pass: build per-voxel normals from 27-neighbour PCA.
  const voxNormals = new Map()  // key → Float32Array([nx, ny, nz])
  for (const [key, v] of normVox) {
    // Decode voxel grid coordinates from the packed key.
    const bz = (key % 4096) - 2048
    const by = (Math.floor(key / 4096) % 4096) - 2048
    const bx = (Math.floor(key / 16777216) % 4096) - 2048
    let sx=0,sy=0,sz=0,sxx=0,sxy=0,sxz=0,syy=0,syz=0,szz=0,n=0
    for (let dx=-1; dx<=1; dx++) for (let dy=-1; dy<=1; dy++) for (let dz=-1; dz<=1; dz++) {
      const k2 = (bx+dx+2048)*16777216 + (by+dy+2048)*4096 + (bz+dz+2048)
      const v2 = normVox.get(k2); if (!v2) continue
      sx+=v2[0]; sy+=v2[1]; sz+=v2[2]; sxx+=v2[3]; sxy+=v2[4]; sxz+=v2[5]; syy+=v2[6]; syz+=v2[7]; szz+=v2[8]; n+=v2[9]
    }
    // Voxel centre (used for outward-orientation test — accurate to ±7.5 cm).
    const vx = bx * NORM_CELL, vy = by * NORM_CELL, vz = bz * NORM_CELL
    let nx, ny, nz
    if (n < 8) {
      const fdx=vx-roomCX, fdz=vz-roomCZ, flen=Math.max(Math.sqrt(fdx*fdx+fdz*fdz),0.001)
      nx=fdx/flen; ny=0; nz=fdz/flen
    } else {
      const mx=sx/n, my=sy/n, mz=sz/n
      const c00=sxx/n-mx*mx, c01=sxy/n-mx*my, c02=sxz/n-mx*mz
      const c11=syy/n-my*my, c12=syz/n-my*mz, c22=szz/n-mz*mz
      ;[nx, ny, nz] = minEigenvec3(c00, c01, c02, c11, c12, c22)
      const flip = (nx*(vx-roomCX) + ny*(vy-roomMidY) + nz*(vz-roomCZ)) < 0 ? -1 : 1
      nx *= flip; ny *= flip; nz *= flip
    }
    voxNormals.set(key, new Float32Array([nx, ny, nz]))
  }
  normVox.clear()

  // Assign normals to all points: one lookup each, no neighbour search needed.
  const normals = new Float32Array(nPts * 3)
  for (let i = 0; i < nPts; i++) {
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i)
    const bx = Math.round(x / NORM_CELL)
    const by = Math.round(y / NORM_CELL)
    const bz = Math.round(z / NORM_CELL)
    const key = (bx + 2048) * 16777216 + (by + 2048) * 4096 + (bz + 2048)
    const n3  = voxNormals.get(key)
    if (n3) {
      normals[i*3] = n3[0]; normals[i*3+1] = n3[1]; normals[i*3+2] = n3[2]
    } else {
      // Shouldn't normally occur — every point should map to a voxel we built.
      const dx=x-roomCX, dz=z-roomCZ, len=Math.max(Math.sqrt(dx*dx+dz*dz),0.001)
      normals[i*3] = dx/len; normals[i*3+1] = 0; normals[i*3+2] = dz/len
    }
  }
  voxNormals.clear()

  // covered/sampled: only count non-horizontal surfaces (walls, furniture).
  // Floor and ceiling points have |ny| > 0.7 (normal mostly vertical) — a
  // horizontal scan can never project onto them face-on, so including them in
  // the denominator deflates the coverage % well below what is visually observed
  // on the walls. The reported "Photo coverage" stat now reflects wall/surface
  // coverage rather than total-point-cloud coverage.
  let covered = 0, sampled = 0
  let usedCamMask = 0

  // WPA-5 extended diagnostics counters
  let occludeRej = 0, occludeTotal = 0  // occlusion culling: pairs that reached depth-test vs rejected
  let facingSum  = 0, facingCount  = 0  // average facing of winning camera (1.0 = perfectly face-on)
  let specklePts = 0                     // wall pts with no valid camera → true uncoloured speckle
  let frustumFail = 0, uvFail = 0, facingFail = 0  // per-phase rejection counters

  // Per-sampled-point top-3 camera assignment (packed for GPU vertex attribute).
  // Encoding: cam0 + cam1×32 + cam2×1024 + count×32768.
  const camAssignSampled = new Float32Array(Math.ceil(nPts / sampleStep) + 1)
  // WPA-5: voxelKey → packed assignment for spatial propagation.
  // Replaces the WPA-4 buffer-index propagation which assumed adjacent buffer
  // indices are spatially adjacent — they are NOT (LiDAR buffers are ordered by
  // scan time, not XYZ position). Voxel lookup uses the same 15cm grid as the
  // PCA normal pass and gives each point the assignment of its nearest sample.
  const camAssignVox = new Map()

  // ── WPA-4: Per-camera depth maps for occlusion culling ────────────────────
  // Build a 128×128 depth map per camera using the sampled points.
  // Purpose: reject projections where a closer point exists at the same UV
  // (e.g., furniture blocking the wall behind it).  Without this, the wall
  // gets colored with furniture pixels → "bleed-through" artifacts.
  //
  // Cost: 20 K sampled points × 24 cameras × ~10 ns each ≈ 5 ms.
  onProgress?.(77, 'Building occlusion depth maps…')
  const DMAP = 128
  const depthMaps = Array.from({ length: nCams }, () =>
    new Float32Array(DMAP * DMAP).fill(1e9))
  for (let i = 0; i < nPts; i += sampleStep) {
    const xd = posAttr.getX(i), yd = posAttr.getY(i), zd = posAttr.getZ(i)
    for (let ci = 0; ci < nCams; ci++) {
      const e = w2cElems[ci]
      const cpz_d = e[2]*xd + e[6]*yd + e[10]*zd + e[14]
      if (cpz_d >= -0.05) continue
      const depth_d = -cpz_d
      const cpx_d = e[0]*xd + e[4]*yd + e[8]*zd + e[12]
      const cpy_d = e[1]*xd + e[5]*yd + e[9]*zd + e[13]
      const kd = camKVec[ci]
      const u0d = kd.x * cpx_d / depth_d + kd.z
      const v0d = kd.y * (-cpy_d) / depth_d + kd.w
      const [ud, vd] = applyUvOrientation(u0d, v0d, camOriArr[ci] | 0)
      if (ud < 0 || ud > 1 || vd < 0 || vd > 1) continue
      const cu = Math.min(DMAP - 1, Math.floor(ud * DMAP))
      const cv = Math.min(DMAP - 1, Math.floor(vd * DMAP))
      const cell = cv * DMAP + cu
      if (depth_d < depthMaps[ci][cell]) depthMaps[ci][cell] = depth_d
    }
  }

  onProgress?.(78, 'Scoring camera coverage…')
  for (let i = 0; i < nPts; i += sampleStep) {
    const xr = posAttr.getX(i), yr = posAttr.getY(i), zr = posAttr.getZ(i)

    // WPA-4: use PCA-estimated per-point normal
    const nx = normals[i*3], ny = normals[i*3+1], nz = normals[i*3+2]

    let bestScore = 0, bestDepth = 0, bestCamIdx = -1, bestFacing = 0
    // top3: small sorted list of {ci, score} for camera assignment attribute
    const top3 = []

    for (let ci = 0; ci < nCams; ci++) {
      const e = w2cElems[ci]
      const cpx = e[0]*xr + e[4]*yr + e[8]*zr + e[12]
      const cpy = e[1]*xr + e[5]*yr + e[9]*zr + e[13]
      const cpz = e[2]*xr + e[6]*yr + e[10]*zr + e[14]
      if (cpz >= -0.05) { frustumFail++; continue }
      const depth = -cpz
      const k = camKVec[ci]
      const u0 = k.x * cpx / depth + k.z
      const v0 = k.y * (-cpy) / depth + k.w
      const [u, v] = applyUvOrientation(u0, v0, camOriArr[ci] | 0)
      const fxn = k.x
      // Denominator 0.11: fxn=0.404 (640×480 UW) → uwT=1.055 → clamped to 1.0.
      // Was 0.18 → uwT=0.644 for UW — only partial cv8/mg/minCosView activation.
      const uwT = Math.max(0, Math.min(1, (0.52 - fxn) / 0.11))
      const mg = 0.08 + (0.20 - 0.08) * uwT
      if (u < mg || u > 1 - mg || v < mg || v > 1 - mg) { uvFail++; continue }

      // ── Occlusion culling: reject if a closer point exists in this camera ──
      // Uses the pre-built 128×128 depth map.  15 cm tolerance handles LiDAR
      // noise without rejecting valid wall points close to foreground objects.
      const ocu = Math.min(DMAP - 1, Math.floor(u * DMAP))
      const ocv = Math.min(DMAP - 1, Math.floor(v * DMAP))
      const minD = depthMaps[ci][ocv * DMAP + ocu]
      occludeTotal++
      // WPA-5: relative tolerance (15%) — tighter near-camera, looser far-camera.
      // Replaces WPA-4 absolute +0.15m which was too permissive at close range
      // (foreground objects only 1.3m from camera leaked through at < 15cm).
      if (depth > minD * 1.15) { occludeRej++; continue }   // occluded

      // WPA-5 score: angRes × facing⁶ × cosView⁴ × spinFactor² (mirrors GLSL)
      // cosView⁴ restored from WPA-4's cosView² — see GLSL comment for rationale.
      const angRes   = camFxArr[ci] / (depth * depth + 0.001)
      const normCamZ = e[2]*nx + e[6]*ny + e[10]*nz
      const facing   = Math.max(0, -normCamZ)
      if (facing < 0.35) { facingFail++; continue }  // hard cutoff (mirrors GLSL MIN_FACING)
      const f6       = Math.pow(facing, 6)
      const cpLen    = Math.sqrt(cpx*cpx + cpy*cpy + cpz*cpz)
      const cosView  = cpLen > 0.001 ? depth / cpLen : 0
      const minCosView = 0.35 + (0.62 - 0.35) * uwT
      if (cosView < minCosView) continue
      const cv2      = cosView * cosView
      const cv4      = cv2 * cv2   // cosView⁴
      const cv8      = cv4 * cv4
      const cv       = cv4 + (cv8 - cv4) * uwT
      // Spin factor: camera Y dot surface-up (WPA-4 in-plane alignment)
      const camYx = camYArr[ci].x, camYy = camYArr[ci].y, camYz = camYArr[ci].z
      // surfaceUp = worldUp − dot(worldUp,normal)*normal; worldUp=(0,1,0)
      const dotUp = ny  // dot((0,1,0), normal)
      const sux = -dotUp*nx, suy = 1-dotUp*ny, suz = -dotUp*nz
      const suLen = Math.sqrt(sux*sux + suy*suy + suz*suz)
      const spinRaw = suLen > 0.01 ? Math.abs((camYx*sux + camYy*suy + camYz*suz)/suLen) : 1
      const sf2 = Math.max(0.25, spinRaw) ** 2
      const score = angRes * f6 * cv * sf2
      if (score > bestScore) { bestScore = score; bestDepth = depth; bestCamIdx = ci; bestFacing = facing }

      // Track top-3 cameras for GPU vertex attribute
      top3.push({ ci, score })
      if (top3.length > 3) {
        top3.sort((a, b) => b.score - a.score)
        top3.length = 3
      }
    }

    if (bestCamIdx >= 0) {
      photoSpacings[i] = Math.max(0.001, Math.min(0.08,
        bestDepth / (camFxArr[bestCamIdx] + 1e-4) * WEGTER_OVERLAP
      ))
      if (bestCamIdx < 30) usedCamMask |= (1 << bestCamIdx)
      facingSum += bestFacing
      facingCount++
    }

    // Pack top-3 camera assignment for GPU vertex attribute
    // Encoding: cam0 + cam1×32 + cam2×1024 + count×32768
    {
      const cnt    = top3.length
      const c0     = cnt > 0 ? top3[0].ci : 0
      const c1     = cnt > 1 ? top3[1].ci : 0
      const c2     = cnt > 2 ? top3[2].ci : 0
      const packed = c0 + c1*32 + c2*1024 + cnt*32768
      camAssignSampled[Math.floor(i / sampleStep)] = packed
      // WPA-5: also store in spatial voxel map so non-sampled points can look up
      // their nearest sampled neighbour by XYZ rather than by buffer index.
      const bxv = Math.round(xr / NORM_CELL)
      const byv = Math.round(yr / NORM_CELL)
      const bzv = Math.round(zr / NORM_CELL)
      camAssignVox.set((bxv + 2048) * 16777216 + (byv + 2048) * 4096 + (bzv + 2048), packed)
    }
    // Only include non-horizontal surfaces (walls, furniture) in coverage %.
    // Floor/ceiling points (|ny| > 0.7) are excluded — their normals face up/down
    // and cameras can never project onto them face-on from a standing room scan.
    const nx_s = normals[i*3], ny_s = normals[i*3+1]
    const isVertical = Math.abs(ny_s) < 0.70
    if (isVertical) {
      sampled++
      if (bestCamIdx >= 0) covered++
      else specklePts++   // wall point with zero valid cameras → true uncoloured speckle
    }
  }

  // Diagnostic: print per-phase rejection summary to help trace 0/N camera failures
  console.info(
    `[projective] Scoring pass — ` +
    `nPts=${nPts} nCams=${nCams} sampleStep=${sampleStep} | ` +
    `frustumFail=${frustumFail} uvFail=${uvFail} facingFail=${facingFail} ` +
    `occludeTotal=${occludeTotal} occludeRej=${occludeRej} | ` +
    `covered=${covered} sampled=${sampled} speckle=${specklePts}`
  )
  if (nPts > 0 && nCams > 0) {
    const x0 = posAttr.getX(0), y0 = posAttr.getY(0), z0 = posAttr.getZ(0)
    const e0 = w2cElems[0]
    const cpz0 = e0[2]*x0 + e0[6]*y0 + e0[10]*z0 + e0[14]
    const cpx0 = e0[0]*x0 + e0[4]*y0 + e0[8]*z0 + e0[12]
    const cpy0 = e0[1]*x0 + e0[5]*y0 + e0[9]*z0 + e0[13]
    console.info(
      `[projective] Point[0] world=(${x0.toFixed(3)},${y0.toFixed(3)},${z0.toFixed(3)})` +
      ` → cam[0] space=(${cpx0.toFixed(3)},${cpy0.toFixed(3)},${cpz0.toFixed(3)})` +
      ` cam[0] pos w2c trans=(${e0[12].toFixed(3)},${e0[13].toFixed(3)},${e0[14].toFixed(3)})`
    )
  }

  // Fill un-sampled points by linear interpolation between bracketing samples
  for (let i = 0; i < nPts; i++) {
    if (photoSpacings[i] > 0) continue
    const prev = Math.floor(i / sampleStep) * sampleStep
    const next = Math.min(nPts - 1, prev + sampleStep)
    const a    = photoSpacings[prev], b = photoSpacings[next]
    if (a > 0 && b > 0) {
      const t = (i - prev) / Math.max(1, next - prev)
      photoSpacings[i] = a + (b - a) * t
    } else {
      photoSpacings[i] = a > 0 ? a : b > 0 ? b : 0.004  // 4 mm fallback
    }
  }

  // WPA-5: Voxel-based camera assignment propagation.
  //
  // WPA-4 used buffer-index interpolation: point at buffer index i got the
  // assignment of sampled point floor(i/sampleStep).  This is wrong because
  // LiDAR buffers are ordered by scan TIME not by spatial XYZ — buffer-adjacent
  // points can be on opposite walls.  This caused large spatial regions to
  // receive the wrong camera assignment, contributing heavily to the speckle.
  //
  // WPA-5 fix: for every point look up its own 15cm voxel in camAssignVox.
  // If populated (the typical case — dense LiDAR means most voxels are hit by
  // at least one of the 20K samples), use that assignment directly.
  // If empty (voxel has no sample), search the 26 immediate neighbours.
  // A 15cm search radius on a ~4mm point cloud essentially always finds a hit.
  const camAssignAll = new Float32Array(nPts)
  let voxHits = 0, voxNeighHits = 0, voxFails = 0  // WPA-5 propagation quality
  for (let i = 0; i < nPts; i++) {
    const xi = posAttr.getX(i), yi = posAttr.getY(i), zi = posAttr.getZ(i)
    const bx = Math.round(xi / NORM_CELL)
    const by = Math.round(yi / NORM_CELL)
    const bz = Math.round(zi / NORM_CELL)
    const key = (bx + 2048) * 16777216 + (by + 2048) * 4096 + (bz + 2048)
    let assign = camAssignVox.get(key)
    if (assign !== undefined) {
      voxHits++
    } else {
      // Neighbour search — scan 26 surrounding voxels in 3×3×3 cube.
      // The triple loop is unrolled by the JIT; early-exit via label.
      outer: for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (!dx && !dy && !dz) continue
            const k2 = (bx + dx + 2048) * 16777216 + (by + dy + 2048) * 4096 + (bz + dz + 2048)
            const a2 = camAssignVox.get(k2)
            if (a2 !== undefined) { assign = a2; break outer }
          }
        }
      }
      if (assign !== undefined) voxNeighHits++
      else voxFails++
    }
    camAssignAll[i] = assign ?? 0  // 0 = no assignment → GPU uses all cameras
  }
  camAssignVox.clear() // free ~20K entry map

  // ── Update geometry attributes (spacing + WPA-4 per-point normals) ──────
  const oldSpacingAttr = points.geometry.attributes.aLocalSpacing
  if (oldSpacingAttr && oldSpacingAttr.array.length === nPts) {
    oldSpacingAttr.array.set(photoSpacings)
    oldSpacingAttr.needsUpdate = true
  } else {
    points.geometry.setAttribute('aLocalSpacing',
      new THREE.BufferAttribute(photoSpacings.slice(), 1))
  }
  // Always replace aNormal since the PCA estimate is new each rebuild
  points.geometry.setAttribute('aNormal',
    new THREE.BufferAttribute(normals, 3))

  // WPA-4: Per-point camera assignment (top-3 packed indices)
  // Enables GPU fragment shader to skip 21/24 cameras per fragment → ~8× speedup.
  points.geometry.setAttribute('aCamAssign',
    new THREE.BufferAttribute(camAssignAll, 1))

  const coveragePct  = sampled > 0 ? Math.round(covered / sampled * 100) : 0
  const usedCamCount = nCams <= 30
    ? [...Array(nCams)].filter((_, i) => usedCamMask & (1 << i)).length
    : nCams  // if >30 cams, assume all used (bitmask overflows)
  const nSelected = snaps.length  // cameras actually loaded (≤ MAX_PROJ_CAMS)

  const medSpacingPx = photoSpacings.slice().sort()[Math.floor(nPts / 2)] ?? 0
  const medSpacingMm = Math.round(medSpacingPx * 1000)

  // WPA-5 derived diagnostics
  const specklePct    = sampled > 0 ? Math.round(specklePts / sampled * 100) : 0
  const occludePct    = occludeTotal > 0 ? Math.round(occludeRej / occludeTotal * 100) : 0
  const avgFacing     = facingCount > 0 ? (facingSum / facingCount).toFixed(3) : null
  const voxHitPct     = nPts > 0 ? Math.round(voxHits     / nPts * 100) : 0
  const voxNeighPct   = nPts > 0 ? Math.round(voxNeighHits / nPts * 100) : 0
  const voxFailPct    = nPts > 0 ? Math.round(voxFails     / nPts * 100) : 0

  // Per-camera sampler uniforms: uCamTex0, uCamTex1, …
  const camTexUniforms = {}
  textures.forEach((tex, i) => { camTexUniforms[`uCamTex${i}`] = { value: tex } })

  const projMat = new THREE.ShaderMaterial({
    vertexColors: true,
    depthWrite:   true,
    depthTest:    true,
    vertexShader:   SPLAT_VERT_PROJ,
    fragmentShader: makeProjFragShader(nCams),
    uniforms: {
      uViewH:    { value: oldUni.uViewH?.value  ?? 1 },
      uYOffset:  { value: yOffset },
      uFloorY:   { value: oldUni.uFloorY?.value ?? 0 },
      uCeilY:    { value: oldUni.uCeilY?.value  ?? 3 },
      uRoomCX:   { value: oldUni.uRoomCX?.value ?? 0 },
      uRoomCZ:   { value: oldUni.uRoomCZ?.value ?? 0 },
      uDiagMode: { value: 0 },
      uNCams:    { value: nCams },
      uW2C:      { value: w2cMats },
      uCamK:     { value: camKVec },
      uCamFx:    { value: camFxArr },
      uCamOri:   { value: camOriArr },
      uCamY:     { value: camYArr },   // WPA-4 spin alignment
      ...camTexUniforms,
    },
  })

  points.material.dispose()
  points.material = projMat

  onProgress?.(95, `Photo projection applied (${coveragePct}% covered)…`)
  console.info(
    `[projective] WPA-5.1 (BLEND_RATIO=0.70, uwT/0.11→1.0): ${nSelected}/${allSnaps.length} snaps, ` +
    `${usedCamCount} active, ${coveragePct}% wall coverage, ` +
    `speckle ${specklePct}%, occlusion ${occludePct}%, avgFacing ${avgFacing}, ` +
    `voxel ${voxHitPct}%direct/${voxNeighPct}%neigh/${voxFailPct}%miss, ` +
    `med splat ${medSpacingMm}mm`
  )

  if (diagRef) {
    diagRef.current = {
      ...diagRef.current,
      projective:      true,
      projCams:        nCams,
      projTotal:       allSnaps.length,   // total snapshots on server
      projSelected:    nSelected,         // cameras loaded into GPU (≤ device-safe sampler cap)
      projUsed:        usedCamCount,      // cameras that actually covered ≥ 1 point
      projCoverage:    coveragePct,
      wegterSpacingMm: medSpacingMm,
      projStatus:      null,
      // WPA-5 extended diagnostics
      projSpecklePct:  specklePct,   // wall pts with zero valid camera → true speckle
      projOccludePct:  occludePct,   // % of UV-valid (cam,pt) pairs rejected by occlusion depth map
      projAvgFacing:   avgFacing,    // avg dot(surfaceNormal, -camDir) of winning camera (1.0 = face-on)
      projVoxHitPct:   voxHitPct,   // % of pts with direct voxel assignment (no neighbour search)
      projVoxNeighPct: voxNeighPct, // % assigned via 26-neighbour search
      projVoxFailPct:  voxFailPct,  // % with no voxel hit in 3×3×3 cube → uses all cameras in GPU
      projSampleStep:  sampleStep,  // 1 sample per N pts — lower = denser coverage pre-pass
      colourMethod:    `Photo projection WPA-5.1 (${usedCamCount}/${nSelected} cams, ${coveragePct}% walls)`,
      projCamLimit,
    }
  }
  onDiagUpdate?.()
  onProgress?.(100, 'Photo projection complete', false)
  return { nCams, projTotal: allSnaps.length, projSelected: nSelected, coveragePct, projUsed: usedCamCount }
}

// ── Mesh shaders (used when point cloud is rendered as a triangle mesh) ───────
// The vertex shader just applies uYOffset (raw y → scene y) and passes
// the vertex colour through.  No lighting — LiDAR colour data is already
// captured under real-world illumination, so diffuse lighting would double-
// shade it.  Colour grading (saturation + gamma) matches the splat path.

const MESH_VERT = /* glsl */`
  uniform float uYOffset;
  varying vec3  vColor;
  void main() {
    vColor = color.rgb;
    gl_Position = projectionMatrix * modelViewMatrix *
      vec4(position.x, position.y + uYOffset, position.z, 1.0);
  }
`

const MESH_FRAG = /* glsl */`
  varying vec3 vColor;
  uniform int  uDiagMode; // 0=colour, 1=depth false-colour
  void main() {
    vec3 col;
    if (uDiagMode == 1) {
      float d = gl_FragCoord.z;
      col = mix(vec3(1.0, 0.3, 0.0), vec3(0.0, 0.4, 1.0), clamp(d * 2.0 - 0.5, 0.0, 1.0));
    } else {
      col = vColor;
      float luma = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(luma), col, 1.35);
      col = pow(clamp(col, 0.0, 1.0), vec3(0.88));
    }
    gl_FragColor = vec4(col, 1.0);
  }
`

// ── Screen-Space Depth Dilation (SSDD) ─────────────────────────────────────
// Post-processing pass that runs after the point cloud is rendered to an FBO.
// For every screen pixel whose depth = 1.0 (background / gap between dots) we
// search a (2R+1)² neighbourhood and fill it with the colour of the nearest
// occupied pixel (minimum depth).  This makes the point cloud appear perfectly
// solid with no visible holes — regardless of disc size or camera distance.
//
// Why min-depth (not nearest pixel)?
//   Taking the minimum depth finds the closest surface in the neighbourhood,
//   which is correct — we want foreground surfaces to fill gaps, not distant walls.
//
// Performance:  the early-return in the fragment shader means the expensive
//   9×9 search runs only on empty pixels (background + inter-point gaps).
//   For a dense room scan, typically < 20 % of pixels trigger the search.

const SSDD_VERT = /* glsl */`
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`

// WPA-5: SSDD fragment shader with bilateral denoise for occupied pixels.
//
// Two-path shader:
//   • Gap pixel (depth ≈ 1.0): unchanged 9×9 min-depth dilation fill.
//   • Occupied pixel: 5×5 bilateral filter — spatial × colour Gaussian.
//
// Why bilateral for occupied pixels?
//   JPEG-compressed snapshot photos (60–80 KB, 25 % native resolution) show
//   prominent 8-pixel DCT block boundaries once projected onto the point cloud.
//   A pure Gaussian blur would smear real surface edges; the bilateral filter
//   suppresses the shallow colour differences between adjacent DCT blocks
//   (Δcolor ≈ 0.01–0.04 in [0,1]) while leaving real material/object edges
//   (Δcolor > 0.12) untouched.
//
// Kernel parameters:
//   σ_s = 1.5 px  → 5×5 spatial footprint, corner weight ≈ 0.10
//   σ_c = 0.05    → half-weight at ΔE = 0.05; near-zero at ΔE = 0.15
//
// Performance: 25 samples × ~80 % occupied pixels ≈ 20 M samples/frame on a
//   1080p FBO.  Runs in ~1–2 ms on modern mobile GPU (well within 16ms budget).
const SSDD_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2      uRes;
  uniform vec3      uBg;

  // Bilateral parameters (σ² denominators = 2σ²)
  #define SIG_S2  4.5    // spatial:  2 × 1.5² = 4.5
  #define SIG_C2  0.005  // colour:   2 × 0.05² = 0.005

  void main() {
    vec2  uv = gl_FragCoord.xy / uRes;
    float d  = texture2D(tDepth, uv).r;

    // ── Gap pixel: 9×9 min-depth dilation (unchanged from WPA-4 SSDD) ───────
    if (d > 0.9999) {
      float bestD = 2.0;
      vec4  bestC = vec4(uBg, 1.0);
      for (int xi = -4; xi <= 4; xi++) {
        for (int yi = -4; yi <= 4; yi++) {
          vec2  suv = uv + vec2(float(xi), float(yi)) / uRes;
          float nd  = texture2D(tDepth, suv).r;
          if (nd < bestD) { bestD = nd; bestC = texture2D(tColor, suv); }
        }
      }
      gl_FragColor = (bestD < 0.9999) ? bestC : vec4(uBg, 1.0);
      return;
    }

    // ── Occupied pixel: 5×5 bilateral denoise ────────────────────────────────
    // Accumulate colour weighted by spatial Gaussian × colour-range Gaussian.
    // Skips gap neighbours (depth = 1) so the filter never bleeds background
    // colour into foreground splats at object silhouettes.
    vec3  centerCol = texture2D(tColor, uv).rgb;
    vec3  accCol    = vec3(0.0);
    float accW      = 0.0;

    for (int xi = -2; xi <= 2; xi++) {
      for (int yi = -2; yi <= 2; yi++) {
        vec2  suv = uv + vec2(float(xi), float(yi)) / uRes;
        float nd  = texture2D(tDepth, suv).r;
        if (nd > 0.9999) continue;            // skip gap neighbours
        vec3  nc      = texture2D(tColor, suv).rgb;
        float r2      = float(xi * xi + yi * yi);
        float wSp     = exp(-r2 / SIG_S2);
        vec3  cdiff   = nc - centerCol;
        float wCol    = exp(-dot(cdiff, cdiff) / SIG_C2);
        float w       = wSp * wCol;
        accCol += nc * w;
        accW   += w;
      }
    }

    gl_FragColor = vec4(accW > 0.0 ? accCol / accW : centerCol, 1.0);
  }
`

const FOV_PRESETS = [
  { label: 'Normal', fov: 55  },
  { label: 'Wide',   fov: 90  },
  { label: 'Fish',   fov: 120 },
  { label: 'Ultra',  fov: 140 },
]
const JOY_RADIUS = 36   // outer pad radius px
const JOY_THUMB  = 13   // thumb radius px
const JOY_SPEED    = 0.014  // halved from 0.028 — was too sensitive
const PAN_SPEED    = 0.04   // orbit.center translation per frame per unit joystick deflection
const DOLLY_SPEED  = 0.04   // radius change per frame (same units as PAN_SPEED)
const ENABLE_RECONSTRUCTION_OVERLAY = false

export default function SpaceBuilderCanvas({
  space, activeSurfaceId, onSelectSurface, onUpdateSurface, onSetConnection, onSurfaceTap, requestCropId,
  roomScan = null,
  onSurfaceFromView = null,
  onRoomScanLoadProgress = null,
}) {
  const mountRef = useRef(null)
  const threeRef  = useRef(null)
  const stateRef  = useRef({})
  const compTexCacheRef = useRef(new Map()) // Map<surfaceId, { key: string, dataUrl: string }>
  const joystickRef    = useRef({ active: false, nx: 0, ny: 0 })  // orbit  — read in RAF loop
  const panJoystickRef = useRef({ active: false, nx: 0, ny: 0 })  // pan    — read in RAF loop
  const fwdJoystickRef = useRef({ active: false, nx: 0, ny: 0 })  // dolly  — read in RAF loop
  const [snapHint,      setSnapHint]      = useState(null)
  const [cropSurfaceId, setCropSurfaceId] = useState(null)
  const [fov,           setFov]           = useState(55)
  const [zoomRadius,    setZoomRadius]    = useState(8)   // mirrors orbit.radius for slider UI
  const setZoomRef = useRef(setZoomRadius)                 // stable ref so onWheel closure can call it
  setZoomRef.current = setZoomRadius
  // When a room scan is loaded, orbit switches to FPS mode (camera rotates in
  // place at orbit.center) rather than classic third-person orbit around a pivot.
  const cameraFPSRef = useRef(false)
  const [joyPos,        setJoyPos]        = useState({ x: 0, y: 0 }) // orbit thumb CSS offset
  const [panJoyPos,     setPanJoyPos]     = useState({ x: 0, y: 0 }) // pan thumb CSS offset
  const [fwdJoyPos,     setFwdJoyPos]     = useState({ x: 0, y: 0 }) // fwd/back thumb CSS offset
  stateRef.current = { space, activeSurfaceId, onSelectSurface, onUpdateSurface, onSetConnection, onSurfaceTap }

  const prevCropReqRef = useRef(null)
  useEffect(() => {
    if (requestCropId && requestCropId !== prevCropReqRef.current) {
      prevCropReqRef.current = requestCropId
      // requestCropId is "surfaceId_timestamp" — strip the nonce suffix
      const realId = requestCropId.replace(/_\d+$/, '')
      setCropSurfaceId(realId)
    }
  }, [requestCropId])

  // ── Scene init (runs once) ───────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    mount.appendChild(renderer.domElement)

    // ── SSDD: offscreen FBO + fullscreen dilation quad ─────────────────────
    // The main scene is rendered into `ssdFBO` (color + depth), then the
    // dilation shader reads both textures and fills inter-point gaps.
    const makeSSDF = (w, h) => {
      const dt = new THREE.DepthTexture(w, h)
      dt.type = THREE.UnsignedIntType
      return new THREE.WebGLRenderTarget(w, h, {
        minFilter:   THREE.NearestFilter,
        magFilter:   THREE.NearestFilter,
        depthTexture: dt,
      })
    }
    const ssdFBO = makeSSDF(renderer.domElement.width, renderer.domElement.height)
    const ssdUniforms = {
      tColor: { value: ssdFBO.texture },
      tDepth: { value: ssdFBO.depthTexture },
      uRes:   { value: new THREE.Vector2(renderer.domElement.width, renderer.domElement.height) },
      uBg:    { value: new THREE.Color(0x080d14) },
    }
    const ssdQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms:       ssdUniforms,
        vertexShader:   SSDD_VERT,
        fragmentShader: SSDD_FRAG,
        depthTest:  false,
        depthWrite: false,
      }),
    )
    ssdQuad.frustumCulled = false
    const ssdScene = new THREE.Scene()
    const ssdCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    ssdScene.add(ssdQuad)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x080d14)
    scene.add(new THREE.GridHelper(40, 80, 0x0f1e30, 0x0f1e30))

    const camera = new THREE.PerspectiveCamera(55, mount.clientWidth / mount.clientHeight, 0.01, 200)
    const orbit = { phi: 1.1, theta: 0.4, radius: 8, center: new THREE.Vector3() }
    function applyOrbit() {
      orbit.phi = Math.max(0.05, Math.min(Math.PI - 0.05, orbit.phi))
      if (cameraFPSRef.current) {
        // ── FPS mode (room scan loaded) ───────────────────────────────────────
        // Camera sits at orbit.center and rotates in place — no external pivot.
        // Dragging looks around, pan joystick strafes, fwd joystick/scroll flies.
        camera.position.copy(orbit.center)
        camera.lookAt(
          orbit.center.x + Math.sin(orbit.phi) * Math.sin(orbit.theta),
          orbit.center.y + Math.cos(orbit.phi),
          orbit.center.z + Math.sin(orbit.phi) * Math.cos(orbit.theta),
        )
      } else {
        // ── Classic orbit (surface-only mode) ────────────────────────────────
        camera.position.set(
          orbit.center.x + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta),
          orbit.center.y + orbit.radius * Math.cos(orbit.phi),
          orbit.center.z + orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta),
        )
        camera.lookAt(orbit.center)
      }
    }
    applyOrbit()

    const texLoader = new THREE.TextureLoader()
    const meshMap = {}   // { [surfaceId]: { mesh, wM, hM } }

    // Returns the best available texture URL for a surface.
    // Priority: composite overlay (pieces) > inpaint layer > stitched seam > warped > raw photo.
    function getTexUrl(surface) {
      const cached = compTexCacheRef.current.get(surface.id)
      if (cached) return cached.dataUrl
      if (surface.inpaintDataUrl)  return surface.inpaintDataUrl
      if (surface.stitchedDataUrl) return surface.stitchedDataUrl
      if (surface.warpedDataUrl)   return surface.warpedDataUrl
      return stateRef.current.space.photos.find(p => p.id === surface.photoId)?.dataUrl || null
    }

    function buildMesh(surface) {
      const { wM, hM } = dims(surface)
      const geo = new THREE.PlaneGeometry(wM, hM)
      let mat
      const texUrl = getTexUrl(surface)
      if (texUrl) {
        const tex = texLoader.load(texUrl)
        tex.colorSpace = THREE.SRGBColorSpace
        mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide })
      } else {
        const hex = parseInt((SURFACE_COLORS[surface.colorIdx ?? 0] || '#4a9eff').replace('#', ''), 16)
        mat = new THREE.MeshBasicMaterial({ color: hex, side: THREE.DoubleSide, transparent: true, opacity: 0.55 })
      }
      const mesh = new THREE.Mesh(geo, mat)
      mesh.userData.surfaceId = surface.id
      // Position
      if (surface.pose3d) {
        mesh.position.fromArray(surface.pose3d.position)
      } else {
        const surfs = stateRef.current.space.surfaces
        const idx = surfs.findIndex(s => s.id === surface.id)
        mesh.position.set((idx - (surfs.length - 1) / 2) * (wM + 0.3), hM / 2, 0)
      }
      // Rotation — rotYDeg is authoritative for Y; pose3d.rotX for pitch
      mesh.rotation.set(
        surface.pose3d?.rotX ?? 0,
        (surface.rotYDeg ?? 0) * Math.PI / 180,
        0,
      )
      const edgesMesh = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0x3a5566 })
      )
      mesh.add(edgesMesh)
      scene.add(mesh)
      meshMap[surface.id] = { mesh, wM, hM, texUrl }
    }

    function syncMeshes(surfaces) {
      const ids = new Set(surfaces.map(s => s.id))
      for (const id of Object.keys(meshMap)) {
        if (!ids.has(id)) {
          scene.remove(meshMap[id].mesh)
          meshMap[id].mesh.traverse(o => {
            if (o.geometry) o.geometry.dispose()
            if (o.material?.map) o.material.map.dispose()
            if (o.material) o.material.dispose()
          })
          delete meshMap[id]
        }
      }
      for (const surface of surfaces) {
        if (!meshMap[surface.id]) {
          buildMesh(surface)
        } else {
          const entry = meshMap[surface.id]
          const { wM, hM } = dims(surface)
          // Texture: rebuild whenever the best-available URL changes
          const newTexUrl = getTexUrl(surface)
          if (newTexUrl !== entry.texUrl) {
            if (entry.mesh.material.map) entry.mesh.material.map.dispose()
            entry.mesh.material.dispose()
            if (newTexUrl) {
              const tex = texLoader.load(newTexUrl)
              tex.colorSpace = THREE.SRGBColorSpace
              entry.mesh.material = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide })
            } else {
              const hex = parseInt((SURFACE_COLORS[surface.colorIdx ?? 0] || '#4a9eff').replace('#', ''), 16)
              entry.mesh.material = new THREE.MeshBasicMaterial({ color: hex, side: THREE.DoubleSide, transparent: true, opacity: 0.55 })
            }
            entry.texUrl = newTexUrl
          }
          // Geometry: resize if dims changed
          if (Math.abs(entry.wM - wM) > 0.001 || Math.abs(entry.hM - hM) > 0.001) {
            entry.mesh.geometry.dispose()
            entry.mesh.geometry = new THREE.PlaneGeometry(wM, hM)
            const child = entry.mesh.children[0]
            if (child) { child.geometry.dispose(); child.geometry = new THREE.EdgesGeometry(entry.mesh.geometry) }
            entry.wM = wM; entry.hM = hM
          }
          // Rotation: rotYDeg is always authoritative for Y; pose3d.rotX for pitch
          entry.mesh.rotation.set(
            surface.pose3d?.rotX ?? 0,
            (surface.rotYDeg ?? 0) * Math.PI / 180,
            0,
          )
          // Position: from pose3d when available
          if (surface.pose3d) {
            entry.mesh.position.fromArray(surface.pose3d.position)
          }
        }
      }
    }

    function applySelection(activeId) {
      for (const [id, entry] of Object.entries(meshMap)) {
        const line = entry.mesh.children[0]
        if (line) line.material.color.set(id === activeId ? 0xffffff : 0x3a5566)
      }
    }

    const raycaster = new THREE.Raycaster()
    function raycast(clientX, clientY) {
      const rect = renderer.domElement.getBoundingClientRect()
      const mouse = new THREE.Vector2(
        ((clientX - rect.left) / rect.width)  * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      )
      raycaster.setFromCamera(mouse, camera)
      const hits = raycaster.intersectObjects(Object.values(meshMap).map(e => e.mesh))
      // Only accept hits on the visible (front) face of a surface.
      // Filters out back-face hits (DoubleSide planes behind other objects) and
      // nearly edge-on surfaces that the user isn't really aiming at.
      const validHits = hits.filter(hit => {
        if (!hit.face) return false
        const worldNormal = hit.face.normal.clone().applyQuaternion(hit.object.quaternion)
        // Accept front OR back face hits; only reject nearly edge-on surfaces.
        // |dot| > 0.15 means the ray is within ≈81° of either face normal.
        return Math.abs(worldNormal.dot(raycaster.ray.direction)) > 0.15
      })
      return validHits[0] ?? null
    }

    function computeSnap(movingId) {
      const me = meshMap[movingId]; if (!me) return null
      for (const fe of EDGE_LIST) {
        const fm = edgeWorldMid(me.mesh, fe, me.wM, me.hM)
        for (const [oid, oe] of Object.entries(meshMap)) {
          if (oid === movingId) continue
          for (const te of EDGE_LIST) {
            if (fm.distanceTo(edgeWorldMid(oe.mesh, te, oe.wM, oe.hM)) < SNAP_DIST)
              return { fromId: movingId, fromEdge: fe, toId: oid, toEdge: te }
          }
        }
      }
      return null
    }

    function applySnap(hint) {
      const { fromId, fromEdge, toId, toEdge } = hint
      const fe = meshMap[fromId]; const te = meshMap[toId]
      if (!fe || !te) return
      // Move "from" so its snapping edge midpoint coincides with "to"'s edge midpoint.
      // Rotation is intentionally NOT changed — the user sets the angle with the slider.
      const toMid   = edgeWorldMid(te.mesh, toEdge, te.wM, te.hM)
      const fromMid = edgeWorldMid(fe.mesh, fromEdge, fe.wM, fe.hM)
      fe.mesh.position.add(toMid.sub(fromMid))
      // Persist position only; keep existing rotYDeg intact
      stateRef.current.onUpdateSurface(fromId, {
        pose3d: { position: fe.mesh.position.toArray(), rotX: fe.mesh.rotation.x },
      })
      stateRef.current.onSetConnection(fromId, fromEdge, { surfaceId: toId, edge: toEdge, angleDeg: 90 })
    }

    // Drag state
    const drag = { active: false, hadMoved: false, type: null, surfaceId: null, startX: 0, startY: 0 }

    function onDown(e) {
      if (e.button !== 0) return
      drag.startX = e.clientX; drag.startY = e.clientY; drag.hadMoved = false
      const hit = raycast(e.clientX, e.clientY)
      if (hit) {
        // Walk up parent chain (LineSegments child may be hit instead of Mesh)
        let obj = hit.object
        while (obj && !obj.userData.surfaceId) obj = obj.parent
        const id = obj?.userData.surfaceId
        if (id) {
          // Always select the surface (works from front and back face)
          stateRef.current.onSelectSurface(id)
          // Only start a surface DRAG on front-face hits — back-face clicks
          // should orbit so the user doesn't accidentally drag invisible walls
          const worldNormal = hit.face.normal.clone().applyQuaternion(hit.object.quaternion)
          const isFront = worldNormal.dot(raycaster.ray.direction) < 0
          if (isFront) {
            drag.active = true; drag.type = 'surface'; drag.surfaceId = id
          } else {
            drag.active = true; drag.type = 'orbit'
          }
        } else {
          drag.active = true; drag.type = 'orbit'
        }
      } else {
        drag.active = true; drag.type = 'orbit'
      }
    }

    function onMove(e) {
      if (!drag.active) return
      const dx = e.clientX - drag.startX; const dy = e.clientY - drag.startY
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.hadMoved = true
      if (drag.type === 'orbit') {
        orbit.theta -= dx * 0.005; orbit.phi += dy * 0.005; applyOrbit()
      } else if (drag.type === 'surface') {
        const entry = meshMap[drag.surfaceId]; if (!entry) return
        // Camera-space drag: move surface in screen plane at surface depth
        const dist = Math.max(0.5, camera.position.distanceTo(entry.mesh.position))
        const rect = renderer.domElement.getBoundingClientRect()
        const scale = (2 * dist * Math.tan(camera.fov * Math.PI / 360)) / rect.height
        const camFwd   = new THREE.Vector3()
        camera.getWorldDirection(camFwd)
        const camRight = new THREE.Vector3().crossVectors(camFwd, camera.up).normalize()
        const camUp    = new THREE.Vector3().crossVectors(camRight, camFwd).normalize()
        if (e.shiftKey) {
          // Shift: move only vertically (world Y)
          entry.mesh.position.y -= dy * scale
        } else {
          entry.mesh.position.addScaledVector(camRight,  dx * scale)
          entry.mesh.position.addScaledVector(camUp,    -dy * scale)
        }
        setSnapHint(computeSnap(drag.surfaceId))
      }
      drag.startX = e.clientX; drag.startY = e.clientY
    }

    function onUp() {
      if (drag.type === 'surface' && drag.hadMoved) {
        const entry = meshMap[drag.surfaceId]
        if (entry) {
          const hint = computeSnap(drag.surfaceId)
          if (hint) applySnap(hint)
          else stateRef.current.onUpdateSurface(drag.surfaceId, {
            pose3d: { position: entry.mesh.position.toArray(), rotX: entry.mesh.rotation.x },
          })
        }
        setSnapHint(null)
      } else if (drag.type === 'surface' && !drag.hadMoved) {
        // Tap (not drag) on a surface — notify parent to open panel on mobile
        stateRef.current.onSurfaceTap?.()
      }
      drag.active = false; drag.hadMoved = false; drag.type = null; drag.surfaceId = null
    }

    function onWheel(e) {
      if (cameraFPSRef.current) {
        // FPS: scroll flies along look direction (positive deltaY = scroll down = step back)
        const sphi = Math.sin(orbit.phi), cphi = Math.cos(orbit.phi)
        const sth  = Math.sin(orbit.theta), cth = Math.cos(orbit.theta)
        const step = e.deltaY * 0.003
        orbit.center.x -= sphi * sth * step
        orbit.center.y -= cphi       * step
        orbit.center.z -= sphi * cth * step
        applyOrbit()
        setZoomRef.current(prev => scaleZoomRadius(prev, Math.exp(e.deltaY * 0.001), ZOOM_MIN, ZOOM_MAX))
      } else {
        // Classic: scroll changes orbit radius
        orbit.radius = scaleZoomRadius(orbit.radius, 1 + e.deltaY * 0.001, ZOOM_MIN, ZOOM_MAX)
        applyOrbit()
        setZoomRef.current(orbit.radius)
      }
    }

    function onDbl(e) {
      const hit = raycast(e.clientX, e.clientY)
      if (hit) setCropSurfaceId(hit.object.userData.surfaceId)
    }

    // ── Touch equivalents for drag (orbit + surface move) ───────────────
    function onTouchStart(e) {
      if (e.touches.length !== 1) return
      // Prevent scroll/zoom while dragging the canvas
      e.preventDefault()
      const t = e.touches[0]
      onDown({ button: 0, clientX: t.clientX, clientY: t.clientY })
    }
    function onTouchMove(e) {
      if (e.touches.length !== 1) return
      e.preventDefault()
      const t = e.touches[0]
      onMove({ clientX: t.clientX, clientY: t.clientY, shiftKey: false })
    }
    function onTouchEnd(e) {
      e.preventDefault()
      // If double-tap (two rapid taps), treat as dblclick
      const now = Date.now()
      if (now - (canvas._lastTap || 0) < 300) {
        const lx = canvas._lastTapX || 0, ly = canvas._lastTapY || 0
        const ct = e.changedTouches[0]
        if (Math.abs(ct.clientX - lx) < 20 && Math.abs(ct.clientY - ly) < 20) {
          onDbl({ clientX: ct.clientX, clientY: ct.clientY })
        }
        canvas._lastTap = 0
      } else {
        canvas._lastTap = now
        if (e.changedTouches[0]) {
          canvas._lastTapX = e.changedTouches[0].clientX
          canvas._lastTapY = e.changedTouches[0].clientY
        }
      }
      onUp()
    }

    const canvas = renderer.domElement
    canvas.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    canvas.addEventListener('wheel',     onWheel, { passive: true })
    canvas.addEventListener('dblclick',  onDbl)
    // Touch events — passive:false so we can preventDefault and stop scroll
    canvas.addEventListener('touchstart', onTouchStart, { passive: false })
    canvas.addEventListener('touchmove',  onTouchMove,  { passive: false })
    canvas.addEventListener('touchend',   onTouchEnd,   { passive: false })

    const ro = new ResizeObserver(() => {
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(mount.clientWidth, mount.clientHeight)
      const w = renderer.domElement.width, h = renderer.domElement.height
      ssdFBO.setSize(w, h)
      ssdUniforms.uRes.value.set(w, h)
      // Keep splat sizes physically correct after canvas resize / orientation change.
      const mat = pointCloudMeshRef.current?.material
      if (mat?.uniforms?.uViewH) mat.uniforms.uViewH.value = h
    })
    ro.observe(mount)

    let raf
    const animate = () => {
      raf = requestAnimationFrame(animate)
      let needsUpdate = false

      // Continuous orbit joystick — rotates around the center point
      // ny is inverted: joystick-up (ny < 0) should move camera higher → phi decreases
      const joy = joystickRef.current
      if (joy.active && (joy.nx !== 0 || joy.ny !== 0)) {
        needsUpdate = applyOrbitJoystickStep(orbit, joy.nx, joy.ny, JOY_SPEED) || needsUpdate
      }

      // Continuous pan / move joystick
      const pan = panJoystickRef.current
      if (pan.active && (pan.nx !== 0 || pan.ny !== 0)) {
        if (cameraFPSRef.current) {
          // FPS mode — Move joystick:
          //   X axis: strafe left/right  (camera right = (-cosθ, 0, sinθ) in world XZ)
          //   Y axis: strafe up/down     (world-Y; joystick up → orbit.center.y increases)
          // Forward/back is handled separately by the Fwd joystick.
          const sth = Math.sin(orbit.theta), cth = Math.cos(orbit.theta)
          orbit.center.x -= pan.nx * PAN_SPEED * cth   // strafe left/right
          orbit.center.z += pan.nx * PAN_SPEED * sth
          orbit.center.y -= pan.ny * PAN_SPEED          // strafe up/down (ny<0=up=y increases)
        } else {
          // Classic orbit — world-XZ pan + world-Y vertical
          orbit.center.x +=  pan.nx * PAN_SPEED * Math.cos(orbit.theta)
          orbit.center.z -= pan.nx * PAN_SPEED * Math.sin(orbit.theta)
          orbit.center.y -=  pan.ny * PAN_SPEED
        }
        needsUpdate = true
      }

      // Forward/Back (dolly) joystick.
      // FPS mode: fly along the camera look direction (ny < 0 = joystick up = forward).
      // Classic mode: change orbit.radius to dolly toward/away from the pivot.
      const fwd = fwdJoystickRef.current
      if (fwd.active && fwd.ny !== 0) {
        if (cameraFPSRef.current) {
          const sphi = Math.sin(orbit.phi), cphi = Math.cos(orbit.phi)
          const sth  = Math.sin(orbit.theta), cth = Math.cos(orbit.theta)
          // ny < 0 (joystick up) = forward → add look direction
          orbit.center.x += sphi * sth * (-fwd.ny) * DOLLY_SPEED
          orbit.center.y += cphi       * (-fwd.ny) * DOLLY_SPEED
          orbit.center.z += sphi * cth * (-fwd.ny) * DOLLY_SPEED
        } else {
          const newR = Math.max(0.1, Math.min(80, orbit.radius + fwd.ny * DOLLY_SPEED))
          orbit.radius = newR
          setZoomRef.current(newR)
        }
        needsUpdate = true
      }

      if (needsUpdate) applyOrbit()
      // Render directly to preserve geometric truth.
      renderer.setRenderTarget(null)
      renderer.render(scene, camera)
    }
    animate()

    threeRef.current = { syncMeshes, applySelection, meshMap, orbit, applyOrbit, camera, scene, renderer, ssdFBO }

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
      canvas.removeEventListener('wheel',     onWheel)
      canvas.removeEventListener('dblclick',  onDbl)
      canvas.removeEventListener('touchstart', onTouchStart)
      canvas.removeEventListener('touchmove',  onTouchMove)
      canvas.removeEventListener('touchend',   onTouchEnd)
      scene.traverse(o => {
        if (o.geometry) o.geometry.dispose()
        if (o.material?.map) o.material.map.dispose()
        if (o.material) o.material.dispose()
      })
      ssdFBO.dispose()
      renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
      threeRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { threeRef.current?.syncMeshes(space.surfaces) }, [space.surfaces])
  useEffect(() => { threeRef.current?.applySelection(activeSurfaceId) }, [activeSurfaceId])

  // ── Point cloud / room scan rendering ────────────────────────────────────
  const pointCloudMeshRef    = useRef(null)
  const planeMeshesRef       = useRef([])
  const reconstructionMeshesRef = useRef([])
  const yOffsetRef           = useRef(0)
  const rawBufferRef         = useRef(null)  // decoded PointCloudBuffer for LiDAR measurement
  const diagStatsRef         = useRef(null)  // { rawPts, renderedPts, fboW, fboH, dpr }
  const [diagVersion, setDiagVersion] = useState(0)  // bumped after projection stats update
  const rebuildFromBufferRef = useRef(false) // set by Rebuild button to skip re-download
  const [diagVisible,     setDiagVisible]  = useState(false)
  const [diagMode,        setDiagMode]     = useState(0)  // 0=color, 1=depth, 2=normals
  const [scanRenderMode,  setScanRenderMode] = useState('raw-points') // raw-points | poisson-glb
  const [meshRebuilding,  setMeshRebuilding] = useState(false)
  const [meshGeneration,  setMeshGeneration] = useState(0)  // bump to re-run buildCloud
  const [localLoad,       setLocalLoad] = useState({ active: false, pct: 0, phase: '' })
  const roomLoadProgressRef = useRef({ pct: -1, phase: '', ts: 0 })
  const reportRoomLoad = useCallback((pct, phase, active = true) => {
    const now = performance.now()
    const clamped = Math.max(0, Math.min(100, Math.round(pct)))
    const prev = roomLoadProgressRef.current
    const enoughDelta = Math.abs(clamped - prev.pct) >= 2
    const phaseChanged = phase !== prev.phase
    const enoughTime = now - prev.ts >= 120
    if (!phaseChanged && !enoughDelta && !enoughTime) return
    roomLoadProgressRef.current = { pct: clamped, phase, ts: now }
    setLocalLoad({ active, pct: clamped, phase })
    if (onRoomScanLoadProgress) {
      try { onRoomScanLoadProgress({ pct: clamped, phase, active }) } catch (err) { void err }
    }
  }, [onRoomScanLoadProgress])
  useEffect(() => {
    const t = threeRef.current
    if (!t) return

    // Deeply dispose a Three.js object (handles plain Mesh OR a GLB Group)
    function deepDispose(obj) {
      obj.traverse(o => {
        if (o.geometry) o.geometry.dispose()
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          mats.forEach(m => { if (m.map) m.map.dispose(); m.dispose() })
        }
      })
    }

    // Remove old point cloud + plane meshes
    if (pointCloudMeshRef.current) {
      t.scene.remove(pointCloudMeshRef.current)
      deepDispose(pointCloudMeshRef.current)
      pointCloudMeshRef.current = null
    }
    for (const m of planeMeshesRef.current) {
      t.scene.remove(m)
      deepDispose(m)
    }
    planeMeshesRef.current = []
    for (const m of reconstructionMeshesRef.current) {
      t.scene.remove(m)
      deepDispose(m)
    }
    reconstructionMeshesRef.current = []

    // Switch orbit style based on whether a scan is loaded
    cameraFPSRef.current = !!roomScan

    if (!roomScan) {
      reportRoomLoad(0, 'No scan loaded', false)
      return
    }

    let cancelled = false

    // Resolve the PointCloudBuffer from any of three storage formats:
    //   { _buffer }      — live scan, already decoded in memory (fastest)
    //   { url }          — loaded from server, fetch the binary blob
    //   { data }         — legacy base64 JSON format
    async function buildCloud() {
      // Always clear the previous scan mesh so rebuilds don't layer on top.
      const t = threeRef.current
      if (t && pointCloudMeshRef.current) {
        t.scene.remove(pointCloudMeshRef.current)
        pointCloudMeshRef.current.geometry?.dispose()
        pointCloudMeshRef.current.material?.dispose()
        pointCloudMeshRef.current = null
      }

      const pc = roomScan.pointCloud
      reportRoomLoad(3, 'Preparing room scan')

      const roomId = space?.id

      // ── Poisson GLB path (any room that exists on the server) ────────────
      // For server-backed rooms we always prefer the Poisson mesh.
      // If it's still building we poll and show live progress rather than
      // falling back to the slow JS pipeline.  JS triangulation is only used
      // for rooms that have no server ID (pure local/anonymous scans).
      if (roomId && scanRenderMode === 'poisson-glb') {
        const jwt    = getJwt()
        const device = getDeviceToken()
        const authHeaders = {
          'X-Device-Token': device,
          ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
        }

        // Helper: load a ready GLB URL into the scene
        async function loadGLB(url) {
          reportRoomLoad(20, 'Loading Poisson mesh…')
          const loader = new GLTFLoader()
          const gltf   = await new Promise((resolve, reject) => {
            loader.load(
              `${BASE}${url}`,
              resolve,
              xhr => { if (!cancelled) reportRoomLoad(20 + (70 * xhr.loaded / (xhr.total || 1)), 'Loading mesh…') },
              reject,
            )
          })
          if (cancelled) return

          const yOffset = (() => {
            let minY = Infinity
            gltf.scene.traverse(obj => {
              if (obj.isMesh) {
                const pos = obj.geometry.attributes.position
                for (let i = 0; i < pos.count; i++) {
                  const y = pos.getY(i); if (y < minY) minY = y
                }
              }
            })
            return isFinite(minY) ? -minY : 0
          })()
          yOffsetRef.current = yOffset

          gltf.scene.traverse(obj => {
            if (!obj.isMesh) return
            obj.material = new THREE.ShaderMaterial({
              vertexColors: true,
              side: THREE.DoubleSide,
              vertexShader: MESH_VERT,
              fragmentShader: MESH_FRAG,
              uniforms: {
                uYOffset:  { value: yOffset },
                uDiagMode: { value: 0 },
              },
            })
          })

          t.scene.add(gltf.scene)
          pointCloudMeshRef.current = gltf.scene
          rawBufferRef.current = null

          let totalVerts = 0, totalTris = 0
          gltf.scene.traverse(obj => {
            if (obj.isMesh) {
              totalVerts += obj.geometry.attributes.position.count
              totalTris  += (obj.geometry.index?.count ?? 0) / 3
            }
          })
          const fboW = t.renderer?.domElement?.width  ?? 0
          const fboH = t.renderer?.domElement?.height ?? 0
          diagStatsRef.current = {
            // meta.rawPts / poissonPts come from the build stats written by mesh_worker.
            // Fall back to mesh vertex count if the build pre-dates this feature.
            rawPts:       meta?.rawPts       ?? totalVerts,
            poissonPts:   meta?.poissonPts   ?? null,
            voxelMm:      meta?.voxelMm      ?? null,
            poissonDepth: meta?.poissonDepth ?? null,
            renderedPts:  totalVerts,
            triCount:     totalTris,
            fboW, fboH, dpr: Math.min(window.devicePixelRatio, 2),
            meshSource:   'poisson-glb',
            colourMethod: meta?.colorMethod ?? meta?.colourMethod ?? 'LiDAR sensor (IDW)',
            photoSnapshotsTotal: meta?.photoSnapshotsTotal ?? null,
            photoSnapshotsProjected: meta?.photoSnapshotsProjected ?? null,
            photoSnapshotsWinning: meta?.photoSnapshotsWinning ?? null,
            photoCoveragePct: meta?.photoCoveragePct ?? null,
          }

          try {
            const box = new THREE.Box3().setFromObject(gltf.scene)
            const center = new THREE.Vector3()
            box.getCenter(center)
            t.orbit.center.set(center.x, 1.6, center.z)
            t.orbit.phi   = Math.PI / 2
            t.orbit.theta = 0.4
            t.applyOrbit()
          } catch { /* ignore */ }

          reportRoomLoad(100, 'Scan ready', false)

          // Photo coloring is handled server-side during Poisson reconstruction
          // (IDW color transfer from the full point cloud in mesh_worker.py).
          // The GLB already has baked vertex colors — no client-side retexture needed.
        }

        // Helper: check mesh status once
        async function checkMeshStatus() {
          try {
            const resp = await fetch(`${BASE}/api/rooms/${roomId}/mesh`, {
              signal: AbortSignal.timeout(8000),
              headers: authHeaders,
            })
            if (!resp.ok) return null
            return await resp.json()
          } catch { return null }
        }

        // Initial check
        reportRoomLoad(5, 'Checking for pre-built mesh…')
        let meta = await checkMeshStatus()
        if (cancelled) return

        if (meta?.status === 'unavailable' || meta === null) {
          // Server doesn't know about this scan — fall through to JS pipeline
        } else if (meta?.status === 'ready' && meta.url) {
          await loadGLB(meta.url)
          return
        } else {
          // 'processing' or 'failed' — if failed, re-trigger and wait
          if (meta?.status === 'failed') {
            reportRoomLoad(8, 'Re-triggering mesh build…')
            await fetch(`${BASE}/api/rooms/${roomId}/mesh?rebuild=1`, { headers: authHeaders }).catch(() => {})
          }

          // Poll until ready, showing real server-reported stage + pct
          const POLL_MS      = 3000
          const MAX_ATTEMPTS = 240  // 12 min max — depth=11 builds can take 7-10 min
          for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            if (cancelled) return
            await new Promise(r => setTimeout(r, POLL_MS))
            if (cancelled) return
            meta = await checkMeshStatus()
            if (!meta) continue  // transient network hiccup — keep waiting
            if (meta.status === 'ready' && meta.url) {
              await loadGLB(meta.url)
              return
            }
            if (meta.status === 'failed') {
              reportRoomLoad(100, 'Mesh build failed — check server logs', false)
              return
            }
            // Map server's 0-100 pct into the 5-19% band of our loading bar
            // (20-90 is reserved for the GLB download itself)
            const serverPct = meta.pct ?? 0
            const barPct    = 5 + Math.round(serverPct * 0.14)  // 5%…19%
            const phase     = meta.phase || 'Building mesh on server…'
            reportRoomLoad(barPct, phase)
          }
          reportRoomLoad(100, 'Mesh timed out', false)
          return
        }
      }

      // ── JS spherical triangulation (local/anonymous scans only) ──────────
      let buf
      // Rebuild path: reuse in-memory buffer to avoid re-downloading.
      if (rebuildFromBufferRef.current && rawBufferRef.current) {
        rebuildFromBufferRef.current = false
        buf = rawBufferRef.current
        reportRoomLoad(42, 'Using cached scan data')
      }
      if (!buf) try {
        if (pc?._buffer) {
          reportRoomLoad(24, 'Using cached scan data')
          buf = pc._buffer
        } else if (pc?.url) {
          const pcUrl = pc.url.startsWith('/') ? `${BASE}${pc.url}` : pc.url
          let ab = await loadRecentScanBuffer({ roomId, url: pcUrl, pointCount: pc.pointCount })
          if (ab) {
            reportRoomLoad(38, 'Using last loaded scan cache')
          }

          if (!ab) {
            const authH  = { 'X-Device-Token': getDeviceToken() }
            const jwt    = getJwt?.()
            if (jwt) { authH['Authorization'] = `Bearer ${jwt}`; authH['X-Auth-Token'] = jwt }

            // Single streaming fetch (no blocking HEAD preflight).
            // The previous HEAD+Range path often stalled for 20-30s and then still
            // fell back to one request in production proxies.
            reportRoomLoad(4, 'Downloading scan…')
            const resp = await fetch(pcUrl, { headers: authH })
            if (!resp.ok) throw new Error(`Failed to load point cloud: ${resp.status}`)

            const sizeHint = parseInt(
              resp.headers.get('x-uncompressed-length') ||
              resp.headers.get('content-length') || '0', 10
            )

            if (resp.body?.getReader) {
              const reader = resp.body.getReader()
              if (sizeHint > 0) {
                const merged = new Uint8Array(sizeHint)
                let received = 0
                while (true) {
                  const { done, value } = await reader.read()
                  if (done) break
                  if (!value) continue
                  const writeLen = Math.min(value.byteLength, Math.max(0, sizeHint - received))
                  if (writeLen > 0) merged.set(value.subarray(0, writeLen), received)
                  received += value.byteLength
                  if (!cancelled) reportRoomLoad(4 + (34 * Math.min(1, received / sizeHint)), 'Downloading scan…')
                }
                ab = merged.buffer
              } else {
                const chunks = []
                let received = 0
                while (true) {
                  const { done, value } = await reader.read()
                  if (done) break
                  if (!value) continue
                  chunks.push(value)
                  received += value.byteLength
                  if (!cancelled) {
                    const pseudoPct = Math.min(0.98, Math.log10(1 + received / (1024 * 1024)) / 3)
                    reportRoomLoad(4 + (34 * pseudoPct), 'Downloading scan…')
                  }
                }
                const merged = new Uint8Array(received)
                let off = 0
                for (const c of chunks) {
                  merged.set(c, off)
                  off += c.byteLength
                }
                ab = merged.buffer
              }
            } else {
              ab = await resp.arrayBuffer()
            }
            await saveRecentScanBuffer({ roomId, url: pcUrl, pointCount: pc.pointCount, buffer: ab })
          }

          const arr = new Float32Array(ab)
          const inferredCount = Math.floor(arr.length / 6)
          const safePointCount = Number.isFinite(pc.pointCount) && pc.pointCount > 0
            ? pc.pointCount
            : inferredCount
          buf = PointCloudBuffer.fromFloat32Array(arr, safePointCount)
          reportRoomLoad(42, 'Decoding point cloud')
        } else if (pc?.data) {
          reportRoomLoad(22, 'Decoding legacy scan payload')
          buf = PointCloudBuffer.fromJSON(pc)
        } else {
          reportRoomLoad(100, 'No point cloud payload', false)
          return
        }
      } catch (err) {
        console.warn('[SpaceBuilderCanvas] Could not load point cloud:', err)
        reportRoomLoad(100, 'Scan load failed', false)
        return
      }
      if (cancelled) return

      // ── Raw-point render path (no meshing) ───────────────────────────────
      // This preserves capture geometry and avoids topological hallucinations
      // from Poisson or spherical triangulation.
      if (scanRenderMode === 'raw-points') {
        try {
          reportRoomLoad(44, 'Analysing point density')
          const rawData = buf._data
          const n = buf.pointCount

          // Render up to 8 M points at stride=1; stride up only for truly huge scans.
          const stride = Math.max(1, Math.floor(n / 8_000_000))
          const est    = Math.max(1, Math.ceil(n / stride))
          const positions = new Float32Array(est * 3)
          const colors    = new Float32Array(est * 3)
          const spacings  = new Float32Array(est)  // per-point adaptive splat size

          // ── Pass 1: bounds + density estimation via 5 cm voxel counts ─────
          // Local density at each point tells us how tightly spaced its
          // neighbours are.  More returns per voxel → smaller splat needed.
          const DENS_CELL = 0.05          // 5 cm cell for density estimation
          const DENS_INV  = 1 / DENS_CELL
          const hashP = (ix, iy, iz) => (ix * 73856093 + iy * 19349663 + iz * 83492791) | 0
          const voxelCounts = new Map()

          let minY = Infinity, maxY = -Infinity
          let minX = Infinity, maxX = -Infinity
          let minZ = Infinity, maxZ = -Infinity

          for (let i = 0, b = 0; i < n; i++, b += 6) {
            const x = rawData[b], y = rawData[b+1], z = rawData[b+2]
            if (y < minY) minY = y;  if (y > maxY) maxY = y
            if (x < minX) minX = x;  if (x > maxX) maxX = x
            if (z < minZ) minZ = z;  if (z > maxZ) maxZ = z
            const key = hashP(Math.floor(x * DENS_INV), Math.floor(y * DENS_INV), Math.floor(z * DENS_INV))
            voxelCounts.set(key, (voxelCounts.get(key) || 0) + 1)
            if ((i & 0x3ffff) === 0 && i > 0 && !cancelled) {
              reportRoomLoad(44 + (12 * i / n), 'Analysing point density')
            }
          }
          if (cancelled) return
          await new Promise(r => setTimeout(r, 0))  // yield → paint progress bar

          // ── Pass 2: sample + per-point spacing from density ───────────────
          // spacing = DENS_CELL / √count:
          //   1 return/voxel → 5 cm  |  4 → 2.5 cm  |  25 → 1 cm  |  100 → 0.5 cm
          // Dense walls get near-invisible sub-pixel dots; sparse noise/edges
          // get slightly larger discs to bridge the gaps — no more bowling balls.
          let vi = 0
          for (let i = 0, b = 0; i < n; i++, b += 6) {
            if (i % stride !== 0) continue
            const x = rawData[b], y = rawData[b+1], z = rawData[b+2]
            positions[vi*3] = x;  positions[vi*3+1] = y;  positions[vi*3+2] = z
            colors[vi*3]   = rawData[b+3]
            colors[vi*3+1] = rawData[b+4]
            colors[vi*3+2] = rawData[b+5]
            const key   = hashP(Math.floor(x * DENS_INV), Math.floor(y * DENS_INV), Math.floor(z * DENS_INV))
            const count = voxelCounts.get(key) || 1
            spacings[vi] = Math.max(0.003, Math.min(0.08, DENS_CELL / Math.sqrt(count)))
            vi++
            if ((i & 0x3ffff) === 0 && i > 0 && !cancelled) {
              reportRoomLoad(56 + (32 * i / n), 'Sampling raw points')
            }
          }

          if (cancelled) return

          const yOffset = isFinite(minY) ? -minY : 0
          yOffsetRef.current = yOffset

          const geo = new THREE.BufferGeometry()
          geo.setAttribute('position',      new THREE.BufferAttribute(positions.subarray(0, vi * 3), 3))
          geo.setAttribute('color',         new THREE.BufferAttribute(colors.subarray(0, vi * 3), 3))
          geo.setAttribute('aLocalSpacing', new THREE.BufferAttribute(spacings.subarray(0, vi), 1))

          const mat = new THREE.ShaderMaterial({
            vertexColors: true,
            transparent: false,
            depthWrite: true,
            depthTest: true,
            vertexShader: SPLAT_VERT,
            fragmentShader: SPLAT_FRAG,
            uniforms: {
              uViewH:    { value: t.renderer?.domElement?.height ?? 1 },
              uYOffset:  { value: yOffset },
              uFloorY:   { value: isFinite(minY) ? minY + 0.02 : 0 },
              uCeilY:    { value: isFinite(maxY) ? maxY - 0.02 : 2 },
              uRoomCX:   { value: (minX + maxX) * 0.5 },
              uRoomCZ:   { value: (minZ + maxZ) * 0.5 },
              uDiagMode: { value: 0 },
            },
          })

          const points = new THREE.Points(geo, mat)
          t.scene.add(points)
          pointCloudMeshRef.current = points
          rawBufferRef.current = buf

          // Median spacing for diagnostics display
          const sortedSpacings = spacings.subarray(0, vi).slice().sort()
          const medSpacingMm   = Math.round((sortedSpacings[Math.floor(vi / 2)] ?? 0.01) * 1000)

          const fboW = t.renderer?.domElement?.width ?? 0
          const fboH = t.renderer?.domElement?.height ?? 0
          const savedPtCount  = roomScan?.pointCloud?.pointCount ?? 0
          const snapshotCount = roomScan?.snapshots?.length ?? roomScan?.snapshotCount ?? 0
          diagStatsRef.current = {
            rawPts: n,
            renderedPts: vi,
            fboW,
            fboH,
            dpr: Math.min(window.devicePixelRatio, 2),
            colourMethod: savedPtCount > 0 ? 'On-device photo projection (iOS)' : 'LiDAR sensor (device)',
            snapshotCount,
            wegterSpacingMm: medSpacingMm,
          }

          try {
            const center = new THREE.Vector3((minX + maxX) * 0.5, 1.6, (minZ + maxZ) * 0.5)
            t.orbit.center.copy(center)
            t.orbit.phi = Math.PI / 2
            t.orbit.theta = 0.4
            t.applyOrbit()
          } catch { /* ignore */ }

          reportRoomLoad(100, 'Scan ready', false)

          // Async upgrade: swap vertex-colour material for photo-projective texturing.
          // Fire-and-forget so the scan is immediately visible while textures load.
          if (roomId && !cancelled) {
            upgradeProjectiveTexturing({
              points, yOffset, roomId,
              diagRef: diagStatsRef,
              onDiagUpdate: () => setDiagVersion(v => v + 1),
              onProgress: reportRoomLoad,
              maxFragTextures: t.renderer?.capabilities?.maxTextures,
            }).catch(err => {
              console.warn('[projective] upgrade error:', err)
              reportRoomLoad(100, 'Photo projection failed', false)
            })
          }
          return
        } catch (err) {
          console.warn('[SpaceBuilderCanvas] Could not render raw points:', err)
          reportRoomLoad(100, 'Scan load failed', false)
          return
        }
      }

      // ── Build colored point cloud ─────────────────────────────────
      try {
        // Zero-copy: access buf._data directly rather than toFloat32Array()
        // which would copy the entire array (240 MB for a 10M-point scan).
        const rawData = buf._data
        const n       = buf.pointCount

        // ── 3-pass algorithm ─────────────────────────────────────────────────
        //
        // Pass 1 (SOR, 10 cm grid): build coarse voxel map for outlier removal.
        //   Floating noise blobs that have fewer than SOR_MIN neighbours in the
        //   3×3×3 surrounding cells are tagged as outliers and skipped.
        //   10 cm cells are intentionally coarse so each cell has enough points
        //   for a reliable neighbourhood count; the SOR is insensitive to grid
        //   resolution as long as it's large enough to aggregate returns.
        //
        // Pass 2 (Render dedup, 2.5 cm grid): deduplicate to one representative
        //   point per 2.5 cm render-voxel.  2.5 cm gives fine enough granularity
        //   that individual textural details (bricks, wood grain) are preserved,
        //   while still reducing a 10 M-point scan to ~300 K–1 M render points.
        //   Position = average centroid; colour = per-channel median (9 samples).
        //
        // Yield points after each heavy phase let the browser repaint and show
        // smooth progress instead of a sudden jump at the end.
        //
        const CELL        = 0.10          // coarse grid for outlier removal only
        const CELL_INV    = 1 / CELL
        const SOR_MIN     = 4

        const hashXYZ = (ix, iy, iz) =>
          (ix * 92837111 + iy * 689287499 + iz * 283923481) | 0

        // ─── Pass 1a: coarse voxel count + bounds ─────────────────────────
        const voxelCounts = new Map()
        const voxelKeys   = new Int32Array(n)
        let   minY = Infinity, maxY = -Infinity
        let   minX = Infinity, maxX = -Infinity
        let   minZ = Infinity, maxZ = -Infinity

        for (let i = 0, b = 0; i < n; i++, b += 6) {
          const x = rawData[b], y = rawData[b+1], z = rawData[b+2]
          if (y < minY) minY = y;  if (y > maxY) maxY = y
          if (x < minX) minX = x;  if (x > maxX) maxX = x
          if (z < minZ) minZ = z;  if (z > maxZ) maxZ = z

          const ix  = Math.floor(x * CELL_INV)
          const iy  = Math.floor(y * CELL_INV)
          const iz  = Math.floor(z * CELL_INV)
          const key = hashXYZ(ix, iy, iz)
          voxelKeys[i] = key
          voxelCounts.set(key, (voxelCounts.get(key) || 0) + 1)

          if ((i & 0x1ffff) === 0 && i > 0 && !cancelled) {
            reportRoomLoad(42 + (16 * i / n), 'Building voxel map')
          }
        }
        if (cancelled) return
        await new Promise(r => setTimeout(r, 0))  // yield → browser repaints progress

        const yOffset = isFinite(minY) ? -minY : 0
        yOffsetRef.current = yOffset

        const roomCenterX  = (minX + maxX) * 0.5
        const roomCenterZ  = (minZ + maxZ) * 0.5
        const roomHeight   = isFinite(maxY) && isFinite(minY) ? (maxY - minY) : 1

        // ─── Pass 1b: identify singletons ─────────────────────────────────
        reportRoomLoad(58, 'Identifying outliers')
        const singletonOffset = new Map()
        for (let i = 0, b = 0; i < n; i++, b += 6) {
          const key = voxelKeys[i]
          if ((voxelCounts.get(key) || 0) === 1) singletonOffset.set(key, b)
        }
        if (cancelled) return
        await new Promise(r => setTimeout(r, 0))

        // ─── Pass 1c: SOR on singletons ────────────────────────────────────
        const outlierKeys = new Set()
        let singletonProcessed = 0
        for (const [key, b] of singletonOffset) {
          const ix = Math.floor(rawData[b]   * CELL_INV)
          const iy = Math.floor(rawData[b+1] * CELL_INV)
          const iz = Math.floor(rawData[b+2] * CELL_INV)
          let nhTotal = 0
          outer: for (let dx = -1; dx <= 1; dx++)
            for (let dy = -1; dy <= 1; dy++)
              for (let dz = -1; dz <= 1; dz++) {
                nhTotal += voxelCounts.get(hashXYZ(ix+dx, iy+dy, iz+dz)) || 0
                if (nhTotal >= SOR_MIN) break outer
              }
          if (nhTotal < SOR_MIN) outlierKeys.add(key)
          singletonProcessed++
          if ((singletonProcessed & 0xfff) === 0 && singletonOffset.size > 0 && !cancelled) {
            reportRoomLoad(60 + (8 * singletonProcessed / singletonOffset.size), 'Filtering outliers')
          }
        }
        if (cancelled) return
        await new Promise(r => setTimeout(r, 0))

        // ─── Pass 2: spherical range-image grid + vertex build ────────────
        // Project every non-outlier LiDAR point onto a 2-D spherical panorama
        // centred on the room origin.  Only the nearest-depth point per cell
        // is kept — this simultaneously deduplicates dense clusters AND creates
        // an organised topology that can be triangulated in the next pass.
        //
        // Grid: 2000 columns (360° / 0.18°) × 1000 rows (180° / 0.18°).
        // ~12 M points → ~1.5–2 M occupied cells → 1.5–2 M vertices.
        // Memory: 2 M × 2 Int32/Float32 arrays = ~16 MB for the grid;
        //         2 M × 6 floats = ~48 MB for position + colour buffers.
        reportRoomLoad(68, 'Building panoramic grid')
        const GRID_W    = 2000
        const GRID_H    = 1000
        const GRID_SIZE = GRID_W * GRID_H
        const gridVtx   = new Int32Array(GRID_SIZE).fill(-1)    // → vertex idx
        const gridDepth = new Float32Array(GRID_SIZE).fill(1e9) // → depth r

        const cx = roomCenterX
        const cy = (minY + maxY) * 0.5
        const cz = roomCenterZ

        const positions = new Float32Array(GRID_SIZE * 3)  // max 2 M vertices
        const colors    = new Float32Array(GRID_SIZE * 3)
        let vi = 0

        const TWO_PI_INV = GRID_W / (2 * Math.PI)
        const PI_INV     = GRID_H / Math.PI

        for (let i = 0, b = 0; i < n; i++, b += 6) {
          if (outlierKeys.has(voxelKeys[i])) continue
          const px = rawData[b], py = rawData[b+1], pz = rawData[b+2]
          const dx = px - cx, dy = py - cy, dz = pz - cz
          const r  = Math.sqrt(dx*dx + dy*dy + dz*dz) || 0.001

          const phi = Math.asin(Math.max(-1, Math.min(1, dy / r)))  // -π/2..π/2
          const th  = Math.atan2(dz, dx)                            // -π..π
          const gx  = Math.min(GRID_W - 1, (th + Math.PI) * TWO_PI_INV | 0)
          const gy  = Math.min(GRID_H - 1, (phi + Math.PI * 0.5) * PI_INV | 0)
          const gi  = gy * GRID_W + gx

          if (r < gridDepth[gi]) {
            if (gridVtx[gi] < 0) { gridVtx[gi] = vi; vi++ }
            const v = gridVtx[gi]
            positions[v*3]   = px
            positions[v*3+1] = py   // raw y — MESH_VERT applies uYOffset
            positions[v*3+2] = pz
            colors[v*3]   = rawData[b+3]
            colors[v*3+1] = rawData[b+4]
            colors[v*3+2] = rawData[b+5]
            gridDepth[gi] = r
          }
          if ((i & 0x1ffff) === 0 && i > 0 && !cancelled)
            reportRoomLoad(68 + (14 * i / n), 'Building panoramic grid')
        }
        if (cancelled) return
        await new Promise(r => setTimeout(r, 0))

        // ─── Pass 3: triangulate the spherical grid ──────────────────────
        // For each 2×2 quad of adjacent grid cells, form two triangles.
        // Quads where any vertex-pair depth ratio exceeds MAX_DEPTH_RATIO are
        // discarded — those span a real surface discontinuity (wall edge,
        // object silhouette).  The theta seam wraps around with modulo.
        reportRoomLoad(86, 'Triangulating surface')
        const MAX_DEPTH_RATIO = 1.08   // 8% depth jump → cull triangle
        const triBuffer = new Uint32Array(GRID_SIZE * 2 * 3)  // 2 tris/cell max
        let   triCount  = 0

        for (let gy = 0; gy < GRID_H - 1; gy++) {
          for (let gx = 0; gx < GRID_W; gx++) {
            const gx1 = (gx + 1) % GRID_W   // wrap at ±π theta seam

            const gi00 = gy       * GRID_W + gx
            const gi10 = gy       * GRID_W + gx1
            const gi01 = (gy + 1) * GRID_W + gx
            const gi11 = (gy + 1) * GRID_W + gx1

            const v00 = gridVtx[gi00], d00 = gridDepth[gi00]
            const v10 = gridVtx[gi10], d10 = gridDepth[gi10]
            const v01 = gridVtx[gi01], d01 = gridDepth[gi01]
            const v11 = gridVtx[gi11], d11 = gridDepth[gi11]

            // Triangle A: upper-left half of the quad (00, 10, 01)
            if (v00 >= 0 && v10 >= 0 && v01 >= 0) {
              const mx = d00 > d10 ? (d00 > d01 ? d00 : d01) : (d10 > d01 ? d10 : d01)
              const mn = d00 < d10 ? (d00 < d01 ? d00 : d01) : (d10 < d01 ? d10 : d01)
              if (mx / mn < MAX_DEPTH_RATIO) {
                triBuffer[triCount*3] = v00; triBuffer[triCount*3+1] = v10; triBuffer[triCount*3+2] = v01
                triCount++
              }
            }
            // Triangle B: lower-right half (10, 11, 01)
            if (v10 >= 0 && v11 >= 0 && v01 >= 0) {
              const mx = d10 > d11 ? (d10 > d01 ? d10 : d01) : (d11 > d01 ? d11 : d01)
              const mn = d10 < d11 ? (d10 < d01 ? d10 : d01) : (d11 < d01 ? d11 : d01)
              if (mx / mn < MAX_DEPTH_RATIO) {
                triBuffer[triCount*3] = v10; triBuffer[triCount*3+1] = v11; triBuffer[triCount*3+2] = v01
                triCount++
              }
            }
          }
          if ((gy & 0x1f) === 0 && !cancelled)
            reportRoomLoad(86 + (4 * gy / GRID_H), 'Triangulating surface')
        }
        if (cancelled) return
        await new Promise(r => setTimeout(r, 0))

        const fboW = t.renderer?.domElement?.width  ?? 0
        const fboH = t.renderer?.domElement?.height ?? 0
        diagStatsRef.current = {
          rawPts: n,
          renderedPts: vi,
          triCount,
          fboW,
          fboH,
          dpr: Math.min(window.devicePixelRatio, 2),
        }

        // Zero-copy subarray views — Three.js uploads only the filled slice.
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, vi * 3), 3))
        geo.setAttribute('color',    new THREE.BufferAttribute(colors.subarray(0, vi * 3),    3))
        geo.setIndex(new THREE.BufferAttribute(triBuffer.subarray(0, triCount * 3), 1))

        const mat = new THREE.ShaderMaterial({
          vertexColors: true,
          side: THREE.DoubleSide,   // room is viewed from inside — all faces visible
          vertexShader: MESH_VERT,
          fragmentShader: MESH_FRAG,
          uniforms: {
            uYOffset:  { value: yOffset },
            uDiagMode: { value: 0 },
          },
        })

        const mesh = new THREE.Mesh(geo, mat)
        t.scene.add(mesh)
        pointCloudMeshRef.current = mesh
        rawBufferRef.current = buf  // keep decoded buffer for Declare Surface measurement
        reportRoomLoad(90, 'Rendering scan')
        reportRoomLoad(100, 'Scan ready', false)

        // Dedicated reconstruction is rendered as a separate mesh layer so the
        // room shape stays faithful without replacing the point cloud preview.

        // Auto-frame the camera to show the full room scan
        try {
          geo.computeBoundingBox()
          const bbox = geo.boundingBox
          const center = new THREE.Vector3()
          bbox.getCenter(center)

          // FPS mode: stand at room centre at eye height, look horizontally
          const EYE_HEIGHT = 1.6   // metres above floor (yOffset already applied)
          t.orbit.center.set(center.x, EYE_HEIGHT, center.z)
          t.orbit.phi   = Math.PI / 2   // look horizontally
          t.orbit.theta = 0.4           // initial heading (matches default)
          t.applyOrbit()
        } catch { /* ignore framing errors */ }
      } catch (err) {
        console.warn('[SpaceBuilderCanvas] Could not render point cloud:', err)
        reportRoomLoad(100, 'Scan load failed', false)
      }

      if (ENABLE_RECONSTRUCTION_OVERLAY) {
        try {
          const reconstruction = await reconstructPlanarSurfaces(buf, {
            yOffset: yOffsetRef.current,
          })

          if (!cancelled && reconstruction?.segments?.length) {
            for (const segment of reconstruction.segments) {
              const geo = new THREE.BufferGeometry()
              geo.setAttribute('position', new THREE.BufferAttribute(segment.positions, 3))
              const colors = segment.textureColors || segment.colors
              if (colors?.length) {
                geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
              }
              geo.setAttribute('uv', new THREE.BufferAttribute(segment.uvs, 2))
              geo.setIndex(new THREE.BufferAttribute(segment.indices, 1))
              geo.computeVertexNormals()

              const mat = new THREE.MeshBasicMaterial({
                vertexColors: !!colors?.length,
                transparent: true,
                opacity: segment.classification === 'ceiling' ? 0.2 : 0.28,
                side: THREE.DoubleSide,
                depthWrite: false,
              })
              const mesh = new THREE.Mesh(geo, mat)
              mesh.renderOrder = 2

              const wireMat = new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.18, transparent: true })
              const wireGeo = new THREE.EdgesGeometry(geo)
              const wire = new THREE.LineSegments(wireGeo, wireMat)
              mesh.add(wire)

              t.scene.add(mesh)
              reconstructionMeshesRef.current.push(mesh)
            }
          }
        } catch (err) {
          console.warn('[SpaceBuilderCanvas] Could not render reconstructed mesh:', err)
        }
      }

      // ── Build ghost plane meshes from detected planes ─────────────────
      try {
        if (roomScan.planes?.length) {
          const planes = planesFromJSON(roomScan.planes)
          for (const plane of planes) {
            const verts = plane.vertices  // Float32Array of [x,y,z, x,y,z, ...]
            const count = verts.length / 3
            if (count < 3) continue

            // Build a simple polygon mesh by fan-triangulation from centroid
            const cx = verts.reduce((s, v, i) => i % 3 === 0 ? s + v : s, 0) / count
            const cy = verts.reduce((s, v, i) => i % 3 === 1 ? s + v : s, 0) / count
            const cz = verts.reduce((s, v, i) => i % 3 === 2 ? s + v : s, 0) / count

            const positions = [cx, cy, cz]
            for (let i = 0; i < count; i++) {
              positions.push(verts[i*3], verts[i*3+1], verts[i*3+2])
            }
            const indices = []
            for (let i = 1; i <= count; i++) {
              indices.push(0, i, (i % count) + 1)
            }

            const geo = new THREE.BufferGeometry()
            geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
            geo.setIndex(indices)
            geo.computeVertexNormals()

            const color = plane.orientation === 'horizontal' ? 0x34d399 : 0x4a9eff
            const mat = new THREE.MeshBasicMaterial({
              color,
              transparent: true,
              opacity: 0.08,
              side: THREE.DoubleSide,
              depthWrite: false,
            })

            // Wireframe outline
            const wireMat = new THREE.LineBasicMaterial({ color, opacity: 0.35, transparent: true })
            const wireGeo = new THREE.EdgesGeometry(geo)
            const wire    = new THREE.LineSegments(wireGeo, wireMat)

            const mesh = new THREE.Mesh(geo, mat)
            mesh.add(wire)
            t.scene.add(mesh)
            planeMeshesRef.current.push(mesh)
          }
        }
      } catch (err) {
        console.warn('[SpaceBuilderCanvas] Could not render planes:', err)
      }
    }

    buildCloud()
    return () => { cancelled = true }
  }, [roomScan, reportRoomLoad, meshGeneration, scanRenderMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Composite piece overlays onto surface textures ───────────────────────
  useEffect(() => {
    const t = threeRef.current
    if (!t) return

    // Collect surfaces that need (re-)compositing
    const toProcess = []
    for (const surface of space.surfaces) {
      const layoutName = surface.activeLayout
      if (!layoutName) {
        // No active layout — clear any cached composite so we revert to base texture
        if (compTexCacheRef.current.has(surface.id)) {
          compTexCacheRef.current.delete(surface.id)
          // Force syncMeshes to pick up the now-uncached base texture
        }
        continue
      }
      const pieces = surface.layouts?.[layoutName]?.pieces || []
      const baseUrl = surface.inpaintDataUrl
        || surface.stitchedDataUrl
        || surface.warpedDataUrl
        || space.photos.find(p => p.id === surface.photoId)?.dataUrl
        || null
      if (!baseUrl) continue

      const key = baseUrl + '|' + JSON.stringify(pieces)
      const cached = compTexCacheRef.current.get(surface.id)
      if (cached?.key === key) continue  // already up-to-date

      toProcess.push({ surface, baseUrl, pieces, key })
    }

    if (toProcess.length === 0) return

    // Composite async, then re-sync meshes once all done
    ;(async () => {
      let changed = false
      for (const { surface, baseUrl, pieces, key } of toProcess) {
        try {
          const dataUrl = await compositePiecesOntoTexture(surface, baseUrl, pieces)
          compTexCacheRef.current.set(surface.id, { key, dataUrl })
          changed = true
        } catch (err) {
          console.error('[SpaceBuilderCanvas] composite failed for', surface.id, err)
        }
      }
      if (changed) t.syncMeshes(stateRef.current.space.surfaces)
    })()
  }, [space]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard: rotate selected surface
  useEffect(() => {
    function onKey(e) {
      const t = threeRef.current; if (!t) return
      const id = stateRef.current.activeSurfaceId; if (!id) return
      const entry = t.meshMap[id]; if (!entry) return
      const stepDeg = e.shiftKey ? 5 : 15
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // ←→ rotate Y — keep rotYDeg in sync with slider
        e.preventDefault()
        const surf = stateRef.current.space.surfaces.find(s => s.id === id)
        const newDeg = (surf?.rotYDeg ?? 0) + (e.key === 'ArrowLeft' ? -stepDeg : stepDeg)
        entry.mesh.rotation.y = newDeg * Math.PI / 180
        stateRef.current.onUpdateSurface(id, { rotYDeg: newDeg })
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // ↑↓ rotate X (tilt) — stored in pose3d.rotX
        e.preventDefault()
        entry.mesh.rotation.x += (e.key === 'ArrowUp' ? stepDeg : -stepDeg) * Math.PI / 180
        stateRef.current.onUpdateSurface(id, {
          pose3d: { position: entry.mesh.position.toArray(), rotX: entry.mesh.rotation.x },
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Update camera FOV whenever the preset changes
  useEffect(() => {
    const t = threeRef.current
    if (!t?.camera) return
    t.camera.fov = fov
    t.camera.updateProjectionMatrix()
  }, [fov])

  // Propagate diagnostics colour mode to the point cloud shader uniform
  useEffect(() => {
    const obj = pointCloudMeshRef.current
    if (!obj) return
    if (obj.material?.uniforms?.uDiagMode) {
      obj.material.uniforms.uDiagMode.value = diagMode
      return
    }
    if (obj.traverse) {
      obj.traverse(o => {
        if (o.material?.uniforms?.uDiagMode) {
          o.material.uniforms.uDiagMode.value = diagMode
        }
      })
    }
  }, [diagMode])

  // ── Joystick pointer handlers — shared helper ────────────────────────────
  function makeJoyHandlers(joyRef, setPos) {
    return {
      onDown(e) {
        e.currentTarget.setPointerCapture(e.pointerId)
        joyRef.current.active = true
      },
      onMove(e) {
        if (!joyRef.current.active) return
        const rect = e.currentTarget.getBoundingClientRect()
        const cx = rect.left + rect.width  / 2
        const cy = rect.top  + rect.height / 2
        const dx = e.clientX - cx
        const dy = e.clientY - cy
        const dist = Math.sqrt(dx * dx + dy * dy)
        const maxDist = JOY_RADIUS - JOY_THUMB
        const clamped = dist > maxDist ? maxDist / dist : 1
        const tx = dx * clamped, ty = dy * clamped
        joyRef.current.nx = tx / maxDist
        joyRef.current.ny = ty / maxDist
        setPos({ x: tx, y: ty })
      },
      onUp() {
        joyRef.current.active = false
        joyRef.current.nx = 0
        joyRef.current.ny = 0
        setPos({ x: 0, y: 0 })
      },
    }
  }

  // Orbit joystick
  const orbitJoy = makeJoyHandlers(joystickRef, setJoyPos)
  const handleJoyDown = orbitJoy.onDown
  const handleJoyMove = orbitJoy.onMove
  const handleJoyUp   = orbitJoy.onUp

  // Pan joystick (left)
  const panJoy = makeJoyHandlers(panJoystickRef, setPanJoyPos)
  const handlePanJoyDown = panJoy.onDown
  const handlePanJoyMove = panJoy.onMove
  const handlePanJoyUp   = panJoy.onUp

  // Forward/Back joystick (only Y axis used in RAF loop)
  const fwdJoy = makeJoyHandlers(fwdJoystickRef, setFwdJoyPos)
  const handleFwdJoyDown = fwdJoy.onDown
  const handleFwdJoyMove = fwdJoy.onMove
  const handleFwdJoyUp   = fwdJoy.onUp

  return (
    <div ref={mountRef} className="sbc-3d-viewport">
      {snapHint && (
        <div className="sbc-snap-hint">
          ⚡ snap: <strong>{snapHint.fromEdge}</strong> → <strong>{snapHint.toEdge}</strong> — release to connect
        </div>
      )}

      {/* ── FOV presets — left side, vertical ──────────────────────── */}
      <div className="sbc-fov-bar">
        <span className="sbc-ctrl-label">FOV</span>
        {FOV_PRESETS.map(p => (
          <button
            key={p.label}
            className={`sbc-fov-btn${fov === p.fov ? ' sbc-fov-btn--active' : ''}`}
            onClick={() => setFov(p.fov)}
            title={`${p.fov}° field of view`}
          >{p.label}</button>
        ))}
        {/* Diagnostics toggle — at bottom of FOV bar, only shown when a scan is loaded */}
        {diagStatsRef.current && (
          <button
            className={`sbc-fov-btn${diagVisible ? ' sbc-fov-btn--active' : ''}`}
            style={{ marginTop: 8, fontSize: '0.65rem', padding: '3px 6px' }}
            onClick={() => setDiagVisible(v => !v)}
            title="Toggle scan diagnostics overlay"
          >Diag</button>
        )}
      </div>

      {/* ── Zoom controls — right side, vertical ─────────────────────── */}
      <div className="sbc-zoom-bar">
        <span className="sbc-ctrl-label">Zoom</span>
        <button
          className="sbc-zoom-btn"
          title={cameraFPSRef.current ? 'Step forward' : 'Zoom in'}
          onClick={() => {
            const t = threeRef.current; if (!t) return
            if (cameraFPSRef.current) {
              // FPS: step forward along look direction
              const o = t.orbit
              const sphi = Math.sin(o.phi), cphi = Math.cos(o.phi)
              o.center.x += sphi * Math.sin(o.theta) * 0.5
              o.center.y += cphi                      * 0.5
              o.center.z += sphi * Math.cos(o.theta) * 0.5
              setZoomRadius(prev => scaleZoomRadius(prev, 0.8, ZOOM_MIN, ZOOM_MAX))
            } else {
              const r = scaleZoomRadius(zoomRadius, 0.8, ZOOM_MIN, ZOOM_MAX)
              setZoomRadius(r)
              t.orbit.radius = r
            }
            t.applyOrbit()
          }}
        >+</button>
        <span className="sbc-zoom-val">{radiusToSlider(zoomRadius, ZOOM_MIN, ZOOM_MAX).toFixed(0)}%</span>
        <button
          className="sbc-zoom-btn"
          title={cameraFPSRef.current ? 'Step back' : 'Zoom out'}
          onClick={() => {
            const t = threeRef.current; if (!t) return
            if (cameraFPSRef.current) {
              // FPS: step back
              const o = t.orbit
              const sphi = Math.sin(o.phi), cphi = Math.cos(o.phi)
              o.center.x -= sphi * Math.sin(o.theta) * 0.5
              o.center.y -= cphi                      * 0.5
              o.center.z -= sphi * Math.cos(o.theta) * 0.5
              setZoomRadius(prev => scaleZoomRadius(prev, 1.25, ZOOM_MIN, ZOOM_MAX))
            } else {
              const r = scaleZoomRadius(zoomRadius, 1.25, ZOOM_MIN, ZOOM_MAX)
              setZoomRadius(r)
              t.orbit.radius = r
            }
            t.applyOrbit()
          }}
        >−</button>
      </div>

      {/* ── Joystick group — centered at top ─────────────────────────── */}
      <div className="sbc-joystick-group">
        {/* Move/Pan joystick */}
        <div className="sbc-joystick-wrapper">
          <div
            className="sbc-joystick sbc-joystick--pan"
            style={{ '--jr': `${JOY_RADIUS}px` }}
            onPointerDown={handlePanJoyDown}
            onPointerMove={handlePanJoyMove}
            onPointerUp={handlePanJoyUp}
            onPointerLeave={handlePanJoyUp}
            title="Drag to pan / move view"
          >
            <svg className="sbc-joystick-arrows" viewBox="0 0 72 72" fill="none">
              <path d="M36 13l-7 11h14l-7-11Z" fill="currentColor" opacity=".55"/>
              <path d="M36 59l-7-11h14l-7 11Z" fill="currentColor" opacity=".55"/>
              <path d="M13 36l11-7v14l-11-7Z" fill="currentColor" opacity=".55"/>
              <path d="M59 36l-11-7v14Z" fill="currentColor" opacity=".55"/>
              <line x1="36" y1="24" x2="36" y2="48" stroke="currentColor" strokeWidth="1" opacity=".2"/>
              <line x1="24" y1="36" x2="48" y2="36" stroke="currentColor" strokeWidth="1" opacity=".2"/>
            </svg>
            <div
              className="sbc-joystick-thumb"
              style={{
                '--jt': `${JOY_THUMB}px`,
                transform: `translate(calc(-50% + ${panJoyPos.x}px), calc(-50% + ${panJoyPos.y}px))`,
              }}
            />
          </div>
          <div className="sbc-joystick-label">Move</div>
        </div>

        {/* Orbit joystick */}
        <div className="sbc-joystick-wrapper">
          <div
            className="sbc-joystick sbc-joystick--orbit"
            style={{ '--jr': `${JOY_RADIUS}px` }}
            onPointerDown={handleJoyDown}
            onPointerMove={handleJoyMove}
            onPointerUp={handleJoyUp}
            onPointerLeave={handleJoyUp}
            title="Drag to orbit / rotate view"
          >
            <svg className="sbc-joystick-globe" viewBox="0 0 72 72" fill="none">
              <circle cx="36" cy="36" r="26" stroke="currentColor" strokeWidth="1.5" opacity=".65"/>
              <ellipse cx="36" cy="36" rx="26" ry="7.5" stroke="currentColor" strokeWidth="1" opacity=".5"/>
              <ellipse cx="36" cy="25" rx="19" ry="5.5" stroke="currentColor" strokeWidth="1" opacity=".4"/>
              <ellipse cx="36" cy="47" rx="19" ry="5.5" stroke="currentColor" strokeWidth="1" opacity=".4"/>
              <ellipse cx="36" cy="36" rx="7.5" ry="26" stroke="currentColor" strokeWidth="1" opacity=".5"/>
              <ellipse cx="36" cy="36" rx="7.5" ry="26" stroke="currentColor" strokeWidth="1" opacity=".35" transform="rotate(60 36 36)"/>
            </svg>
            <div
              className="sbc-joystick-thumb"
              style={{
                '--jt': `${JOY_THUMB}px`,
                transform: `translate(calc(-50% + ${joyPos.x}px), calc(-50% + ${joyPos.y}px))`,
              }}
            />
          </div>
          <div className="sbc-joystick-label">Orbit</div>
        </div>

        {/* Forward/Back (dolly) joystick */}
        <div className="sbc-joystick-wrapper">
          <div
            className="sbc-joystick sbc-joystick--fwd"
            style={{ '--jr': `${JOY_RADIUS}px` }}
            onPointerDown={handleFwdJoyDown}
            onPointerMove={handleFwdJoyMove}
            onPointerUp={handleFwdJoyUp}
            onPointerLeave={handleFwdJoyUp}
            title="Drag up/down to move forward/back into the scene"
          >
            {/* Perspective double-arrow: small arrowhead at top (far/into screen),
                large arrowhead at bottom (near/out of screen), tapering body. */}
            <svg className="sbc-joystick-depth" viewBox="0 0 72 72" fill="none">
              {/* Perspective body (trapezoid, narrow at top, wide at bottom) */}
              <path d="M31 25 L41 25 L45 47 L27 47 Z" fill="currentColor" opacity=".15"/>
              {/* Far arrowhead (top, small) */}
              <path d="M36 12 L31 25 L41 25 Z" fill="currentColor" opacity=".6"/>
              {/* Near arrowhead (bottom, large) */}
              <path d="M36 60 L27 47 L45 47 Z" fill="currentColor" opacity=".6"/>
              {/* Center spine */}
              <line x1="36" y1="25" x2="36" y2="47" stroke="currentColor" strokeWidth="1" opacity=".3"/>
            </svg>
            <div
              className="sbc-joystick-thumb"
              style={{
                '--jt': `${JOY_THUMB}px`,
                transform: `translate(calc(-50% + ${fwdJoyPos.x}px), calc(-50% + ${fwdJoyPos.y}px))`,
              }}
            />
          </div>
          <div className="sbc-joystick-label">Forward / Back</div>
        </div>
      </div>

      <div className="sbc-3d-legend">
        <span>Drag bg / joystick: orbit</span>
        <span>Drag surface: move XZ</span>
        <span>Shift+drag: raise/lower</span>
        <span>←→↑↓: rotate (Shift=fine)</span>
        <span>Dbl-click: crop corners</span>
        <span>Scroll: zoom in/out</span>
      </div>
      {space.surfaces.length === 0 && !roomScan && (
        <div className="sbc-3d-empty">
          <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
            <rect x="4" y="12" width="48" height="32" rx="4" stroke="#4a9eff" strokeWidth="2"/>
            <circle cx="19" cy="24" r="5" stroke="#4a9eff" strokeWidth="2"/>
            <path d="M4 36l14-10 10 7 10-13 18 16" stroke="#4a9eff" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>
          </svg>
          <p>Add a photo — drag surfaces into position to build your room</p>
        </div>
      )}
      {cropSurfaceId && (
        <CropOverlay
          surfaceId={cropSurfaceId}
          space={space}
          onUpdateSurface={onUpdateSurface}
          onClose={() => setCropSurfaceId(null)}
        />
      )}

      {/* ── Add Surface from current 3D view (perspective warp) ─── */}
      {onSurfaceFromView && (
        <button
          className="sbc-add-surface-btn"
          title="Capture this view and apply perspective warp to create a new wall surface"
          onClick={() => {
            const t = threeRef.current
            if (!t?.renderer) return
            // Force a render so the canvas buffer is fresh
            t.renderer.render(t.scene, t.camera)
            const dataUrl = t.renderer.domElement.toDataURL('image/jpeg', 0.88)
            // Capture camera matrices for LiDAR-based dimension measurement in WallSetup
            const cam = t.camera
            onSurfaceFromView(dataUrl, {
              fov: fov,
              projectionMatrixElements: Array.from(cam.projectionMatrix.elements),
              viewMatrixElements:       Array.from(cam.matrixWorldInverse.elements),
              yOffset:                  yOffsetRef.current ?? 0,
              pointCloudBuffer:         rawBufferRef.current ?? null,
            })
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="2" width="12" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M4 7.5L6 5.5L8 7L10 5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round"/>
            <path d="M7 12v-2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          {roomScan ? 'Declare Surface' : 'Add Surface'}
        </button>
      )}

      {/* ── Diagnostics overlay ───────────────────────────────────── */}
      {diagVisible && diagStatsRef.current && (() => {
        void diagVersion  // consume version counter so React re-renders when stats update
        const s = diagStatsRef.current
        const renderedPct = s.rawPts > 0 ? ((s.renderedPts / s.rawPts) * 100).toFixed(1) : '—'
        return (
          <div className="sbc-diag-panel">
            <div className="sbc-diag-title">
              Scan Diagnostics
              <div className="sbc-diag-modes">
                {['Color', 'Depth'].map((label, i) => (
                  <button
                    key={i}
                    className={`sbc-diag-mode-btn${diagMode === i ? ' active' : ''}`}
                    onClick={() => setDiagMode(i)}
                  >{label}</button>
                ))}
              </div>
            </div>
            <table className="sbc-diag-table">
              <tbody>
                <tr><td>Raw scan pts</td><td>{s.rawPts.toLocaleString()}</td></tr>
                <tr><td>Rendered pts</td><td>
                  {s.renderedPts.toLocaleString()}
                  <span className="sbc-diag-dim"> ({renderedPct}% of raw)</span>
                </td></tr>
                {s.snapshotCount > 0 && (
                  <tr><td>Photo snapshots</td><td>{s.snapshotCount}</td></tr>
                )}
                {s.photoSnapshotsTotal != null && (
                  <tr><td>Photo snapshots</td><td>
                    {s.photoSnapshotsProjected ?? 0}/{s.photoSnapshotsTotal}
                    <span className="sbc-diag-dim"> projected</span>
                  </td></tr>
                )}
                {s.projective && (
                  <>
                    <tr><td>Proj. cameras</td><td>
                      {s.projUsed ?? s.projCams}/{s.projSelected ?? s.projCams}
                      <span className="sbc-diag-dim"> (of {s.projTotal} scanned)</span>
                    </td></tr>
                    <tr><td>Photo coverage</td><td>
                      {s.projCoverage != null ? `${s.projCoverage}%` : '—'}
                      <span className="sbc-diag-dim"> of wall pts</span>
                    </td></tr>
                    {s.projSpecklePct != null && (
                      <tr><td>True speckle</td><td>
                        {s.projSpecklePct}%
                        <span className="sbc-diag-dim"> wall pts uncovered</span>
                      </td></tr>
                    )}
                    {s.projOccludePct != null && (
                      <tr><td>Occlusion cull</td><td>
                        {s.projOccludePct}%
                        <span className="sbc-diag-dim"> of UV-valid (cam,pt) pairs</span>
                      </td></tr>
                    )}
                    {s.projAvgFacing != null && (
                      <tr><td>Avg facing</td><td>
                        {s.projAvgFacing}
                        <span className="sbc-diag-dim"> (1.0=face-on, 0.25=oblique)</span>
                      </td></tr>
                    )}
                    {s.projVoxHitPct != null && (
                      <tr><td>Voxel assign</td><td>
                        {s.projVoxHitPct}% direct
                        {s.projVoxNeighPct != null && (
                          <span className="sbc-diag-dim"> / {s.projVoxNeighPct}% neigh / {s.projVoxFailPct}% miss</span>
                        )}
                      </td></tr>
                    )}
                    {s.projSampleStep != null && (
                      <tr><td>Pre-pass stride</td><td>
                        1/{s.projSampleStep}
                        <span className="sbc-diag-dim"> pts sampled</span>
                      </td></tr>
                    )}
                  </>
                )}
                {!s.projective && s.projStatus != null && (
                  <tr><td>Photo proj.</td><td>
                    <span className="sbc-diag-dim">{s.projStatus}</span>
                  </td></tr>
                )}
                {!s.projective && s.photoCoveragePct != null && (
                  <tr><td>Photo coverage</td><td>
                    {`${Math.round(s.photoCoveragePct)}%`}
                    <span className="sbc-diag-dim"> of mesh verts</span>
                  </td></tr>
                )}
                <tr><td>Wegter splat Ø</td><td>
                  {s.wegterSpacingMm != null ? `${s.wegterSpacingMm} mm` : 'N/A'}
                  <span className="sbc-diag-dim"> (median, adaptive)</span>
                </td></tr>
                <tr><td>Colour method</td><td>{s.colourMethod ?? 'LiDAR sensor (device)'}</td></tr>
                <tr><td>Render resolution</td><td>{s.fboW} × {s.fboH} <span className="sbc-diag-dim">@ {s.dpr.toFixed(1)}×</span></td></tr>
              </tbody>
            </table>
            {(roomScan?.pointCloud || space?.id) && (
              <button
                className="sbc-diag-rebuild"
                onClick={async () => {
                  // Fast-path for raw-points mode: re-run photo projection on the
                  // existing point cloud without re-building the voxel pipeline.
                  const pts = pointCloudMeshRef.current
                  if (scanRenderMode === 'raw-points' && pts && space?.id) {
                    setMeshRebuilding(true)
                    try {
                      await upgradeProjectiveTexturing({
                        points: pts,
                        yOffset: yOffsetRef.current,
                        roomId: space.id,
                        diagRef: diagStatsRef,
                        onDiagUpdate: () => setDiagVersion(v => v + 1),
                        onProgress: reportRoomLoad,
                        maxFragTextures: threeRef.current?.renderer?.capabilities?.maxTextures,
                      })
                    } catch (err) {
                      console.warn('[rebuild] projection error:', err)
                      reportRoomLoad(100, 'Rebuild failed', false)
                    } finally {
                      setMeshRebuilding(false)
                    }
                    return
                  }
                  // Poisson GLB path: trigger server rebuild then reload
                  rebuildFromBufferRef.current = !!rawBufferRef.current
                  if (space?.id && scanRenderMode === 'poisson-glb') {
                    setMeshRebuilding(true)
                    try {
                      const jwt    = getJwt()
                      const device = getDeviceToken()
                      const headers = {
                        'X-Device-Token': device,
                        ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
                      }
                      await fetch(`${BASE}/api/rooms/${space.id}/mesh?rebuild=1`, { headers })
                    } finally {
                      setMeshRebuilding(false)
                    }
                  }
                  setMeshGeneration(prev => prev + 1)
                }}
                disabled={meshRebuilding}
              >
                {meshRebuilding ? 'Re-projecting…' : '↺ Rebuild from scan'}
              </button>
            )}
            {localLoad.active && (
              <div style={{ marginTop: 8 }}>
                <div className="sbc-diag-dim" style={{ marginBottom: 4 }}>{localLoad.phase || 'Rebuilding...'}</div>
                <div style={{ height: 6, borderRadius: 4, background: 'rgba(255,255,255,0.14)', overflow: 'hidden' }}>
                  <div style={{ width: `${Math.max(0, Math.min(100, localLoad.pct))}%`, height: '100%', background: 'linear-gradient(90deg,#5fb4ff,#4de2c1)' }} />
                </div>
              </div>
            )}
          </div>
        )
      })()}
    </div>
  )
}

// ── 2D crop-corner editor (overlay on top of 3D canvas) ──────────────────────
// Each corner's handle is offset diagonally outward so the finger/cursor
// never obscures the exact point being controlled.
// HANDLE_OFFSET, HANDLE_PAD, HANDLE_DIR, HANDLE_COLORS imported from ../utils/warpHandles

function CropOverlay({ surfaceId, space, onUpdateSurface, onClose }) {
  const surface = space.surfaces.find(s => s.id === surfaceId)
  const photo   = surface && space.photos.find(p => p.id === surface.photoId)
  const [corners,   setCorners]   = useState(surface?.corners ? JSON.parse(JSON.stringify(surface.corners)) : null)
  const [isWarping, setIsWarping] = useState(false)
  const svgRef = useRef(null)

  const W = 540
  const H = photo ? Math.round(W * photo.displayH / photo.displayW) : 360
  if (!surface || !photo || !corners) return null

  const toSVG   = ([fx, fy]) => [fx * W, fy * H]
  const fromSVG = (sx, sy)   => [sx / W, sy / H]
  const polyStr = ['tl','tr','br','bl'].map(k => toSVG(corners[k]).join(',')).join(' ')

  async function applyAndWarp() {
    onUpdateSurface(surfaceId, { corners, warpedDataUrl: null, stitchedDataUrl: null, inpaintDataUrl: null })
    setIsWarping(true)
    try {
      const url = await warpSurface(
        { ...surface, corners }, photo.dataUrl, photo.displayW, photo.displayH, warpPerspectiveAsync
      )
      onUpdateSurface(surfaceId, { corners, warpedDataUrl: url, stitchedDataUrl: null, inpaintDataUrl: null })
    } finally { setIsWarping(false); onClose() }
  }

  // svg.getScreenCTM().inverse() gives the exact screen→viewBox transform,
  // accounting for viewBox, preserveAspectRatio, zoom, and device pixel ratio.
  // No clamping here — handles intentionally live outside the viewBox bounds.
  function clientToSVG(clientX, clientY) {
    const svg = svgRef.current
    const pt  = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const p = pt.matrixTransform(svg.getScreenCTM().inverse())
    return [p.x, p.y]
  }

  // Use pointer capture so the drag stays locked to this element even when
  // the pointer leaves the SVG or the modal entirely — handles remain
  // grabbable no matter where they end up on screen.
  function startDrag(k, e) {
    e.stopPropagation()
    e.preventDefault()
    const captureEl = e.currentTarget
    captureEl.setPointerCapture(e.pointerId)

    const [dx, dy] = HANDLE_DIR[k]
    const ox = dx * HANDLE_OFFSET
    const oy = dy * HANDLE_OFFSET

    const onMove = (ev) => {
      if (!svgRef.current) return
      const [sx, sy] = clientToSVG(ev.clientX, ev.clientY)
      // Subtract the visual offset to get the actual corner position, then
      // clamp the corner (not the handle) to the image bounds.
      setCorners(prev => ({ ...prev, [k]: fromSVG(
        Math.max(0, Math.min(W, sx - ox)),
        Math.max(0, Math.min(H, sy - oy))
      )}))
    }

    const onUp = () => {
      captureEl.removeEventListener('pointermove',  onMove)
      captureEl.removeEventListener('pointerup',    onUp)
      captureEl.removeEventListener('pointercancel', onUp)
    }

    captureEl.addEventListener('pointermove',   onMove)
    captureEl.addEventListener('pointerup',     onUp)
    captureEl.addEventListener('pointercancel', onUp)
  }

  const clipId = `photo-clip-${surfaceId}`

  return (
    <div className="sbc-crop-overlay">
      <div className="sbc-crop-modal">
        <div className="sbc-crop-header">
          <span>Crop corners — {surface.name}</span>
          <button className="sbc-crop-close" onClick={onClose}>✕</button>
        </div>

        {/* The viewBox is padded on all sides by HANDLE_PAD so the diagonal
            offset handles always stay within the SVG element's own bounding
            box. This means browser hit-testing always finds the handle <g>,
            regardless of where the handle was last released. No overflow:visible
            tricks needed — handles are simply inside the SVG, always. */}
        <div className="sbc-crop-svg-wrap">
        <svg
          ref={svgRef}
          viewBox={`${-HANDLE_PAD} ${-HANDLE_PAD} ${W + 2*HANDLE_PAD} ${H + 2*HANDLE_PAD}`}
          className="sbc-crop-svg"
          style={{ display:'block', cursor:'crosshair', touchAction:'none', aspectRatio:`${W + 2*HANDLE_PAD}/${H + 2*HANDLE_PAD}` }}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x="0" y="0" width={W} height={H}/>
            </clipPath>
          </defs>

          {/* Photo + selection polygon clipped to image bounds */}
          <image href={photo.dataUrl} x="0" y="0" width={W} height={H}
            preserveAspectRatio="xMidYMid meet" clipPath={`url(#${clipId})`}/>
          <polygon points={polyStr}
            fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.8)" strokeWidth="1.5"
            strokeDasharray="7 4"
            clipPath={`url(#${clipId})`} style={{ pointerEvents:'none' }}/>

          {/* Corner handles — offset diagonally outward from each corner */}
          {['tl','tr','br','bl'].map(k => {
            const [hx, hy] = toSVG(corners[k])
            const [dx, dy] = HANDLE_DIR[k]
            const hpx = hx + dx * HANDLE_OFFSET   // handle centre X
            const hpy = hy + dy * HANDLE_OFFSET   // handle centre Y
            const CX = 6                           // crosshair arm length
            const color = HANDLE_COLORS[k]

            return (
              <g key={k}>
                {/* Black backing stroke for dashed connector */}
                <line x1={hx} y1={hy} x2={hpx} y2={hpy}
                  stroke="rgba(0,0,0,0.55)" strokeWidth="3"
                  style={{ pointerEvents:'none' }}/>

                {/* Colored dashed connector: actual corner → handle */}
                <line x1={hx} y1={hy} x2={hpx} y2={hpy}
                  stroke={color} strokeWidth="1.5" strokeDasharray="4 3"
                  style={{ pointerEvents:'none' }}/>

                {/* Crosshair at the exact corner point */}
                <line x1={hx-CX} y1={hy} x2={hx+CX} y2={hy}
                  stroke={color} strokeWidth="1.5" style={{ pointerEvents:'none' }}/>
                <line x1={hx} y1={hy-CX} x2={hx} y2={hy+CX}
                  stroke={color} strokeWidth="1.5" style={{ pointerEvents:'none' }}/>

                {/* Draggable hollow ring handle */}
                <g onPointerDown={e => startDrag(k, e)}
                   style={{ cursor:'grab', touchAction:'none' }}>
                  <circle cx={hpx} cy={hpy} r={26} fill="transparent"/>
                  <circle cx={hpx} cy={hpy} r={12}
                    fill="rgba(0,0,0,0.35)" stroke={color} strokeWidth="2"/>
                  <text x={hpx} y={hpy}
                    textAnchor="middle" dominantBaseline="central"
                    fontSize="8" fill={color} fontWeight="800" opacity="0.9"
                    style={{ pointerEvents:'none', userSelect:'none' }}>
                    {k.toUpperCase()}
                  </text>
                </g>
              </g>
            )
          })}
        </svg>
        </div>{/* .sbc-crop-svg-wrap */}

        <div className="sbc-crop-footer">
          <button className="sb-btn sb-btn--ghost" onClick={onClose}>Cancel</button>
          <button
            className={`sb-btn sb-btn--save${isWarping ? ' sb-btn--loading' : ''}`}
            onClick={applyAndWarp} disabled={isWarping}
          >
            {isWarping ? <><span className="btn-spinner"/>Warping…</> : 'Apply & Warp'}
          </button>
        </div>
      </div>
    </div>
  )
}
