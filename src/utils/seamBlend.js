/**
 * seamBlend.js — Smart seam stitching for adjacent wall surfaces.
 *
 * Uses OpenCV.js (WebAssembly) for geometric feature alignment, with
 * per-scanline color correction as an additional pass and fallback.
 *
 * Pipeline for each connected pair (A.rightEdge ↔ B.leftEdge):
 *
 *   1. Extract edge strips from both textures.
 *   2. [OpenCV] Detect ORB keypoints in both strips.
 *   3. [OpenCV] BFMatcher + cross-check to find corresponding points.
 *   4. [OpenCV] RANSAC homography: H maps B-strip coords → A-strip coords.
 *   5. Warp B's blend zone using H (resized back to native resolution).
 *      Weight: 100 % warped at the seam edge, 0 % at blendWidth boundary.
 *   6. Per-scanline color correction on both surfaces:
 *      shift edge tones toward their meeting-point, same smoothstep gradient.
 *   7. If feature count < MIN_MATCHES, skip step 5 and fall back to step 6 only.
 *
 * Upgrade path: swap ORB for AKAZE (better for large perspective changes)
 * once @techstark/opencv-js exposes cv.AKAZE.
 */

// ── OpenCV.js lazy loader ─────────────────────────────────────────────────────
// Load the WASM only when stitching is actually requested.
let _cv = null
let _cvPromise = null

async function getCv() {
  if (_cv) return _cv
  if (_cvPromise) return _cvPromise

  _cvPromise = (async () => {
    const { default: cv } = await import('@techstark/opencv-js')
    await new Promise(resolve => {
      if (cv.Mat !== undefined) resolve()
      else cv.onRuntimeInitialized = resolve
    })
    _cv = cv
    return cv
  })()
  return _cvPromise
}

// ── Constants ─────────────────────────────────────────────────────────────────
const BLEND_FRACTION = 0.13   // blend zone = 13 % of perpendicular dimension
const MAX_BLEND_PX   = 130    // px cap
const SAMPLE_PX      = 14     // strip width for color-tone sampling
const ORB_FEATURES   = 600    // max keypoints to detect per strip
const MIN_MATCHES    = 8      // minimum inlier matches to trust the homography

// ── Image helpers ─────────────────────────────────────────────────────────────

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload  = () => resolve(img)
    img.onerror = reject
    img.src     = src
  })
}

function imgToCanvas(img) {
  const c = Object.assign(document.createElement('canvas'), {
    width: img.naturalWidth, height: img.naturalHeight,
  })
  c.getContext('2d').drawImage(img, 0, 0)
  return c
}

/** Return { x, y, w, h } of the blend-zone strip for a given edge. */
function stripRect(edge, cw, ch, blendW) {
  switch (edge) {
    case 'right':  return { x: cw - blendW, y: 0,           w: blendW, h: ch }
    case 'left':   return { x: 0,           y: 0,           w: blendW, h: ch }
    case 'bottom': return { x: 0,           y: ch - blendW, w: cw,     h: blendW }
    case 'top':    return { x: 0,           y: 0,           w: cw,     h: blendW }
    default:       return { x: 0,           y: 0,           w: blendW, h: ch }
  }
}

// ── OpenCV geometric alignment ────────────────────────────────────────────────

/**
 * Try to compute a homography H that maps B-strip pixels → A-strip pixels.
 * Works in a normalised square space (both strips resized to NORM_SIZE × NORM_SIZE)
 * so the returned H is in that normalised coordinate system.
 *
 * Returns { H, normSize } or null if too few inlier matches.
 */
