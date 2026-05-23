/**
 * wallBaker.js — WPA-12 orchestrator.
 *
 * Pipeline:
 *   1.  Spawn wallBakeWorker (RANSAC plane detection on the deduplicated cloud).
 *   2.  Fetch + load all snapshot textures via the existing loadSnapshotTex
 *       helper (auth headers, BASE prefix, canvas resize, mipmaps).
 *   3.  For each detected plane (floor / ceiling / 1-8 walls), run a WebGL
 *       projective bake: each photo is rendered into a wall-aligned half-float
 *       framebuffer with additive blending, weighted by angle and depth.
 *       A second normalization pass divides by accumulated weight to produce
 *       the final RGBA texture.
 *   4.  Read back as ImageData → PNG blob (for IndexedDB) + THREE.CanvasTexture
 *       (for immediate rendering).
 *   5.  Return walls + planes so SpaceBuilderCanvas can mount mesh quads.
 *
 * Uses the main thread's THREE.WebGLRenderer (WebGL can't run in workers
 * without OffscreenCanvas, which has patchy support).  The renderer is briefly
 * borrowed for bake passes — we save/restore its render target around each
 * bake.
 */

import * as THREE from 'three'

/**
 * Invert a column-major c2w 4×4 (16-float array) to w2c, returning a new array.
 * Mirrors c2wToW2c in SpaceBuilderCanvas — kept inline so this module has no
 * dependency on the component file.
 */
function c2wToW2c(c2w) {
  return new THREE.Matrix4().fromArray(c2w).invert().toArray()
}

// ── Shader source ─────────────────────────────────────────────────────────────

// Vertex shader: full-screen quad in NDC, no transform needed.  The fragment
// shader maps NDC → wall-local UV → world point on the wall plane → camera UV.
const BAKE_VERT = /* glsl */`
varying vec2 vUV;
void main() {
  vUV = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

// Fragment shader: reproject this wall-pixel into the photo and sample.
//
// World point on the wall plane:
//   World = a*uAxis + b*vAxis - offset*normal
//     where a = mix(uMin, uMax, vUV.x), b = mix(vMin, vMax, vUV.y).
//   (uMin/uMax/vMin/vMax are ABSOLUTE projections returned by the worker:
//   uMin = min(point . uAxis) across all inliers.  Plane equation:
//   normal · P + offset = 0, so P · normal = -offset for P on the plane.)
//
// Camera-space point (ARKit convention: camera looks along -Z):
//   cam = w2c * world  (w2c is the world-to-camera matrix)
//
// Photo UV (matches existing projective code at SpaceBuilderCanvas:2026-2034):
//   if cam.z >= -0.05 → behind camera, discard.
//   dep = -cam.z
//   uvPhoto.x = (fx/fw) * cam.x / dep + (cx/fw)
//   uvPhoto.y = (fy/fh) * (-cam.y) / dep + (cy/fh)
//
// Weighting:
//   – angle term:  max(0, dot(-cam_forward, wall_normal))^2
//                  (wall is facing the photo — perpendicular = best)
//   – distance:    1 / max(dep², 0.25)  (close cameras win)
//   – bounds:      uv ∈ [0, 1]
//   – facing:      camera must be in front of the plane (on +normal side)
//
// Output: vec4(color * weight, weight).  Sums across photos via gl.ONE/gl.ONE.
const BAKE_FRAG = /* glsl */`
precision highp float;

varying vec2 vUV;

uniform vec3  uUAxis;
uniform vec3  uVAxis;
uniform vec3  uNormal;
uniform float uOffset;       // plane equation d  (normal · P + d = 0)
uniform float uUMin;
uniform float uUMax;
uniform float uVMin;
uniform float uVMax;

uniform mat4  uW2C;          // world-to-camera (column-major as THREE stores)
uniform vec3  uCamPosWorld;  // camera position in world space (for facing check)
uniform vec3  uCamForward;   // camera forward in world space = -col2(c2w)
uniform vec4  uKfwfh;        // (fx/fw, fy/fh, cx/fw, cy/fh)
uniform sampler2D uPhoto;

