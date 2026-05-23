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
//
// Camera-space point (ARKit convention: camera looks along -Z):
//   cam = w2c * world
//
// Photo UV (matches SpaceBuilderCanvas:2026-2034):
//   if cam.z >= -0.05 → behind camera, discard.
//   dep = -cam.z
//   uvPhoto.x = (fx/fw) * cam.x / dep + (cx/fw)
//   uvPhoto.y = (fy/fh) * (-cam.y) / dep + (cy/fh)
//
// Weighting (per fragment — uses the actual view-ray from camera to the
// wall point, NOT the photo's constant forward direction):
//   – viewDotNormal: cos(angle) between -viewRay and wall normal.
//                    Near 1 = head-on hit (great sample).
//                    Near 0 = grazing (likely picking up content from a
//                             different surface — e.g. wall texture leaking
//                             onto the floor plane).
//   – facing^2  ⇒ heavily down-weight glancing rays.
//   – Discard when viewDotNormal < 0.15 (~81° off-normal) so wildly oblique
//     projections don't contribute at all.
//   – Photo edge feather (smoothstep): each photo's contribution fades to
//     zero in its outer 10 % so neighbouring photos blend smoothly instead
//     of producing hard footprint boundaries.
//   – 1/dist² distance falloff so close-up photos beat far-away ones.
//   – Per-photo color gain uGain (RGB) applied before accumulation so
//     differently-exposed photos line up to the scene's mean colour.
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
uniform vec3  uCamPosWorld;  // camera position in world space
uniform vec4  uKfwfh;        // (fx/fw, fy/fh, cx/fw, cy/fh)
uniform vec3  uGain;         // per-photo colour gain (RGB multipliers)
uniform sampler2D uPhoto;
uniform sampler2D uCoverage; // 1-channel mask: 1.0 where the plane has scan
                             //   coverage, 0.0 elsewhere.  Critical for partial
                             //   floors/ceilings where the user only scanned a
                             //   perimeter — without it the bake fills the whole
                             //   extent with whatever photos project there.