async function computeStripHomography(imgDataA, imgDataB) {
  const cv = await getCv()

  // Use a fixed normalisation size so features are always dense enough
  const NORM = 256

  const cvDelete = (...mats) => mats.forEach(m => { try { m?.delete() } catch (_) {} })

  // --- Mat conversion ---
  const matA = cv.matFromImageData(imgDataA)
  const matB = cv.matFromImageData(imgDataB)
  const gA = new cv.Mat(), gB = new cv.Mat()
  cv.cvtColor(matA, gA, cv.COLOR_RGBA2GRAY)
  cv.cvtColor(matB, gB, cv.COLOR_RGBA2GRAY)
  const rA = new cv.Mat(), rB = new cv.Mat()
  cv.resize(gA, rA, new cv.Size(NORM, NORM))
  cv.resize(gB, rB, new cv.Size(NORM, NORM))

  // --- ORB ---
  const orb  = new cv.ORB(ORB_FEATURES)
  const kpA  = new cv.KeyPointVector()
  const kpB  = new cv.KeyPointVector()
  const dA   = new cv.Mat()
  const dB   = new cv.Mat()
  const none = new cv.Mat()
  orb.detectAndCompute(rA, none, kpA, dA)
  orb.detectAndCompute(rB, none, kpB, dB)

  if (dA.rows < 4 || dB.rows < 4) {
    cvDelete(matA, matB, gA, gB, rA, rB, kpA, kpB, dA, dB, none)
    orb.delete()
    return null
  }

  // --- BFMatcher with cross-check (no ratio test needed) ---
  const bf      = new cv.BFMatcher(cv.NORM_HAMMING, true)
  const matches = new cv.DMatchVector()
  bf.match(dA, dB, matches)

  // Sort by distance, keep best 60
  const arr = []
  for (let i = 0; i < matches.size(); i++) arr.push(matches.get(i))
  arr.sort((a, b) => a.distance - b.distance)
  const best = arr.slice(0, 60)

  if (best.length < MIN_MATCHES) {
    cvDelete(matA, matB, gA, gB, rA, rB, kpA, kpB, dA, dB, none, matches)
    orb.delete(); bf.delete()
    return null
  }

  // --- Build point arrays (A = src query, B = dst train; we want H: B→A) ---
  const srcPts = [], dstPts = []
  for (const m of best) {
    const ptA = kpA.get(m.queryIdx).pt
    const ptB = kpB.get(m.trainIdx).pt
    srcPts.push(ptB.x, ptB.y)   // source: B strip coords
    dstPts.push(ptA.x, ptA.y)   // dest:   A strip coords
  }

  const srcMat    = cv.matFromArray(best.length, 1, cv.CV_32FC2, srcPts)
  const dstMat    = cv.matFromArray(best.length, 1, cv.CV_32FC2, dstPts)
  const inlierMat = new cv.Mat()
  const H         = cv.findHomography(srcMat, dstMat, cv.RANSAC, 4.0, inlierMat, 2000, 0.995)

  let inliers = 0
  for (let i = 0; i < inlierMat.rows; i++) if (inlierMat.data[i]) inliers++

  cvDelete(matA, matB, gA, gB, rA, rB, kpA, kpB, dA, dB, none, matches, srcMat, dstMat, inlierMat)
  orb.delete(); bf.delete()

  if (inliers < MIN_MATCHES || H.empty()) {
    cvDelete(H)
    return null
  }

  return { H, normSize: NORM }
}

/**
 * Warp B's blend zone toward A using the homography.
 * Returns modified ImageData for the blend zone (same size as the original strip).
 */
