/**
 * seamBlendWorker.js — Web Worker for seam blending.
 *
 * Pipeline per seam pair:
 *   1. ORB feature matching + RANSAC homography (OpenCV WASM) — geometrically
 *      aligns content that spans the seam (panoramic-style).
 *   2. Per-scanline colour/tone correction — fades any remaining exposure or
 *      white-balance difference across a narrow blend zone at the cut line.
 *   3. Corner-crease shadow — a thin darkening gradient at the seam edge that
 *      mimics the natural shadow a real room corner casts.
 *
 * KEY FIX for deployed builds:
 *   OpenCV is loaded via a STATIC top-level import (not dynamic import()).
 *   Vite bundles static imports into the worker chunk during production build,
 *   so the module is always available.  Dynamic import() of large CJS packages
 *   can produce a separate chunk that the deployed worker cannot locate at
 *   runtime, causing an indefinite hang.
 *
 * Uses OffscreenCanvas + createImageBitmap (no DOM access needed).
 */

// Static import — Vite bundles this into the worker chunk at build time.
// In the worker module context `cvPromise` IS the Promise that resolves to cv.
import cvPromise from '@techstark/opencv-js'

// ── OpenCV loader ─────────────────────────────────────────────────────────────

let _cv = null

async function loadCV() {
  if (_cv) { console.log('[seamBlendWorker] loadCV: cached'); return _cv }
  console.log('[seamBlendWorker] loadCV: awaiting cv Promise…')
  try {
    // The static import resolves to the Promise exported by @techstark/opencv-js.
    // Awaiting it gives us the real cv object with cv.Mat, cv.ORB, etc.
    const cv = await Promise.race([
      cvPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('cv Promise timed out after 60 s')), 60_000)
      ),
    ])
    console.log('[seamBlendWorker] loadCV: resolved, cv.Mat =', typeof cv?.Mat, 'cv.ORB =', typeof cv?.ORB)
    if (typeof cv?.Mat === 'undefined') throw new Error('cv.Mat not found — unexpected module shape')
    _cv = cv
    return _cv
  } catch (err) {
    console.warn('[seamBlendWorker] loadCV failed:', err.message)
    return null
  }
}

// ── OffscreenCanvas helpers ───────────────────────────────────────────────────

async function dataUrlToCanvas(dataUrl) {
  const commaIdx = dataUrl.indexOf(',')
  const mime     = dataUrl.slice(5, commaIdx).replace(';base64', '')
  const b64      = dataUrl.slice(commaIdx + 1)
  const bytes    = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  const blob     = new Blob([bytes], { type: mime })
  const bmp      = await createImageBitmap(blob)
  const canvas   = new OffscreenCanvas(bmp.width, bmp.height)
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0)
  bmp.close()
  return canvas
}

async function canvasToDataUrl(canvas) {
  const blob  = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.93 })
  const ab    = await blob.arrayBuffer()
  const bytes = new Uint8Array(ab)
  const CHUNK = 8192
  let binary  = ''
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)))
  return 'data:image/jpeg;base64,' + btoa(binary)
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Blend zone for colour correction / shadow — kept tight so the only visible
// change is right at the physical corner, not a wide smear into the image.
const BLEND_FRACTION = 0.05
const MAX_BLEND_PX   = 48
const SAMPLE_PX      = 28      // wider sample → more stable per-scanline average
// ORB panoramic alignment
const ORB_FEATURES   = 800     // more features → better match on wall photos
const MIN_MATCHES    = 6
const NORM_SIZE      = 512     // higher res strip for ORB → more accurate H
// Corner-crease shadow
const SHADOW_PX      = 60
const SHADOW_ALPHA   = 0.30

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

// ── ORB geometric alignment ───────────────────────────────────────────────────

/**
 * Estimate a homography H that maps pixels in strip B into the coordinate
 * frame of strip A (RANSAC, NORM_SIZE normalisation).
 *
 * This is the panoramic-stitching step: if the sofa arm, doorframe, or any
 * structural element crosses the room corner, ORB finds corresponding points
 * on both walls and H corrects the perspective so they line up cleanly.
 *
 * Returns a cv.Mat (caller must .delete() it) or null on failure.
 */
