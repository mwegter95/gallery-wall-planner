/**
 * seamBlendWorker.js — Classic Web Worker for seam blending.
 *
 * NO import / export statements — classic worker script, NOT an ES module.
 * Vite bundles it as an IIFE to avoid module-system interference with WASM.
 *
 * OpenCV loading:
 *   importScripts('/opencv.js') loads the static file from public/.
 *   The UMD wrapper sets root.cv = factory() where root = self in a worker,
 *   so self.cv becomes the initialisation Promise immediately after importScripts.
 *
 * Three-pass pipeline per connected pair (A.rightEdge ↔ B.leftEdge):
 *
 *   Pass 1a — Homography (wide zone, ~13 % of perpendicular dim)
 *     ORB keypoints → BFMatcher cross-check → RANSAC → 3×3 H
 *     Warps B's blend zone globally (perspective alignment, no colour change)
 *     Smoothstep blend: 100 % warped at seam edge, 0 % at blend boundary
 *
 *   Pass 1b — Dense optical flow (same wide zone, applied AFTER homography)
 *     cv.calcOpticalFlowFarneback on greyscale strips (normalised to FLOW_NORM²)
 *     Produces a per-pixel (dx, dy) displacement field
 *     Flow vectors are scaled back to native resolution and weighted with the
 *     same smoothstep as pass 1a — so pixels right at the seam are fully
 *     displaced to align with the neighbour, pixels far from the seam are
 *     untouched.  This is the "distort pixels to physically align at the edge"
 *     step — non-rigid, handles curved objects, lighting corners, etc.
 *     Applied symmetrically: A warps toward B, B warps toward A.
 *
 *   Pass 2 — Narrow pixel feather (SEAM_FEATHER_PX ≈ 12 px)
 *     Samples the single edge-pixel column of each post-warp surface and
 *     blends each toward the neighbour's edge colour.  Max 50 % — sub-
 *     perceptual, just removes any residual hard colour discontinuity.
 *
 * Uses OffscreenCanvas + createImageBitmap (no DOM access needed).
 */

// ── OpenCV loader ─────────────────────────────────────────────────────────────

let _cv = null

// Populated from the first 'stitch' message so the main thread controls the URL.
let _opencvUrl = null

async function loadCV() {
  if (_cv) return _cv
  try {
    // Use the URL provided by the main thread (knows the correct Vite base path).
    // Fall back to origin root only in unusual environments.
    const url = _opencvUrl || (self.location.origin + '/opencv.js')
    console.log('[seamBlendWorker] loadCV: importScripts', url)
    importScripts(url)
    const raw = self.cv
    if (raw == null) throw new Error('self.cv not set after importScripts')
    const cv = typeof raw.then === 'function'
      ? await Promise.race([
          raw,
          new Promise((_, rej) => setTimeout(() => rej(new Error('cv timeout')), 60_000)),
        ])
      : raw
    if (typeof cv?.Mat === 'undefined') throw new Error('cv.Mat missing')
    _cv = cv
    return cv
  } catch (err) {
    console.warn('[seamBlendWorker] OpenCV load failed:', err.message)
    return null
  }
}

// ── OffscreenCanvas helpers ───────────────────────────────────────────────────

async function dataUrlToCanvas(dataUrl) {
  const comma = dataUrl.indexOf(',')
  const mime  = dataUrl.slice(5, comma).replace(';base64', '')
  const bytes = Uint8Array.from(atob(dataUrl.slice(comma + 1)), c => c.charCodeAt(0))
  const bmp   = await createImageBitmap(new Blob([bytes], { type: mime }))
  const c     = new OffscreenCanvas(bmp.width, bmp.height)
  c.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0)
  bmp.close()
  return c
}

async function canvasToDataUrl(canvas) {
  const blob  = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.93 })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const CHUNK = 8192
  let b = ''
  for (let i = 0; i < bytes.length; i += CHUNK)
    b += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)))
  return 'data:image/jpeg;base64,' + btoa(b)
}

// ── Constants ─────────────────────────────────────────────────────────────────

const BLEND_FRACTION  = 0.13   // geometric warp zone (% of perpendicular dim)
const MAX_BLEND_PX    = 130    // px cap on warp zone
const SEAM_FEATHER_PX = 12     // narrow colour-feather (pass 2)
const ORB_FEATURES    = 800
const MIN_MATCHES     = 6
const NORM_SIZE       = 512    // normalised size for ORB homography
const FLOW_NORM       = 256    // normalised size for optical flow