void main() {
  float a = mix(uUMin, uUMax, vUV.x);
  float b = mix(uVMin, uVMax, vUV.y);
  vec3 world = uUAxis * a + uVAxis * b - uNormal * uOffset;

  // Cull when the camera is on the BACK side of the wall plane.
  // Signed distance of camera to plane: normal · camPos + offset.
  if (dot(uCamPosWorld, uNormal) + uOffset <= 0.0) discard;

  vec4 cam4 = uW2C * vec4(world, 1.0);
  vec3 cam = cam4.xyz;

  if (cam.z >= -0.05) discard;          // behind camera
  float dep = -cam.z;

  float photoU = uKfwfh.x * cam.x / dep + uKfwfh.z;
  float photoV = uKfwfh.y * (-cam.y) / dep + uKfwfh.w;
  if (photoU < 0.0 || photoU > 1.0 || photoV < 0.0 || photoV > 1.0) discard;

  vec3 color = texture2D(uPhoto, vec2(photoU, photoV)).rgb;

  // Photo's camera shoots best when its forward direction points INTO the
  // wall — i.e., opposite the wall's outward normal.  Score: how anti-aligned
  // the camera forward is with the wall normal.
  float facing = max(0.0, -dot(uCamForward, uNormal));   // 1 = perpendicular hit
  facing = facing * facing;                              // emphasise good hits

  float distW = 1.0 / max(dep * dep, 0.25);
  float weight = facing * distW;

  // Output additively-blended (color * weight) in RGB, weight in A.
  gl_FragColor = vec4(color * weight, weight);
}
`

// Normalization pass: divides accumulated RGB by accumulated alpha.
// Reads from the accumulator texture, writes normalized RGBA (alpha=1 where
// covered, alpha=0 where no photo contributed).
const NORM_FRAG = /* glsl */`
precision highp float;
varying vec2 vUV;
uniform sampler2D uAccum;
uniform float uAlphaThresh;