function computeHomography(cv, imgDataA, imgDataB) {
  const del = (...m) => m.forEach(x => { try { x?.delete() } catch (_) {} })

  const toGray = (id) => {
    const mat = cv.matFromImageData(id)
    const g   = new cv.Mat()
    cv.cvtColor(mat, g, cv.COLOR_RGBA2GRAY)
    const r = new cv.Mat()
    cv.resize(g, r, new cv.Size(NORM_SIZE, NORM_SIZE))
    mat.delete(); g.delete()
    return r
  }

  const rA = toGray(imgDataA)
  const rB = toGray(imgDataB)

  const orb = new cv.ORB(ORB_FEATURES)
  const kpA = new cv.KeyPointVector(), kpB = new cv.KeyPointVector()
  const dA  = new cv.Mat(), dB = new cv.Mat()
  const none = new cv.Mat()
  orb.detectAndCompute(rA, none, kpA, dA)
  orb.detectAndCompute(rB, none, kpB, dB)

  console.log(`[seamBlendWorker] ORB: kpA=${kpA.size()} kpB=${kpB.size()} dA.rows=${dA.rows} dB.rows=${dB.rows}`)

  if (dA.rows < MIN_MATCHES || dB.rows < MIN_MATCHES) {
    del(rA, rB, kpA, kpB, dA, dB, none); orb.delete()
    console.log('[seamBlendWorker] ORB: too few descriptors, skipping')
    return null
  }

  const bf      = new cv.BFMatcher(cv.NORM_HAMMING, true)  // cross-check enabled
  const matches = new cv.DMatchVector()
  bf.match(dA, dB, matches)

  const arr = []
  for (let i = 0; i < matches.size(); i++) arr.push(matches.get(i))
  arr.sort((a, b) => a.distance - b.distance)
  const best = arr.slice(0, Math.min(80, arr.length))

  console.log(`[seamBlendWorker] ORB: ${arr.length} raw matches, using best ${best.length}`)

  if (best.length < MIN_MATCHES) {
    del(rA, rB, kpA, kpB, dA, dB, none, matches); orb.delete(); bf.delete()
    return null
  }

  const srcPts = [], dstPts = []
  for (const m of best) {
    srcPts.push(kpB.get(m.trainIdx).pt.x, kpB.get(m.trainIdx).pt.y)
    dstPts.push(kpA.get(m.queryIdx).pt.x, kpA.get(m.queryIdx).pt.y)
  }

  const srcMat    = cv.matFromArray(best.length, 1, cv.CV_32FC2, srcPts)
  const dstMat    = cv.matFromArray(best.length, 1, cv.CV_32FC2, dstPts)
  const inlierMat = new cv.Mat()
  const H         = cv.findHomography(srcMat, dstMat, cv.RANSAC, 3.0, inlierMat, 2000, 0.995)

  let inliers = 0
  for (let i = 0; i < inlierMat.rows; i++) if (inlierMat.data[i]) inliers++
  console.log(`[seamBlendWorker] ORB: ${inliers} RANSAC inliers`)

  del(rA, rB, kpA, kpB, dA, dB, none, matches, srcMat, dstMat, inlierMat)
  orb.delete(); bf.delete()

  if (inliers < MIN_MATCHES || !H || H.empty()) {
    if (H && !H.empty()) H.delete()
    console.log('[seamBlendWorker] ORB: not enough inliers, falling back to colour-only')
    return null
  }
  return H
}

/**
 * Warp a strip's ImageData using H (NORM_SIZE-normalised → native resolution).
 * Returns a new ImageData the same size as origData.
 */