// ── Geometry helpers ──────────────────────────────────────────────────────────

function stripRect(edge, cw, ch, blendW) {
  switch (edge) {
    case 'right':  return { x: cw - blendW, y: 0,           w: blendW, h: ch }
    case 'left':   return { x: 0,           y: 0,           w: blendW, h: ch }
    case 'bottom': return { x: 0,           y: ch - blendW, w: cw,     h: blendW }
    case 'top':    return { x: 0,           y: 0,           w: cw,     h: blendW }
    default:       return { x: 0,           y: 0,           w: blendW, h: ch }
  }
}

/** smoothstep weight: 1 at seam edge, 0 at blend boundary */
function seamWeight(edge, w, h, col, row, blendW) {
  let dist
  switch (edge) {
    case 'left':   dist = col;         break
    case 'right':  dist = w - 1 - col; break
    case 'top':    dist = row;         break
    case 'bottom': dist = h - 1 - row; break
    default: dist = 0
  }
  const t = Math.min(1, dist / blendW)
  return 1 - t * t * (3 - 2 * t)
}

// ── Pass 1a: ORB homography ───────────────────────────────────────────────────

function computeHomography(cv, idA, idB) {
  const del = (...m) => m.forEach(x => { try { x?.delete() } catch (_) {} })

  const toGray = (id) => {
    const mat = cv.matFromImageData(id), g = new cv.Mat(), r = new cv.Mat()
    cv.cvtColor(mat, g, cv.COLOR_RGBA2GRAY)
    cv.resize(g, r, new cv.Size(NORM_SIZE, NORM_SIZE))
    mat.delete(); g.delete(); return r
  }

  const rA = toGray(idA), rB = toGray(idB)
  const orb = new cv.ORB(ORB_FEATURES)
  const kpA = new cv.KeyPointVector(), kpB = new cv.KeyPointVector()
  const dA  = new cv.Mat(), dB = new cv.Mat(), none = new cv.Mat()
  orb.detectAndCompute(rA, none, kpA, dA)
  orb.detectAndCompute(rB, none, kpB, dB)

  if (dA.rows < MIN_MATCHES || dB.rows < MIN_MATCHES) {
    del(rA, rB, kpA, kpB, dA, dB, none); orb.delete(); return null
  }

  const bf = new cv.BFMatcher(cv.NORM_HAMMING, true)
  const mt = new cv.DMatchVector()
  bf.match(dA, dB, mt)

  const arr = []; for (let i = 0; i < mt.size(); i++) arr.push(mt.get(i))
  arr.sort((a, b) => a.distance - b.distance)
  const best = arr.slice(0, Math.min(80, arr.length))

  if (best.length < MIN_MATCHES) {
    del(rA, rB, kpA, kpB, dA, dB, none, mt); orb.delete(); bf.delete(); return null
  }

  const sp = [], dp = []
  for (const m of best) {
    sp.push(kpB.get(m.trainIdx).pt.x, kpB.get(m.trainIdx).pt.y)
    dp.push(kpA.get(m.queryIdx).pt.x, kpA.get(m.queryIdx).pt.y)
  }
  const sM = cv.matFromArray(best.length, 1, cv.CV_32FC2, sp)
  const dM = cv.matFromArray(best.length, 1, cv.CV_32FC2, dp)
  const inl = new cv.Mat()
  const H = cv.findHomography(sM, dM, cv.RANSAC, 3.0, inl, 2000, 0.995)

  let inliers = 0; for (let i = 0; i < inl.rows; i++) if (inl.data[i]) inliers++
  del(rA, rB, kpA, kpB, dA, dB, none, mt, sM, dM, inl); orb.delete(); bf.delete()

  if (inliers < MIN_MATCHES || !H || H.empty()) { try { H?.delete() } catch (_) {} ; return null }
  console.log(`[seamBlendWorker] homography: ${inliers} inliers`)
  return H
}

