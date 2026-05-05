/**
 * seamBlend.js — Smart seam stitching for adjacent wall surfaces.
 *
 * Two-pass pipeline per connected pair (A.rightEdge ↔ B.leftEdge):
 *
 *   Pass 1 — Geometric alignment  (wide zone, ~13 % of texture width)
 *     • ORB keypoint detection + BFMatcher cross-check on both edge strips
 *     • RANSAC homography H (B-strip coords → A-strip coords)
 *     • Warp B's blend zone using H (content re-alignment, NO colour change)
 *     • Smoothstep blend: 100 % warped at seam edge, 0 % at boundary
 *     • Falls back silently if < MIN_MATCHES inliers found
 *
 *   Pass 2 — Narrow pixel feather  (SEAM_FEATHER_PX ≈ 12 px)
 *     • Sample the single-pixel-wide edge column of each surface
 *     • Blend each surface toward the neighbour's actual edge colour
 *     • Linear fade over 12 px — invisible but removes any remaining
 *       hard colour discontinuity at the seam
 *     • MAX blend strength 50 % so it never "averages in" a visible band
 *
 * Why this avoids the "shadow in the corner" problem:
 *   The previous version averaged colours over a 13 % wide gradient band.
 *   If one wall had a dark corner and the other a bright one the 13 % zone
 *   produced a visible grey wedge / shadow.  This version does colour work
 *   in only 12 px, which is sub-perceptual; all the heavy lifting is done
 *   by the geometric warp which rearranges pixels without changing them.
 */

// ── OpenCV.js lazy loader ─────────────────────────────────────────────────────
let _cv = null
let _cvPromise = null

async function getCv() {
  if (_cv) return _cv
  if (_cvPromise) return _cvPromise
  _cvPromise = (async () => {
    const mod = await import('@techstark/opencv-js')
    const raw = mod.default ?? mod
    const cv  = typeof raw.then === 'function' ? await raw : raw
    // Wait for WASM runtime (cv.Mat signals readiness)
    if (typeof cv.Mat === 'undefined') {
      await new Promise(resolve => { cv.onRuntimeInitialized = resolve })
    }
    _cv = cv
    return cv
  })()
  return _cvPromise
}

// ── Yield helper — keeps the browser responsive between heavy WASM calls ──────
const yieldToUI = () => new Promise(r => setTimeout(r, 0))

// ── Constants ─────────────────────────────────────────────────────────────────
const BLEND_FRACTION   = 0.13  // geometric warp zone width (% of perpendicular dim)
const MAX_BLEND_PX     = 130   // px cap on warp zone
const SEAM_FEATHER_PX  = 12    // narrow colour-feather width
const ORB_FEATURES     = 600
const MIN_MATCHES      = 8

// ── Low-level helpers ─────────────────────────────────────────────────────────

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload  = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

function imgToCanvas(img) {
  const c = Object.assign(document.createElement('canvas'), {
    width: img.naturalWidth, height: img.naturalHeight,
  })
  c.getContext('2d').drawImage(img, 0, 0)
  return c
}

/** { x, y, w, h } of the blend zone strip for the given edge + width. */
function stripRect(edge, cw, ch, blendW) {
  switch (edge) {
    case 'right':  return { x: cw - blendW, y: 0,           w: blendW, h: ch }
    case 'left':   return { x: 0,           y: 0,           w: blendW, h: ch }
    case 'bottom': return { x: 0,           y: ch - blendW, w: cw,     h: blendW }
    case 'top':    return { x: 0,           y: 0,           w: cw,     h: blendW }
    default:       return { x: 0,           y: 0,           w: blendW, h: ch }
  }
}

/**
 * Sample the single-pixel column (or row) right at the seam edge.
 * Returns Float32Array of length seamLen * 3 (one RGB per scanline position).
 */
function getSeamEdgePixels(ctx, edge, cw, ch) {
  const isVert = edge === 'left' || edge === 'right'
  let x, y, w, h
  switch (edge) {
    case 'right':  x = cw - 1; y = 0;     w = 1;  h = ch; break
    case 'left':   x = 0;      y = 0;     w = 1;  h = ch; break
    case 'bottom': x = 0;      y = ch - 1; w = cw; h = 1;  break
    case 'top':    x = 0;      y = 0;     w = cw; h = 1;  break
    default:       x = 0;      y = 0;     w = 1;  h = ch
  }
  const { data } = ctx.getImageData(x, y, w, h)
  const len = isVert ? ch : cw
  const result = new Float32Array(len * 3)
  for (let i = 0; i < len; i++) {
    result[i * 3]     = data[i * 4]
    result[i * 3 + 1] = data[i * 4 + 1]
    result[i * 3 + 2] = data[i * 4 + 2]
  }
  return result
}