function warpStrip(cv, H, origData) {
  const { width: sw, height: sh } = origData
  const del = (...m) => m.forEach(x => { try { x?.delete() } catch (_) {} })

  const mat     = cv.matFromImageData(origData)
  const resized = new cv.Mat()
  cv.resize(mat, resized, new cv.Size(NORM_SIZE, NORM_SIZE))
  const warped  = new cv.Mat()
  cv.warpPerspective(resized, warped, H,
    new cv.Size(NORM_SIZE, NORM_SIZE), cv.INTER_LINEAR, cv.BORDER_REFLECT)
  const full = new cv.Mat()
  cv.resize(warped, full, new cv.Size(sw, sh))
  const rgba = new cv.Mat()
  if      (full.channels() === 1) cv.cvtColor(full, rgba, cv.COLOR_GRAY2RGBA)
  else if (full.channels() === 3) cv.cvtColor(full, rgba, cv.COLOR_RGB2RGBA)
  else    full.copyTo(rgba)

  const result = new ImageData(new Uint8ClampedArray(rgba.data), sw, sh)
  del(mat, resized, warped, full, rgba)
  return result
}

/**
 * Feather-blend a warped strip back into the canvas blend zone.
 *
 * Weight: smoothstep 1→0 from the seam edge inward.
 * Only the blend zone pixels are overwritten; the rest of the image is untouched.
 */
function applyWarpedStrip(ctx, edge, cw, ch, blendW, origData, warpedData) {
  const { x, y, w, h } = stripRect(edge, cw, ch, blendW)
  const od = origData.data, wd = warpedData.data
  const bd = new Uint8ClampedArray(w * h * 4)

  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      let dist
      switch (edge) {
        case 'left':   dist = col;         break
        case 'right':  dist = w - 1 - col; break
        case 'top':    dist = row;         break
        case 'bottom': dist = h - 1 - row; break
        default:       dist = 0
      }
      const t  = Math.min(1, dist / blendW)
      const wt = 1 - t * t * (3 - 2 * t)   // smoothstep: 1 at seam, 0 at blendW
      const i  = (row * w + col) * 4
      bd[i]     = Math.round(od[i]     * (1 - wt) + wd[i]     * wt)
      bd[i + 1] = Math.round(od[i + 1] * (1 - wt) + wd[i + 1] * wt)
      bd[i + 2] = Math.round(od[i + 2] * (1 - wt) + wd[i + 2] * wt)
      bd[i + 3] = 255
    }
  }
  ctx.putImageData(new ImageData(bd, w, h), x, y)
}

// ── Colour correction helpers ─────────────────────────────────────────────────

function getSeamAvg(ctx, edge, cw, ch) {
  const sp    = Math.min(SAMPLE_PX, (edge === 'left' || edge === 'right') ? cw : ch)
  const { x, y, w, h } = stripRect(edge, cw, ch, sp)
  const { data } = ctx.getImageData(x, y, w, h)
  const isVert  = edge === 'left' || edge === 'right'
  const seamLen = isVert ? h : w
  const scanLen = isVert ? w : h
  const avg     = new Float32Array(seamLen * 3)
  for (let i = 0; i < seamLen; i++) {
    let r = 0, g = 0, b = 0
    for (let j = 0; j < scanLen; j++) {
      const pi = isVert ? (i * w + j) * 4 : (j * w + i) * 4
      r += data[pi]; g += data[pi + 1]; b += data[pi + 2]
    }
    avg[i * 3] = r / scanLen; avg[i * 3 + 1] = g / scanLen; avg[i * 3 + 2] = b / scanLen
  }
  return avg
}

function resampleSeam(src, srcLen, dstLen) {
  if (srcLen === dstLen) return src
  const dst = new Float32Array(dstLen * 3)
  for (let i = 0; i < dstLen; i++) {
    const t   = i / Math.max(1, dstLen - 1)
    const pos = t * (srcLen - 1)
    const lo  = Math.floor(pos), hi = Math.min(srcLen - 1, lo + 1)
    const f   = pos - lo
    for (let c = 0; c < 3; c++) dst[i * 3 + c] = src[lo * 3 + c] * (1 - f) + src[hi * 3 + c] * f
  }
  return dst
}