async function warpStripWithHomography(origStripData, H_info) {
  const cv = await getCv()
  const { H, normSize } = H_info
  const { width: sw, height: sh } = origStripData

  const cvDelete = (...m) => m.forEach(x => { try { x?.delete() } catch(_) {} })

  const mat     = cv.matFromImageData(origStripData)
  const resized = new cv.Mat()
  cv.resize(mat, resized, new cv.Size(normSize, normSize))

  const warped  = new cv.Mat()
  cv.warpPerspective(resized, warped, H, new cv.Size(normSize, normSize),
    cv.INTER_LINEAR, cv.BORDER_REFLECT)   // REFLECT avoids black borders at edges

  // Resize back to original strip dimensions
  const warpedFull = new cv.Mat()
  cv.resize(warped, warpedFull, new cv.Size(sw, sh))

  // Extract pixel data
  const rgba = new cv.Mat()
  if (warpedFull.channels() === 1) {
    cv.cvtColor(warpedFull, rgba, cv.COLOR_GRAY2RGBA)
  } else if (warpedFull.channels() === 3) {
    cv.cvtColor(warpedFull, rgba, cv.COLOR_RGB2RGBA)
  } else {
    warpedFull.copyTo(rgba)
  }
  const result = new ImageData(new Uint8ClampedArray(rgba.data), sw, sh)

  cvDelete(mat, resized, warped, warpedFull, rgba)
  return result
}

/**
 * Blend the warped strip into the canvas blend zone.
 * At the seam edge: 100 % warped. At blendW distance: 0 % warped (original).
 */
function applyWarpedStrip(ctx, edge, cw, ch, blendW, origData, warpedData) {
  const { x, y, w, h } = stripRect(edge, cw, ch, blendW)
  const od = origData.data
  const wd = warpedData.data
  const bd = new Uint8ClampedArray(od.length)

  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      let dist
      switch (edge) {
        case 'left':   dist = col;              break
        case 'right':  dist = w - 1 - col;      break
        case 'top':    dist = row;              break
        case 'bottom': dist = h - 1 - row;      break
        default:       dist = 0
      }
      const t      = Math.min(1, dist / blendW)
      const warpWt = 1 - t * t * (3 - 2 * t)   // 1 - smoothstep → 1 at edge, 0 at boundary

      const i = (row * w + col) * 4
      bd[i]     = Math.round(od[i]     * (1 - warpWt) + wd[i]     * warpWt)
      bd[i + 1] = Math.round(od[i + 1] * (1 - warpWt) + wd[i + 1] * warpWt)
      bd[i + 2] = Math.round(od[i + 2] * (1 - warpWt) + wd[i + 2] * warpWt)
      bd[i + 3] = 255
    }
  }
  ctx.putImageData(new ImageData(bd, w, h), x, y)
}

// ── Color correction helpers ──────────────────────────────────────────────────

/** Average RGB per scanline position along the seam. */
function getSeamAvg(ctx, edge, cw, ch) {
  const sp = Math.min(SAMPLE_PX, edge === 'left' || edge === 'right' ? cw : ch)
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
    avg[i * 3]     = r / scanLen
    avg[i * 3 + 1] = g / scanLen
    avg[i * 3 + 2] = b / scanLen
  }
  return avg
}

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
      const dr = (targetSeam[si]     - seamAvg[si])     * wt
      const dg = (targetSeam[si + 1] - seamAvg[si + 1]) * wt
      const db = (targetSeam[si + 2] - seamAvg[si + 2]) * wt

      const pi  = (row * scanW + col) * 4
      d[pi]     = Math.round(Math.min(255, Math.max(0, d[pi]     + dr)))
      d[pi + 1] = Math.round(Math.min(255, Math.max(0, d[pi + 1] + dg)))
      d[pi + 2] = Math.round(Math.min(255, Math.max(0, d[pi + 2] + db)))
    }
  }
  ctx.putImageData(iData, x0, y0)
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Blend a single connected edge pair.
 * Returns { modifiedA, modifiedB } — JPEG data URLs.
 *
 * useGeometric: set false to skip the OpenCV step (color-only, faster).
 */