/** Apply H warp to ctx's blend zone with smoothstep blend (no colour change). */
function applyHomographyWarp(cv, ctx, edge, cw, ch, blendW, H) {
  const del = (...m) => m.forEach(x => { try { x?.delete() } catch (_) {} })
  const { x, y, w, h } = stripRect(edge, cw, ch, blendW)
  const orig = ctx.getImageData(x, y, w, h)
  const mat  = cv.matFromImageData(orig)
  const res  = new cv.Mat(), warp = new cv.Mat(), full = new cv.Mat()
  cv.resize(mat, res, new cv.Size(NORM_SIZE, NORM_SIZE))
  cv.warpPerspective(res, warp, H, new cv.Size(NORM_SIZE, NORM_SIZE), cv.INTER_LINEAR, cv.BORDER_REFLECT)
  cv.resize(warp, full, new cv.Size(w, h))
  const rgba = new cv.Mat()
  if      (full.channels() === 1) cv.cvtColor(full, rgba, cv.COLOR_GRAY2RGBA)
  else if (full.channels() === 3) cv.cvtColor(full, rgba, cv.COLOR_RGB2RGBA)
  else    full.copyTo(rgba)

  const wd = rgba.data, od = orig.data, out = new Uint8ClampedArray(od.length)
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const wt = seamWeight(edge, w, h, col, row, blendW)
      const i  = (row * w + col) * 4
      out[i]   = Math.round(od[i]   * (1-wt) + wd[i]   * wt)
      out[i+1] = Math.round(od[i+1] * (1-wt) + wd[i+1] * wt)
      out[i+2] = Math.round(od[i+2] * (1-wt) + wd[i+2] * wt)
      out[i+3] = 255
    }
  }
  ctx.putImageData(new ImageData(out, w, h), x, y)
  del(mat, res, warp, full, rgba)
}

// ── Pass 1b: Dense optical flow warp ─────────────────────────────────────────

/**
 * Compute Farneback dense flow from srcData → refData (normalised to FLOW_NORM²).
 * Returns a flat Float32Array of length FLOW_NORM*FLOW_NORM*2 — (dx,dy) per pixel.
 * Caller must delete the returned cv.Mat.
 */
function computeDenseFlow(cv, refData, srcData) {
  const del = (...m) => m.forEach(x => { try { x?.delete() } catch (_) {} })
  const ns  = new cv.Size(FLOW_NORM, FLOW_NORM)

  const toNormGray = (id) => {
    const m = cv.matFromImageData(id), g = new cv.Mat(), r = new cv.Mat()
    cv.cvtColor(m, g, cv.COLOR_RGBA2GRAY)
    cv.resize(g, r, ns)
    m.delete(); g.delete(); return r
  }

  const refN = toNormGray(refData)
  const srcN = toNormGray(srcData)
  const flow = new cv.Mat()
  // calcOpticalFlowFarneback(prev, next, flow, pyr_scale, levels, winsize, iters, poly_n, poly_sigma, flags)
  cv.calcOpticalFlowFarneback(srcN, refN, flow, 0.5, 4, 21, 5, 7, 1.5, 0)
  del(refN, srcN)
  return flow   // CV_32FC2, shape FLOW_NORM × FLOW_NORM
}

/**
 * Apply a dense flow warp to ctx's blend zone with distance-weighted smoothstep.
 * Both srcData (the strip ImageData to warp) and refData (the reference from the
 * other surface) are passed in so the flow is computed between them.
 *
 * @param {boolean} symmetric — if true, apply flow in both directions; if false,
 *        only warp srcData toward refData.  We call this twice (once per surface)
 *        so each wall is warped toward its neighbour.
 */
function applyFlowWarp(cv, ctx, edge, cw, ch, blendW, refData, srcData) {
  const del = (...m) => m.forEach(x => { try { x?.delete() } catch (_) {} })
  const { x, y, w, h } = stripRect(edge, cw, ch, blendW)

  const flow = computeDenseFlow(cv, refData, srcData)
  const fd   = flow.data32F   // Float32Array: [dx, dy, dx, dy, …] row-major, FLOW_NORM width

  // Scale factors: flow is in FLOW_NORM space, remap maps need native (w×h) coordinates
  const sx = w / FLOW_NORM
  const sy = h / FLOW_NORM

  const mxArr = new Float32Array(h * w)
  const myArr = new Float32Array(h * w)

  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      // Nearest-neighbour lookup in the flow field
      const fn_col = Math.min(FLOW_NORM - 1, Math.round(col / sx))
      const fn_row = Math.min(FLOW_NORM - 1, Math.round(row / sy))
      const fi     = (fn_row * FLOW_NORM + fn_col) * 2
      // Scale flow vector back to native pixel coordinates
      const dx = fd[fi]     * sx
      const dy = fd[fi + 1] * sy
      // Distance-based blend weight
      const wt = seamWeight(edge, w, h, col, row, blendW)
      const pi = row * w + col
      mxArr[pi] = col + dx * wt
      myArr[pi] = row + dy * wt
    }
  }

  const srcMat = cv.matFromImageData(srcData)
  const mapX   = cv.matFromArray(h, w, cv.CV_32FC1, mxArr)
  const mapY   = cv.matFromArray(h, w, cv.CV_32FC1, myArr)
  const warped = new cv.Mat()
  cv.remap(srcMat, warped, mapX, mapY, cv.INTER_LINEAR, cv.BORDER_REFLECT)

  const rgba = new cv.Mat()
  if      (warped.channels() === 1) cv.cvtColor(warped, rgba, cv.COLOR_GRAY2RGBA)
  else if (warped.channels() === 3) cv.cvtColor(warped, rgba, cv.COLOR_RGB2RGBA)
  else    warped.copyTo(rgba)

  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.data), w, h), x, y)
  del(flow, srcMat, mapX, mapY, warped, rgba)
}