void main() {
  float a = mix(uUMin, uUMax, vUV.x);
  float b = mix(uVMin, uVMax, vUV.y);
  vec3 world = uUAxis * a + uVAxis * b - uNormal * uOffset;

  // Scan-coverage gate: where the original LiDAR scan never observed this
  // patch of the plane, we don't want to fabricate texture from oblique
  // photos that happen to project here.  Soft mask in [0,1] from a dilated
  // inlier rasterisation — pixels with low coverage drop their weight to 0
  // so the point cloud bleeds through.
  float coverage = texture2D(uCoverage, vUV).r;
  if (coverage < 0.05) discard;

  // Cull when the camera is on the BACK side of the wall plane.
  if (dot(uCamPosWorld, uNormal) + uOffset <= 0.0) discard;

  // Per-fragment view ray.  This is critical for the floor plane: from a
  // horizontal photo, the floor's view-ray is nearly parallel to the floor
  // and we want to discard those rays (otherwise we'd paint wall pixels
  // onto the floor plane where the photo's upper pixels reproject).
  vec3 viewRay = world - uCamPosWorld;
  float dist   = length(viewRay);
  vec3 viewN   = viewRay / max(dist, 1e-6);
  float viewDotNormal = max(0.0, -dot(viewN, uNormal));
  if (viewDotNormal < 0.15) discard;     // grazing angle — discard

  vec4 cam4 = uW2C * vec4(world, 1.0);
  vec3 cam  = cam4.xyz;
  if (cam.z >= -0.05) discard;           // behind camera
  float dep = -cam.z;

  float photoU = uKfwfh.x * cam.x / dep + uKfwfh.z;
  float photoV = uKfwfh.y * (-cam.y) / dep + uKfwfh.w;
  if (photoU < 0.0 || photoU > 1.0 || photoV < 0.0 || photoV > 1.0) discard;

  vec3 color = texture2D(uPhoto, vec2(photoU, photoV)).rgb * uGain;

  // Edge feather (10 % border falloff per axis) — smooths handoff between
  // adjacent photos that overlap on the same wall.
  float fU = smoothstep(0.0, 0.10, photoU) * (1.0 - smoothstep(0.90, 1.0, photoU));
  float fV = smoothstep(0.0, 0.10, photoV) * (1.0 - smoothstep(0.90, 1.0, photoV));

  float facing = viewDotNormal * viewDotNormal;   // per-fragment, not per-photo
  float distW  = 1.0 / max(dist * dist, 0.25);
  float weight = facing * distW * fU * fV * coverage;

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

// ── Photometric normalisation ─────────────────────────────────────────────────

/**
 * Compute per-photo RGB gains so all snapshots aim at a shared scene mean.
 * Mitigates exposure / white-balance drift between captures so the bake's
 * blended result doesn't show visible "patchwork" tone shifts across photos
 * covering the same wall.
 *
 * Returns parallel-to-textures array of { r, g, b } multipliers in roughly
 * [0.7, 1.4] (clamped so a few outlier-content photos can't push extreme
 * shifts onto the rest of the scene).
 */
export function computeColorGains(textures) {
  // Per-photo mean — sample ~50k pixels per photo for speed
  const means = textures.map(td => {
    if (!td?.pixels || !td.pw || !td.ph) return null
    const px = td.pixels
    const n  = td.pw * td.ph
    const stride = Math.max(1, Math.floor(n / 50000))
    let sR = 0, sG = 0, sB = 0, count = 0
    for (let i = 0; i < n; i += stride) {
      const off = i * 4
      sR += px[off]; sG += px[off + 1]; sB += px[off + 2]
      count++
    }
    if (!count) return null
    return { r: sR / count, g: sG / count, b: sB / count }
  })

  const valid = means.filter(m => m)
  if (!valid.length) return textures.map(() => ({ r: 1, g: 1, b: 1 }))

  // Scene mean = average of per-photo means
  let sR = 0, sG = 0, sB = 0
  for (const m of valid) { sR += m.r; sG += m.g; sB += m.b }
  const gm = { r: sR / valid.length, g: sG / valid.length, b: sB / valid.length }

  // Per-photo gain (clamped softly — content-driven mean differences are real,
  // not just exposure; we only want to nudge, not over-correct).
  const GAIN_MIN = 0.7
  const GAIN_MAX = 1.4
  return means.map(m => {
    if (!m) return { r: 1, g: 1, b: 1 }
    return {
      r: Math.max(GAIN_MIN, Math.min(GAIN_MAX, m.r > 0 ? gm.r / m.r : 1)),
      g: Math.max(GAIN_MIN, Math.min(GAIN_MAX, m.g > 0 ? gm.g / m.g : 1)),
      b: Math.max(GAIN_MIN, Math.min(GAIN_MAX, m.b > 0 ? gm.b / m.b : 1)),
    }
  })
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
async function bakePlane({ plane, snaps, textures, gains, renderer }) {
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

  // Build coverage DataTexture from the worker's inlier raster mask.  This
  // is sampled by the bake shader to gate out unscanned regions.  We expand
  // the single-channel mask into RGBA so we don't need WebGL2-only formats.
  const cW = plane.coverageW || 1
  const cH = plane.coverageH || 1
  const rgba = new Uint8Array(cW * cH * 4)
  const src  = plane.coverage || new Uint8Array(cW * cH)
  for (let i = 0; i < src.length; i++) {
    const v = src[i]
    rgba[i*4] = v; rgba[i*4+1] = v; rgba[i*4+2] = v; rgba[i*4+3] = 255
  }
  const coverageTex = new THREE.DataTexture(rgba, cW, cH, THREE.RGBAFormat, THREE.UnsignedByteType)
  coverageTex.minFilter = THREE.LinearFilter
  coverageTex.magFilter = THREE.LinearFilter
  coverageTex.wrapS = THREE.ClampToEdgeWrapping
  coverageTex.wrapT = THREE.ClampToEdgeWrapping
  coverageTex.needsUpdate = true

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
      uKfwfh:       { value: new THREE.Vector4() },
      uGain:        { value: new THREE.Vector3(1, 1, 1) },
      uPhoto:       { value: null },
      uCoverage:    { value: coverageTex },
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
    accumMat.uniforms.uKfwfh.value.set(K[0] / fw, K[4] / fh, K[6] / fw, K[7] / fh)
    const g = gains[si] || { r: 1, g: 1, b: 1 }
    accumMat.uniforms.uGain.value.set(g.r, g.g, g.b)
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
  coverageTex.dispose()

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

  // Pre-compute per-photo colour gains once (used by every plane's bake).
  onProgress?.(33, 'Computing photo color balance')
  const gains = computeColorGains(textures)
  console.info('[wpa12] Photo gains:', gains.map(g =>
    `[${g.r.toFixed(2)},${g.g.toFixed(2)},${g.b.toFixed(2)}]`).join(' '))

  // Phase B: WebGL bake per plane
  const walls = []
  for (let pi = 0; pi < planes.length; pi++) {
    if (signal?.aborted) break
    const plane = planes[pi]
    onProgress?.(35 + 60 * pi / planes.length, `Baking ${plane.type} ${pi+1}/${planes.length}`)

    try {
      const baked = await bakePlane({ plane, snaps, textures, gains, renderer })
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