export async function blendEdgePair(dataUrlA, edgeA, dataUrlB, edgeB, useGeometric = true) {
  const [imgA, imgB] = await Promise.all([loadImg(dataUrlA), loadImg(dataUrlB)])
  const cA = imgToCanvas(imgA)
  const cB = imgToCanvas(imgB)
  const ctxA = cA.getContext('2d')
  const ctxB = cB.getContext('2d')

  const isVert = edgeA === 'left' || edgeA === 'right'
  const perpA  = isVert ? cA.width : cA.height
  const perpB  = isVert ? cB.width : cB.height

  const blendWA = Math.round(Math.min(MAX_BLEND_PX, perpA * BLEND_FRACTION))
  const blendWB = Math.round(Math.min(MAX_BLEND_PX, perpB * BLEND_FRACTION))
  const blendW  = Math.max(4, Math.min(blendWA, blendWB))

  // ── Step 1: Geometric alignment (OpenCV ORB + homography) ──────────────────
  if (useGeometric) {
    try {
      // Extract edge strips for feature detection
      const rA = stripRect(edgeA, cA.width, cA.height, blendW)
      const rB = stripRect(edgeB, cB.width, cB.height, blendW)
      const idA = ctxA.getImageData(rA.x, rA.y, rA.w, rA.h)
      const idB = ctxB.getImageData(rB.x, rB.y, rB.w, rB.h)

      const H_info = await computeStripHomography(idA, idB)

      if (H_info) {
        // Warp B's blend zone to align with A, then write back
        const origB    = ctxB.getImageData(rB.x, rB.y, rB.w, rB.h)
        const warpedB  = await warpStripWithHomography(origB, H_info)
        applyWarpedStrip(ctxB, edgeB, cB.width, cB.height, blendW, origB, warpedB)

        // Also warp A's blend zone toward B for symmetry (using H inverse)
        // We can skip this or do a lighter pass — skip for now to keep it fast
      }

      // Cleanup H after use
      H_info?.H?.delete?.()
    } catch (err) {
      // OpenCV error → fall through to color-only blending
      console.warn('[seamBlend] Geometric alignment failed, using color-only:', err.message)
    }
  }

  // ── Step 2: Per-scanline color correction ───────────────────────────────────
  // Re-sample after any geometric warp so color measurement is post-warp
  const seamLenA = isVert ? cA.height : cA.width
  const seamLenB = isVert ? cB.height : cB.width

  const avgA = getSeamAvg(ctxA, edgeA, cA.width, cA.height)
  const avgB = getSeamAvg(ctxB, edgeB, cB.width, cB.height)

  // Resample to A's length, build meeting-point target
  const rAvgB    = resampleSeam(avgB, seamLenB, seamLenA)
  const targetA  = new Float32Array(seamLenA * 3)
  for (let i = 0; i < seamLenA * 3; i++) {
    targetA[i] = (avgA[i] + rAvgB[i]) / 2
  }
  const targetB  = resampleSeam(targetA, seamLenA, seamLenB)

  applyColorCorrection(ctxA, edgeA, cA.width, cA.height, blendW, avgA, targetA)
  applyColorCorrection(ctxB, edgeB, cB.width, cB.height, blendW,
    resampleSeam(avgB, seamLenB, seamLenB), targetB)

  return {
    modifiedA: cA.toDataURL('image/jpeg', 0.93),
    modifiedB: cB.toDataURL('image/jpeg', 0.93),
  }
}

/**
 * Stitch all connected surface pairs in a space.
 * Returns Map<surfaceId, stitchedDataUrl>.
 *
 * Surfaces without warpedDataUrl are skipped.
 * Multi-edge surfaces accumulate corrections sequentially.
 *
 * @param {Array}    surfaces   - space.surfaces
 * @param {Function} onProgress - callback(0..100)
 * @param {boolean}  geometric  - true = use OpenCV (default), false = color-only
 */
export async function stitchSeams(surfaces, onProgress, geometric = true) {
  // Collect unique pairs (avoid double-processing A↔B and B↔A)
  const seen  = new Set()
  const pairs = []

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

  if (pairs.length === 0) { onProgress?.(100); return new Map() }

  // Seed with best available texture
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