/** Linear resample a seamLen*3 Float32Array to dstLen*3. */
function resampleSeam(src, srcLen, dstLen) {
  if (srcLen === dstLen) return src
  const dst = new Float32Array(dstLen * 3)
  for (let i = 0; i < dstLen; i++) {
    const t    = i / Math.max(1, dstLen - 1)
    const pos  = t * (srcLen - 1)
    const lo   = Math.floor(pos)
    const hi   = Math.min(srcLen - 1, lo + 1)
    const frac = pos - lo
    dst[i * 3]     = src[lo * 3]     * (1 - frac) + src[hi * 3]     * frac
    dst[i * 3 + 1] = src[lo * 3 + 1] * (1 - frac) + src[hi * 3 + 1] * frac
    dst[i * 3 + 2] = src[lo * 3 + 2] * (1 - frac) + src[hi * 3 + 2] * frac
  }
  return dst
}

// ── Pass 1: Geometric alignment (OpenCV) ──────────────────────────────────────

/**
 * Compute homography H that maps B-strip → A-strip in a 256×256 normalised space.
 * Returns { H, normSize } or null.
 */
async function computeStripHomography(imgDataA, imgDataB) {
  const cv   = await getCv()
  await yieldToUI()
  const NORM = 256
  const del  = (...ms) => ms.forEach(m => { try { m?.delete() } catch (_) {} })

  const matA = cv.matFromImageData(imgDataA), matB = cv.matFromImageData(imgDataB)
  const gA = new cv.Mat(), gB = new cv.Mat()
  cv.cvtColor(matA, gA, cv.COLOR_RGBA2GRAY)
  cv.cvtColor(matB, gB, cv.COLOR_RGBA2GRAY)
  const rA = new cv.Mat(), rB = new cv.Mat()
  cv.resize(gA, rA, new cv.Size(NORM, NORM))
  cv.resize(gB, rB, new cv.Size(NORM, NORM))

  const orb = new cv.ORB(ORB_FEATURES)
  const kpA = new cv.KeyPointVector(), kpB = new cv.KeyPointVector()
  const dA  = new cv.Mat(), dB = new cv.Mat(), none = new cv.Mat()
  orb.detectAndCompute(rA, none, kpA, dA); await yieldToUI()
  orb.detectAndCompute(rB, none, kpB, dB); await yieldToUI()

  if (dA.rows < 4 || dB.rows < 4) {
    del(matA, matB, gA, gB, rA, rB, kpA, kpB, dA, dB, none); orb.delete()
    return null
  }

  const bf  = new cv.BFMatcher(cv.NORM_HAMMING, true)
  const mts = new cv.DMatchVector()
  bf.match(dA, dB, mts)

  const arr = []
  for (let i = 0; i < mts.size(); i++) arr.push(mts.get(i))
  arr.sort((a, b) => a.distance - b.distance)
  const best = arr.slice(0, 60)

  if (best.length < MIN_MATCHES) {
    del(matA, matB, gA, gB, rA, rB, kpA, kpB, dA, dB, none, mts); orb.delete(); bf.delete()
    return null
  }

  // H maps B coords → A coords
  const srcPts = [], dstPts = []
  for (const m of best) {
    const pA = kpA.get(m.queryIdx).pt, pB = kpB.get(m.trainIdx).pt
    srcPts.push(pB.x, pB.y)
    dstPts.push(pA.x, pA.y)
  }
  const srcM = cv.matFromArray(best.length, 1, cv.CV_32FC2, srcPts)
  const dstM = cv.matFromArray(best.length, 1, cv.CV_32FC2, dstPts)
  const inl  = new cv.Mat()
  const H    = cv.findHomography(srcM, dstM, cv.RANSAC, 4.0, inl, 2000, 0.995)

  let inliers = 0
  for (let i = 0; i < inl.rows; i++) if (inl.data[i]) inliers++
  del(matA, matB, gA, gB, rA, rB, kpA, kpB, dA, dB, none, mts, srcM, dstM, inl)
  orb.delete(); bf.delete()

  if (inliers < MIN_MATCHES || H.empty()) { del(H); return null }
  return { H, normSize: NORM }
}