void main() {
  vec4 acc = texture2D(uAccum, vUV);
  if (acc.a < uAlphaThresh) {
    gl_FragColor = vec4(0.0);              // uncovered → transparent
  } else {
    gl_FragColor = vec4(acc.rgb / acc.a, 1.0);
  }
}
`

// ── K normalization (same logic as the projective texture path) ───────────────

function normalizeK(kRaw, fh) {
  if (!Array.isArray(kRaw) || kRaw.length === 0) return null
  const k = kRaw.map(Number)
  if (k.length >= 12 && !(k[4] > 0) && (k[5] > 0) && (k[8] > 0)) {
    return [k[0], k[1], k[2], k[4], k[5], k[6], k[8], k[9], k[10]]
  }
  if (k.length >= 9 && !(k[4] > 0) && (k[5] > 0) && (k[8] > 0)) {
    return [k[0], k[1], k[2], 0, k[5], k[6], k[8], fh > 0 ? fh * 0.5 : 0, 1]
  }
  return k
}

// ── Worker driver ─────────────────────────────────────────────────────────────

function runRansacWorker({ positions, vertexCount, bounds, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./wallBakeWorker.js', import.meta.url))
    let resolved = false
    const finish = (fn, arg) => {
      if (resolved) return
      resolved = true
      worker.terminate()
      fn(arg)
    }
    if (signal) {
      signal.addEventListener('abort', () => finish(reject, new Error('aborted')))
    }
    worker.onmessage = (e) => {
      const m = e.data
      if (m.type === 'progress') {
        onProgress?.(m.pct * 0.3, m.phase)  // RANSAC = first 30% of bake
      } else if (m.type === 'done') {
        finish(resolve, m.planes)
      } else if (m.type === 'error') {
        finish(reject, new Error(m.message))
      }
    }
    worker.onerror = (e) => finish(reject, new Error(e.message || 'worker crashed'))

    // Transfer the positions buffer (zero-copy)
    const copy = new Float32Array(positions.subarray(0, vertexCount * 3))
    worker.postMessage({
      type: 'detect',
      pts: copy,
      count: vertexCount,
      bounds,
      thresh: 0.05,
      minFrac: 0.02,
      maxWalls: 8,
    }, [copy.buffer])
  })
}

// ── Per-plane WebGL bake ──────────────────────────────────────────────────────

const PX_PER_METER = 256
const MAX_PX       = 2048
const MIN_PX       = 64

/**
 * Bake all photos into a single texture for one plane.
 *
 * @param plane      detected plane from worker
 * @param snaps      normalized snapshot metadata (K is canonical 9-float)
 * @param textures   array of { tex } from loadSnapshotTex (parallel to snaps)
 * @param renderer   THREE.WebGLRenderer (main thread)
 * @returns          { canvas, width, height, pngBlob? }
 */
async function bakePlane({ plane, snaps, textures, renderer }) {
  const w = plane.uMax - plane.uMin
  const h = plane.vMax - plane.vMin
  if (w < 0.1 || h < 0.1) return null

  const resW = Math.max(MIN_PX, Math.min(MAX_PX, Math.round(w * PX_PER_METER)))
  const resH = Math.max(MIN_PX, Math.min(MAX_PX, Math.round(h * PX_PER_METER)))

  // Half-float accumulator if supported, else fall back to Uint8 (lower quality)
  const gl = renderer.getContext()
  let halfFloatSupported = false
  try {
    halfFloatSupported = renderer.capabilities.isWebGL2
      || !!gl.getExtension('EXT_color_buffer_half_float')
  } catch { halfFloatSupported = false }

  const accumRT = new THREE.WebGLRenderTarget(resW, resH, {
    minFilter:   THREE.LinearFilter,
    magFilter:   THREE.LinearFilter,
    format:      THREE.RGBAFormat,
    type:        halfFloatSupported ? THREE.HalfFloatType : THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  })

  // Save renderer state we're about to mutate
  const prevRT             = renderer.getRenderTarget()
  const prevAutoClear      = renderer.autoClear
  const prevClearColor     = renderer.getClearColor(new THREE.Color())
  const prevClearAlpha     = renderer.getClearAlpha()

  // Set up the bake scene/camera
  const bakeScene  = new THREE.Scene()
  const bakeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  const accumMat = new THREE.ShaderMaterial({
    vertexShader:   BAKE_VERT,
    fragmentShader: BAKE_FRAG,
    uniforms: {
      uUAxis:       { value: new THREE.Vector3().fromArray(plane.uAxis) },
      uVAxis:       { value: new THREE.Vector3().fromArray(plane.vAxis) },
      uNormal:      { value: new THREE.Vector3().fromArray(plane.normal) },
      uOffset:      { value: plane.offset },
      uUMin:        { value: plane.uMin },
      uUMax:        { value: plane.uMax },
      uVMin:        { value: plane.vMin },
      uVMax:        { value: plane.vMax },
      uW2C:         { value: new THREE.Matrix4() },
      uCamPosWorld: { value: new THREE.Vector3() },
      uCamForward:  { value: new THREE.Vector3() },
      uKfwfh:       { value: new THREE.Vector4() },
      uPhoto:       { value: null },
    },
    transparent:  true,
    depthTest:    false,
    depthWrite:   false,
    blending:     THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc:     THREE.OneFactor,
    blendDst:     THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
  })

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), accumMat)
  bakeScene.add(quad)

  // Clear accumulator
  renderer.setRenderTarget(accumRT)
  renderer.autoClear = false
  renderer.setClearColor(0x000000, 0)
  renderer.clear(true, false, false)

  // Render each photo additively into the accumulator
  for (let si = 0; si < snaps.length; si++) {
    const snap = snaps[si]
    const tex  = textures[si]?.tex
    if (!tex) continue

    const K  = snap.K
    const fw = snap.fw
    const fh = snap.fh
    if (!K || !(K[0] > 0) || !(fw > 0) || !(fh > 0)) continue

    // w2c (column-major from c2w invert) — pass directly into Three's Matrix4
    const w2c = c2wToW2c(snap.c2w)
    accumMat.uniforms.uW2C.value.fromArray(w2c)
    accumMat.uniforms.uCamPosWorld.value.set(snap.c2w[12], snap.c2w[13], snap.c2w[14])
    // Camera forward = -col2(c2w).  Column 2 of column-major c2w = [8..10].
    accumMat.uniforms.uCamForward.value.set(-snap.c2w[8], -snap.c2w[9], -snap.c2w[10])
    accumMat.uniforms.uKfwfh.value.set(K[0] / fw, K[4] / fh, K[6] / fw, K[7] / fh)
    accumMat.uniforms.uPhoto.value = tex
    accumMat.uniformsNeedUpdate = true

    renderer.render(bakeScene, bakeCamera)
  }

  // ── Normalize pass: read accumulator, divide RGB by alpha, write a final
  //    Uint8 RGBA buffer we can wrap in a canvas.
  const normMat = new THREE.ShaderMaterial({
    vertexShader:   BAKE_VERT,
    fragmentShader: NORM_FRAG,
    uniforms: {
      uAccum:       { value: accumRT.texture },
      uAlphaThresh: { value: 1e-4 },
    },
    transparent: true,
    depthTest:   false,
    depthWrite:  false,
  })
  quad.material = normMat

  const finalRT = new THREE.WebGLRenderTarget(resW, resH, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format:    THREE.RGBAFormat,
    type:      THREE.UnsignedByteType,
    depthBuffer: false,
  })
  renderer.setRenderTarget(finalRT)
  renderer.clear(true, false, false)
  renderer.render(bakeScene, bakeCamera)

  // Read back
  const pixels = new Uint8Array(resW * resH * 4)
  renderer.readRenderTargetPixels(finalRT, 0, 0, resW, resH, pixels)

  // Wrap in a canvas (Y is flipped: WebGL has origin at bottom-left, canvas at top-left)
  const canvas = document.createElement('canvas')
  canvas.width  = resW
  canvas.height = resH
  const ctx     = canvas.getContext('2d')
  const imgData = ctx.createImageData(resW, resH)
  // Flip Y on copy
  for (let y = 0; y < resH; y++) {
    const srcRow = (resH - 1 - y) * resW * 4
    const dstRow = y * resW * 4
    imgData.data.set(pixels.subarray(srcRow, srcRow + resW * 4), dstRow)
  }
  ctx.putImageData(imgData, 0, 0)

  // Cleanup
  quad.geometry.dispose()
  accumMat.dispose()
  normMat.dispose()
  accumRT.dispose()
  finalRT.dispose()

  // Restore renderer state
  renderer.setRenderTarget(prevRT)
  renderer.autoClear = prevAutoClear
  renderer.setClearColor(prevClearColor, prevClearAlpha)

  // Encode as Blob for IndexedDB caching (best-effort)
  let pngBlob = null
  try {
    pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
  } catch { pngBlob = null }

  return { canvas, width: resW, height: resH, pngBlob }
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Run the full WPA-12 pipeline.  Returns { walls, planes } where each wall has
 * { plane, canvas, width, height, pngBlob }.  Caller is responsible for
 * mounting the canvases as THREE.CanvasTextures on PlaneGeometry meshes.
 */
export async function bakeWallsFromScan({
  positions,
  vertexCount,
  bounds,
  roomId,
  snaps,            // normalized snapshot metadata + .K already normalized
  textures,         // [{ tex, ... }] parallel to snaps
  renderer,
  onProgress,
  signal,
}) {
  onProgress?.(2, 'Starting wall detection')

  // Phase A: RANSAC
  const planes = await runRansacWorker({
    positions, vertexCount, bounds, onProgress, signal,
  })
  if (!planes?.length) {
    onProgress?.(100, 'No planes detected', false)
    return { walls: [], planes: [] }
  }
  console.info(`[wpa12] RANSAC found ${planes.length} planes (${planes.map(p => p.type).join(', ')})`)

  // Phase B: WebGL bake per plane
  const walls = []
  for (let pi = 0; pi < planes.length; pi++) {
    if (signal?.aborted) break
    const plane = planes[pi]
    onProgress?.(35 + 60 * pi / planes.length, `Baking ${plane.type} ${pi+1}/${planes.length}`)

    try {
      const baked = await bakePlane({ plane, snaps, textures, renderer })
      if (baked) walls.push({ plane, ...baked })
    } catch (err) {
      console.warn(`[wpa12] bakePlane failed for ${plane.type}:`, err)
    }
  }

  onProgress?.(100, `Baked ${walls.length}/${planes.length} surfaces`)
  return { walls, planes }
}

// ── Re-hydrate cached walls (PNG blobs → canvases) ────────────────────────────

export async function hydrateCachedWalls(cachedWalls) {
  const walls = []
  for (const cw of cachedWalls) {
    if (!cw.pngBlob) continue
    try {
      const img = await blobToImage(cw.pngBlob)
      const canvas = document.createElement('canvas')
      canvas.width  = cw.width
      canvas.height = cw.height
      canvas.getContext('2d').drawImage(img, 0, 0)
      walls.push({
        plane:  cw.plane,
        canvas,
        width:  cw.width,
        height: cw.height,
        pngBlob: cw.pngBlob,
      })
    } catch (err) {
      console.warn('[wpa12] failed to hydrate cached wall:', err)
    }
  }
  return walls
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e) }
    img.src = url
  })
}

export { normalizeK }