// ── Pass 2: Narrow pixel feather ──────────────────────────────────────────────

function getSeamEdgePixels(ctx, edge, cw, ch) {
  const isVert = edge === 'left' || edge === 'right'
  let ex, ey, ew, eh
  switch (edge) {
    case 'right':  ex = cw-1; ey = 0;    ew = 1;  eh = ch; break
    case 'left':   ex = 0;    ey = 0;    ew = 1;  eh = ch; break
    case 'bottom': ex = 0;    ey = ch-1; ew = cw; eh = 1;  break
    case 'top':    ex = 0;    ey = 0;    ew = cw; eh = 1;  break
    default:       ex = 0;    ey = 0;    ew = 1;  eh = ch
  }
  const { data } = ctx.getImageData(ex, ey, ew, eh)
  const len = isVert ? ch : cw
  const r = new Float32Array(len * 3)
  for (let i = 0; i < len; i++) {
    r[i*3] = data[i*4]; r[i*3+1] = data[i*4+1]; r[i*3+2] = data[i*4+2]
  }
  return r
}

function resampleSeam(src, srcLen, dstLen) {
  if (srcLen === dstLen) return src
  const dst = new Float32Array(dstLen * 3)
  for (let i = 0; i < dstLen; i++) {
    const t = i / Math.max(1, dstLen-1), pos = t*(srcLen-1)
    const lo = Math.floor(pos), hi = Math.min(srcLen-1, lo+1), f = pos-lo
    for (let c = 0; c < 3; c++) dst[i*3+c] = src[lo*3+c]*(1-f) + src[hi*3+c]*f
  }
  return dst
}

function applyNarrowSeamFeather(ctx, edge, cw, ch, targetColors, seamLen) {
  const fp = Math.min(SEAM_FEATHER_PX, (edge === 'left' || edge === 'right') ? cw : ch)
  const { x, y, w, h } = stripRect(edge, cw, ch, fp)
  const iData = ctx.getImageData(x, y, w, h)
  const d = iData.data
  const isVert = edge === 'left' || edge === 'right'
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      let dist
      switch (edge) {
        case 'left':   dist = col;         break
        case 'right':  dist = w-1-col;     break
        case 'top':    dist = row;         break
        case 'bottom': dist = h-1-row;     break
        default: dist = 0
      }
      const wt = 0.5 * (1 - dist/fp)
      if (wt < 0.002) continue
      const si = Math.min(isVert ? row : col, seamLen-1) * 3
      const pi = (row*w+col)*4
      d[pi]   = Math.round(d[pi]   * (1-wt) + targetColors[si]   * wt)
      d[pi+1] = Math.round(d[pi+1] * (1-wt) + targetColors[si+1] * wt)
      d[pi+2] = Math.round(d[pi+2] * (1-wt) + targetColors[si+2] * wt)
    }
  }
  ctx.putImageData(iData, x, y)
}

// ── Main per-pair blend ───────────────────────────────────────────────────────