/**
 * Warp a strip using H (in normalised space) and blend it into ctx B.
 * Pixels at the seam edge are 100 % warped; at blendW they are 100 % original.
 */
async function applyGeometricWarp(ctxB, edgeB, cwB, chB, blendW, H_info) {
  const cv = await getCv()
  const { H, normSize } = H_info
  const { x, y, w, h } = stripRect(edgeB, cwB, chB, blendW)
  const del = (...ms) => ms.forEach(m => { try { m?.delete() } catch (_) {} })

  const origData = ctxB.getImageData(x, y, w, h)
  const origMat  = cv.matFromImageData(origData)
  const resized  = new cv.Mat()
  cv.resize(origMat, resized, new cv.Size(normSize, normSize))

  const warped     = new cv.Mat()
  cv.warpPerspective(resized, warped, H, new cv.Size(normSize, normSize),
    cv.INTER_LINEAR, cv.BORDER_REFLECT)

  const warpedFull = new cv.Mat()
  cv.resize(warped, warpedFull, new cv.Size(w, h))

  // Ensure RGBA
  const rgba = new cv.Mat()
  const ch = warpedFull.channels()
  if      (ch === 1) cv.cvtColor(warpedFull, rgba, cv.COLOR_GRAY2RGBA)
  else if (ch === 3) cv.cvtColor(warpedFull, rgba, cv.COLOR_RGB2RGBA)
  else               warpedFull.copyTo(rgba)

  const wd  = rgba.data
  const od  = origData.data
  const out = new Uint8ClampedArray(od.length)

  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      let dist
      switch (edgeB) {
        case 'left':   dist = col;      break
        case 'right':  dist = w - 1 - col; break
        case 'top':    dist = row;      break
        case 'bottom': dist = h - 1 - row; break
        default: dist = 0
      }
      const t  = Math.min(1, dist / blendW)
      const wt = 1 - t * t * (3 - 2 * t)  // smoothstep → 1 at edge, 0 at boundary
      const i  = (row * w + col) * 4
      out[i]     = Math.round(od[i]     * (1 - wt) + wd[i]     * wt)
      out[i + 1] = Math.round(od[i + 1] * (1 - wt) + wd[i + 1] * wt)
      out[i + 2] = Math.round(od[i + 2] * (1 - wt) + wd[i + 2] * wt)
      out[i + 3] = 255
    }
  }
  ctxB.putImageData(new ImageData(out, w, h), x, y)
  del(origMat, resized, warped, warpedFull, rgba)
}

// ── Pass 2: Narrow pixel feather ──────────────────────────────────────────────

/**
 * Blend the surface's edge pixels toward targetColors (from the neighbour)
 * over a narrow SEAM_FEATHER_PX strip.  Max blend = 50 % to stay invisible.
 */
function applyNarrowSeamFeather(ctx, edge, cw, ch, targetColors, seamLen) {
  const fp = Math.min(SEAM_FEATHER_PX, edge === 'left' || edge === 'right' ? cw : ch)
  const { x, y, w, h } = stripRect(edge, cw, ch, fp)
  const iData = ctx.getImageData(x, y, w, h)
  const d     = iData.data
  const isVert = edge === 'left' || edge === 'right'

  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      let dist
      switch (edge) {
        case 'left':   dist = col;      break
        case 'right':  dist = w - 1 - col; break
        case 'top':    dist = row;      break
        case 'bottom': dist = h - 1 - row; break
        default: dist = 0
      }
      const t  = dist / fp
      const wt = 0.5 * (1 - t)   // max 50 %, linear — keeps things subtle
      if (wt < 0.002) continue

      const scanPos = isVert ? row : col
      const si = Math.min(scanPos, seamLen - 1) * 3
      const pi = (row * w + col) * 4
      d[pi]     = Math.round(d[pi]     * (1 - wt) + targetColors[si]     * wt)
      d[pi + 1] = Math.round(d[pi + 1] * (1 - wt) + targetColors[si + 1] * wt)
      d[pi + 2] = Math.round(d[pi + 2] * (1 - wt) + targetColors[si + 2] * wt)
    }
  }
  ctx.putImageData(iData, x, y)
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Stitch one connected edge pair.
 * Returns { modifiedA, modifiedB } — JPEG data URLs.
 */