function applyColorCorrection(ctx, edge, cw, ch, blendW, seamAvg, targetSeam) {
  const isVert = edge === 'left' || edge === 'right'
  const { x: x0, y: y0, w: scanW, h: scanH } = stripRect(edge, cw, ch, blendW)
  const iData = ctx.getImageData(x0, y0, scanW, scanH)
  const d     = iData.data

  for (let row = 0; row < scanH; row++) {
    for (let col = 0; col < scanW; col++) {
      let dist
      switch (edge) {
        case 'right':  dist = scanW - 1 - col; break
        case 'left':   dist = col;              break
        case 'bottom': dist = scanH - 1 - row; break
        case 'top':    dist = row;              break
        default:       dist = 0
      }
      const t  = Math.min(1, dist / blendW)
      const wt = 1 - t * t * (3 - 2 * t)
      if (wt <= 0.002) continue
      const si = (isVert ? row : col) * 3
      const pi = (row * scanW + col) * 4
      // 60% additive + 40% multiplicative: handles both dark and bright pixels
      // without the hue drift of pure-additive or the near-black failure of pure-mult.
      for (let c = 0; c < 3; c++) {
        const src  = d[pi + c]
        const avg  = seamAvg[si + c]
        const tgt  = targetSeam[si + c]
        const add  = src + (tgt - avg) * wt
        const mult = avg > 4 ? src * (1 + ((tgt / avg) - 1) * wt) : add
        d[pi + c]  = Math.round(Math.min(255, Math.max(0, add * 0.6 + mult * 0.4)))
      }
    }
  }
  ctx.putImageData(iData, x0, y0)
}

/**
 * Paint a natural corner-crease shadow at the seam edge.
 * This reinforces the physical corner between two walls without any smearing.
 */
function addCornerShadow(ctx, edge, cw, ch) {
  const sw = Math.min(SHADOW_PX,
    Math.round((edge === 'left' || edge === 'right' ? cw : ch) * 0.08))

  let gx0, gy0, gx1, gy1, rx, ry, rw, rh
  switch (edge) {
    case 'right':  gx0=cw-sw; gy0=0;    gx1=cw;   gy1=0;   rx=cw-sw; ry=0;    rw=sw; rh=ch; break
    case 'left':   gx0=sw;    gy0=0;    gx1=0;    gy1=0;   rx=0;     ry=0;    rw=sw; rh=ch; break
    case 'bottom': gx0=0;     gy0=ch-sw;gx1=0;    gy1=ch;  rx=0;     ry=ch-sw;rw=cw; rh=sw; break
    case 'top':    gx0=0;     gy0=sw;   gx1=0;    gy1=0;   rx=0;     ry=0;    rw=cw; rh=sw; break
    default: return
  }

  const grad = ctx.createLinearGradient(gx0, gy0, gx1, gy1)
  grad.addColorStop(0,   'rgba(0,0,0,0)')
  grad.addColorStop(0.45, `rgba(0,0,0,${(SHADOW_ALPHA * 0.4).toFixed(3)})`)
  grad.addColorStop(1,   `rgba(0,0,0,${SHADOW_ALPHA.toFixed(3)})`)
  ctx.fillStyle = grad
  ctx.fillRect(rx, ry, rw, rh)
}

// ── Main per-pair blend ───────────────────────────────────────────────────────