async function blendPair(cv, dataUrlA, edgeA, dataUrlB, edgeB) {
  const [cA, cB] = await Promise.all([dataUrlToCanvas(dataUrlA), dataUrlToCanvas(dataUrlB)])
  const ctxA = cA.getContext('2d', { willReadFrequently: true })
  const ctxB = cB.getContext('2d', { willReadFrequently: true })

  const isVert = edgeA === 'left' || edgeA === 'right'
  const blendW = Math.max(4, Math.min(MAX_BLEND_PX,
    Math.round((isVert ? Math.min(cA.width, cB.width) : Math.min(cA.height, cB.height)) * BLEND_FRACTION)))

  console.log(`[seamBlendWorker] blendPair: A(${cA.width}×${cA.height}) B(${cB.width}×${cB.height}) blendW=${blendW}`)

  if (cv) {
    // ── Pass 1a: ORB homography ──────────────────────────────────────────────
    try {
      const rA = stripRect(edgeA, cA.width, cA.height, blendW)
      const rB = stripRect(edgeB, cB.width, cB.height, blendW)
      const H  = computeHomography(cv,
        ctxA.getImageData(rA.x, rA.y, rA.w, rA.h),
        ctxB.getImageData(rB.x, rB.y, rB.w, rB.h))
      if (H) {
        try { applyHomographyWarp(cv, ctxB, edgeB, cB.width, cB.height, blendW, H) }
        finally { try { H.delete() } catch (_) {} }
      }
    } catch (err) {
      console.warn('[seamBlendWorker] homography failed:', err.message)
    }

    // ── Pass 1b: Dense optical flow (per-pixel distortion) ───────────────────
    // Apply symmetrically: warp B toward A, and warp A toward B.
    // Each side's flow is computed from its post-homography strip state.
    try {
      const rA  = stripRect(edgeA, cA.width, cA.height, blendW)
      const rB  = stripRect(edgeB, cB.width, cB.height, blendW)
      const idA = ctxA.getImageData(rA.x, rA.y, rA.w, rA.h)
      const idB = ctxB.getImageData(rB.x, rB.y, rB.w, rB.h)

      // Warp B toward A
      applyFlowWarp(cv, ctxB, edgeB, cB.width, cB.height, blendW, idA, idB)
      // Warp A toward B (use B's updated strip as the new reference)
      const idBnew = ctxB.getImageData(rB.x, rB.y, rB.w, rB.h)
      applyFlowWarp(cv, ctxA, edgeA, cA.width, cA.height, blendW, idBnew, idA)

      console.log('[seamBlendWorker] optical flow applied (symmetric)')
    } catch (err) {
      console.warn('[seamBlendWorker] optical flow failed:', err.message)
    }
  }

  // ── Pass 2: Narrow pixel feather ────────────────────────────────────────────
  const seamLenA = isVert ? cA.height : cA.width
  const seamLenB = isVert ? cB.height : cB.width
  const edgePixA = getSeamEdgePixels(ctxA, edgeA, cA.width, cA.height)
  const edgePixB = getSeamEdgePixels(ctxB, edgeB, cB.width, cB.height)
  applyNarrowSeamFeather(ctxA, edgeA, cA.width, cA.height, resampleSeam(edgePixB, seamLenB, seamLenA), seamLenA)
  applyNarrowSeamFeather(ctxB, edgeB, cB.width, cB.height, resampleSeam(edgePixA, seamLenA, seamLenB), seamLenB)

  return {
    dataUrlA: await canvasToDataUrl(cA),
    dataUrlB: await canvasToDataUrl(cB),
  }
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = async ({ data }) => {
  if (data.type !== 'stitch') return
  const { pairs, opencvUrl } = data
  if (opencvUrl) _opencvUrl = opencvUrl

  self.postMessage({ type: 'progress', pct: 2, status: 'Loading OpenCV…' })
  const cv = await loadCV()
  self.postMessage({
    type: 'progress', pct: 12,
    status: cv
      ? `Stitching ${pairs.length} seam${pairs.length !== 1 ? 's' : ''}…`
      : `Feathering ${pairs.length} seam${pairs.length !== 1 ? 's' : ''} (no OpenCV)…`,
  })

  const resultMap = {}

  for (let i = 0; i < pairs.length; i++) {
    const { idA, dataUrlA, edgeA, idB, dataUrlB, edgeB } = pairs[i]
    self.postMessage({ type: 'progress', pct: 12 + Math.round(i / pairs.length * 86), status: `Seam ${i+1} of ${pairs.length}…` })
    try {
      const result = await blendPair(cv, resultMap[idA] || dataUrlA, edgeA, resultMap[idB] || dataUrlB, edgeB)
      resultMap[idA] = result.dataUrlA
      resultMap[idB] = result.dataUrlB
    } catch (err) {
      console.error(`[seamBlendWorker] seam ${i+1} failed:`, err)
      self.postMessage({ type: 'warn', msg: `Seam ${i+1} failed: ${err.message}` })
    }
  }

  self.postMessage({ type: 'done', results: Object.entries(resultMap) })
}