export async function blendEdgePair(dataUrlA, edgeA, dataUrlB, edgeB, useGeometric = true) {
  const [imgA, imgB] = await Promise.all([loadImg(dataUrlA), loadImg(dataUrlB)])
  const cA   = imgToCanvas(imgA), cB = imgToCanvas(imgB)
  const ctxA = cA.getContext('2d'), ctxB = cB.getContext('2d')

  const isVert = edgeA === 'left' || edgeA === 'right'
  const blendW = Math.max(4, Math.min(MAX_BLEND_PX,
    Math.round((isVert ? Math.min(cA.width, cB.width) : Math.min(cA.height, cB.height)) * BLEND_FRACTION)))

  // ── Pass 1: geometric warp ─────────────────────────────────────────────────
  if (useGeometric) {
    try {
      const rA = stripRect(edgeA, cA.width, cA.height, blendW)
      const rB = stripRect(edgeB, cB.width, cB.height, blendW)
      const H_info = await computeStripHomography(
        ctxA.getImageData(rA.x, rA.y, rA.w, rA.h),
        ctxB.getImageData(rB.x, rB.y, rB.w, rB.h),
      )
      if (H_info) {
        await applyGeometricWarp(ctxB, edgeB, cB.width, cB.height, blendW, H_info)
        H_info.H?.delete?.()
      }
    } catch (err) {
      console.warn('[seamBlend] Geometric pass failed, using feather only:', err.message)
    }
  }

  // ── Pass 2: narrow pixel feather ───────────────────────────────────────────
  // Re-read edge pixels AFTER the geometric warp so the feather targets post-warp colours
  const seamLenA = isVert ? cA.height : cA.width
  const seamLenB = isVert ? cB.height : cB.width

  const edgePixA = getSeamEdgePixels(ctxA, edgeA, cA.width, cA.height)
  const edgePixB = getSeamEdgePixels(ctxB, edgeB, cB.width, cB.height)

  // A feathers toward B's post-warp edge; B feathers toward A's edge
  applyNarrowSeamFeather(ctxA, edgeA, cA.width, cA.height,
    resampleSeam(edgePixB, seamLenB, seamLenA), seamLenA)
  applyNarrowSeamFeather(ctxB, edgeB, cB.width, cB.height,
    resampleSeam(edgePixA, seamLenA, seamLenB), seamLenB)

  return {
    modifiedA: cA.toDataURL('image/jpeg', 0.93),
    modifiedB: cB.toDataURL('image/jpeg', 0.93),
  }
}

/**
 * Stitch all connected surface pairs.
 * Returns Map<surfaceId, stitchedDataUrl>.
 */
export async function stitchSeams(surfaces, onProgress, geometric = true) {
  const seen = new Set(), pairs = []
  for (const surf of surfaces) {
    if (!surf.warpedDataUrl) continue
    for (const [edge, conn] of Object.entries(surf.connections || {})) {
      if (!conn?.surfaceId) continue
      const other = surfaces.find(s => s.id === conn.surfaceId)
      if (!other?.warpedDataUrl) continue
      const key = [surf.id, other.id].sort().join('::')
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push({ surfA: surf, edgeA: edge, surfB: other, edgeB: conn.edge })
    }
  }

  if (!pairs.length) { onProgress?.(100); return new Map() }

  const resultMap = new Map()
  for (const s of surfaces) {
    if (s.warpedDataUrl) resultMap.set(s.id, s.stitchedDataUrl || s.warpedDataUrl)
  }

  for (let i = 0; i < pairs.length; i++) {
    const { surfA, edgeA, surfB, edgeB } = pairs[i]
    onProgress?.(Math.round((i / pairs.length) * 95))
    const urlA = resultMap.get(surfA.id) || surfA.warpedDataUrl
    const urlB = resultMap.get(surfB.id) || surfB.warpedDataUrl
    try {
      const { modifiedA, modifiedB } = await blendEdgePair(urlA, edgeA, urlB, edgeB, geometric)
      resultMap.set(surfA.id, modifiedA)
      resultMap.set(surfB.id, modifiedB)
    } catch (err) {
      console.error('[seamBlend] pair failed:', surfA.id, '↔', surfB.id, err)
    }
  }

  onProgress?.(100)
  return resultMap
}