async function blendPair(cv, dataUrlA, edgeA, dataUrlB, edgeB) {
  console.log('[seamBlendWorker] blendPair: decoding…')
  const [cA, cB] = await Promise.all([dataUrlToCanvas(dataUrlA), dataUrlToCanvas(dataUrlB)])
  console.log(`[seamBlendWorker] blendPair: A(${cA.width}×${cA.height}) B(${cB.width}×${cB.height})`)

  const ctxA = cA.getContext('2d', { willReadFrequently: true })
  const ctxB = cB.getContext('2d', { willReadFrequently: true })

  const isVert = edgeA === 'left' || edgeA === 'right'
  const perpA  = isVert ? cA.width : cA.height
  const perpB  = isVert ? cB.width : cB.height
  const blendW = Math.max(4, Math.min(MAX_BLEND_PX,
    Math.round(perpA * BLEND_FRACTION),
    Math.round(perpB * BLEND_FRACTION),
  ))
  console.log(`[seamBlendWorker] blendPair: blendW=${blendW} cv=${cv ? 'ready' : 'null'}`)

  // ── Pass 1: ORB geometric / panoramic alignment ────────────────────────────
  if (cv) {
    try {
      const rA  = stripRect(edgeA, cA.width, cA.height, blendW)
      const rB  = stripRect(edgeB, cB.width, cB.height, blendW)
      const idA = ctxA.getImageData(rA.x, rA.y, rA.w, rA.h)
      const idB = ctxB.getImageData(rB.x, rB.y, rB.w, rB.h)
      const H   = computeHomography(cv, idA, idB)
      if (H) {
        try {
          const origB   = ctxB.getImageData(rB.x, rB.y, rB.w, rB.h)
          const warpedB = warpStrip(cv, H, origB)
          applyWarpedStrip(ctxB, edgeB, cB.width, cB.height, blendW, origB, warpedB)
          console.log('[seamBlendWorker] ORB warp applied to B')
        } finally {
          try { H.delete() } catch (_) {}
        }
      }
    } catch (err) {
      console.warn('[seamBlendWorker] ORB pass failed, continuing with colour-only:', err.message)
    }
  }

  // ── Pass 2: Per-scanline colour/tone correction ────────────────────────────
  const seamLenA = isVert ? cA.height : cA.width
  const seamLenB = isVert ? cB.height : cB.width
  const avgA     = getSeamAvg(ctxA, edgeA, cA.width, cA.height)
  const avgB     = getSeamAvg(ctxB, edgeB, cB.width, cB.height)
  const rAvgB    = resampleSeam(avgB, seamLenB, seamLenA)
  const targetA  = new Float32Array(seamLenA * 3)
  for (let i = 0; i < seamLenA * 3; i++) targetA[i] = (avgA[i] + rAvgB[i]) / 2
  const targetB  = resampleSeam(targetA, seamLenA, seamLenB)

  applyColorCorrection(ctxA, edgeA, cA.width, cA.height, blendW, avgA, targetA)
  applyColorCorrection(ctxB, edgeB, cB.width, cB.height, blendW, avgB, targetB)

  // ── Pass 3: Corner-crease shadow ───────────────────────────────────────────
  addCornerShadow(ctxA, edgeA, cA.width, cA.height)
  addCornerShadow(ctxB, edgeB, cB.width, cB.height)

  return {
    dataUrlA: await canvasToDataUrl(cA),
    dataUrlB: await canvasToDataUrl(cB),
  }
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = async ({ data }) => {
  console.log('[seamBlendWorker] onmessage:', data.type)
  if (data.type !== 'stitch') return
  const { pairs } = data
  console.log('[seamBlendWorker] pairs:', pairs.length)

  self.postMessage({ type: 'progress', pct: 2, status: 'Loading OpenCV…' })
  const cv = await loadCV()
  self.postMessage({
    type: 'progress', pct: 12,
    status: cv
      ? `Stitching ${pairs.length} seam${pairs.length !== 1 ? 's' : ''}…`
      : `Blending ${pairs.length} seam${pairs.length !== 1 ? 's' : ''} (colour mode)…`,
  })

  const resultMap = {}

  for (let i = 0; i < pairs.length; i++) {
    const { idA, dataUrlA, edgeA, idB, dataUrlB, edgeB } = pairs[i]
    const pct = 12 + Math.round((i / pairs.length) * 86)
    self.postMessage({ type: 'progress', pct, status: `Seam ${i + 1} of ${pairs.length}…` })

    const srcA = resultMap[idA] || dataUrlA
    const srcB = resultMap[idB] || dataUrlB

    try {
      const result = await blendPair(cv, srcA, edgeA, srcB, edgeB)
      resultMap[idA] = result.dataUrlA
      resultMap[idB] = result.dataUrlB
    } catch (err) {
      console.error(`[seamBlendWorker] seam ${i + 1} FAILED:`, err)
      self.postMessage({ type: 'warn', msg: `Seam ${i + 1} failed: ${err.message}` })
    }
  }

  console.log('[seamBlendWorker] done')
  self.postMessage({ type: 'done', results: Object.entries(resultMap) })
}

