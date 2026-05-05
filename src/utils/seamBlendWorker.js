/**
 * seamBlendWorker.js — Classic Web Worker for seam blending.
 *
 * NO import / export statements — this is intentionally a classic worker script,
 * NOT an ES module.  Vite bundles it as an IIFE which avoids any module-system
 * interference with the OpenCV WASM initialisation.
 *
 * How OpenCV is loaded (the key insight):
 *   importScripts(origin + '/opencv.js') loads the plain static file that Vite
 *   copies to public/ via the opencvPublicPlugin.  The opencv.js UMD wrapper
 *   has a specific `typeof importScripts === 'function'` branch that does:
 *       root.cv = factory()   // root === self in a classic worker
 *   so after importScripts returns, self.cv is the Promise that resolves to the
 *   fully initialised cv object (cv.Mat, cv.ORB, etc.).
 *
 *   This completely bypasses Vite/Rollup bundling of the 10 MB Emscripten file,
 *   which was corrupting the WASM init path in production worker chunks.
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
 *   Colour work is confined to 12 px at 50% max — sub-perceptual.
 *   The heavy lifting is done by the geometric warp which rearranges
 *   pixels without changing their colours.  No additive tinting, no
 *   dark gradient overlay, no colour-correction smear.
 *
 * Uses OffscreenCanvas + createImageBitmap (no DOM access needed).
 */

// ── OpenCV loader ─────────────────────────────────────────────────────────────

let _cv = null

async function loadCV() {
  if (_cv) { console.log('[seamBlendWorker] loadCV: cached'); return _cv }
  console.log('[seamBlendWorker] loadCV: starting…')
  try {
    const url = self.location.origin + '/opencv.js'
    console.log('[seamBlendWorker] loadCV: importScripts from', url)
    importScripts(url)
    console.log('[seamBlendWorker] loadCV: importScripts done')

    const raw = self.cv
    if (raw == null) throw new Error('self.cv not set after importScripts')

    // Await the Promise that resolves once WASM is compiled and initialised.
    const cv = typeof raw.then === 'function'
      ? await Promise.race([
          raw,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('cv Promise timed out after 60 s')), 60_000)
          ),
        ])
      : raw

    console.log('[seamBlendWorker] loadCV: cv resolved — cv.Mat =', typeof cv?.Mat, 'cv.ORB =', typeof cv?.ORB)
    if (typeof cv?.Mat === 'undefined') throw new Error('cv.Mat not found — unexpected module shape')
    _cv = cv
    console.log('[seamBlendWorker] loadCV: SUCCESS')
    return _cv
  } catch (err) {
    console.warn('[seamBlendWorker] loadCV FAILED:', err.message)
    return null   // caller falls back to feather-only mode
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

const BLEND_FRACTION  = 0.13   // geometric warp zone width (% of perpendicular dim)
const MAX_BLEND_PX    = 130    // px cap on warp zone
const SEAM_FEATHER_PX = 12     // narrow colour-feather width (pass 2)
// ORB panoramic alignment
const ORB_FEATURES    = 800    // more features → better match on wall photos
const MIN_MATCHES     = 6
const NORM_SIZE       = 512    // higher res strip for ORB → more accurate H

// ── Geometry helpers ──────────────────────────────────────────────────────────

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

// ── Pass 1: ORB geometric alignment ──────────────────────────────────────────

/**
 * Estimate homography H that maps pixels in strip B into strip A's frame.
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

  const bf      = new cv.BFMatcher(cv.NORM_HAMMING, true)
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

  // H maps B coords → A coords
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
    console.log('[seamBlendWorker] ORB: not enough inliers, falling back to feather-only')
    return null
  }
  return H
}

/**
 * Warp B's blend zone using H (normalised space) and blend into ctx with smoothstep.
 * Pixels at the seam edge are 100 % warped; at blendW they are 100 % original.
 * Only pixel positions are rearranged — colours are never mixed or tinted.
 */
function applyGeometricWarp(cv, ctx, edge, cw, ch, blendW, H) {
  const del = (...m) => m.forEach(x => { try { x?.delete() } catch (_) {} })
  const { x, y, w, h } = stripRect(edge, cw, ch, blendW)

  const origData = ctx.getImageData(x, y, w, h)
  const origMat  = cv.matFromImageData(origData)
  const resized  = new cv.Mat()
  cv.resize(origMat, resized, new cv.Size(NORM_SIZE, NORM_SIZE))
  const warped   = new cv.Mat()
  cv.warpPerspective(resized, warped, H, new cv.Size(NORM_SIZE, NORM_SIZE),
    cv.INTER_LINEAR, cv.BORDER_REFLECT)
  const warpedFull = new cv.Mat()
  cv.resize(warped, warpedFull, new cv.Size(w, h))

  // Ensure RGBA
  const rgba = new cv.Mat()
  const ch4 = warpedFull.channels()
  if      (ch4 === 1) cv.cvtColor(warpedFull, rgba, cv.COLOR_GRAY2RGBA)
  else if (ch4 === 3) cv.cvtColor(warpedFull, rgba, cv.COLOR_RGB2RGBA)
  else                warpedFull.copyTo(rgba)

  const wd  = rgba.data
  const od  = origData.data
  const out = new Uint8ClampedArray(od.length)

  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      let dist
      switch (edge) {
        case 'left':   dist = col;         break
        case 'right':  dist = w - 1 - col; break
        case 'top':    dist = row;         break
        case 'bottom': dist = h - 1 - row; break
        default: dist = 0
      }
      const t  = Math.min(1, dist / blendW)
      const wt = 1 - t * t * (3 - 2 * t)   // smoothstep: 1 at seam edge, 0 at boundary
      const i  = (row * w + col) * 4
      out[i]     = Math.round(od[i]     * (1 - wt) + wd[i]     * wt)
      out[i + 1] = Math.round(od[i + 1] * (1 - wt) + wd[i + 1] * wt)
      out[i + 2] = Math.round(od[i + 2] * (1 - wt) + wd[i + 2] * wt)
      out[i + 3] = 255
    }
  }
  ctx.putImageData(new ImageData(out, w, h), x, y)
  del(origMat, resized, warped, warpedFull, rgba)
}

// ── Pass 2: Narrow pixel feather ──────────────────────────────────────────────

/**
 * Sample the single-pixel column (or row) right at the seam edge.
 * Returns Float32Array of length seamLen * 3 (one RGB per scanline position).
 */
function getSeamEdgePixels(ctx, edge, cw, ch) {
  const isVert = edge === 'left' || edge === 'right'
  let x, y, w, h
  switch (edge) {
    case 'right':  x = cw - 1; y = 0;      w = 1;  h = ch; break
    case 'left':   x = 0;      y = 0;      w = 1;  h = ch; break
    case 'bottom': x = 0;      y = ch - 1; w = cw; h = 1;  break
    case 'top':    x = 0;      y = 0;      w = cw; h = 1;  break
    default:       x = 0;      y = 0;      w = 1;  h = ch
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

/**
 * Blend the surface's edge pixels toward targetColors (from the neighbour)
 * over a narrow SEAM_FEATHER_PX strip.  Max blend = 50 % so it never
 * "averages in" a visible band — just eliminates the hard colour jump.
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
        case 'left':   dist = col;         break
        case 'right':  dist = w - 1 - col; break
        case 'top':    dist = row;         break
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

// ── Main per-pair blend ───────────────────────────────────────────────────────

async function blendPair(cv, dataUrlA, edgeA, dataUrlB, edgeB) {
  console.log('[seamBlendWorker] blendPair: decoding…')
  const [cA, cB] = await Promise.all([dataUrlToCanvas(dataUrlA), dataUrlToCanvas(dataUrlB)])
  console.log(`[seamBlendWorker] blendPair: A(${cA.width}×${cA.height}) B(${cB.width}×${cB.height})`)

  const ctxA = cA.getContext('2d', { willReadFrequently: true })
  const ctxB = cB.getContext('2d', { willReadFrequently: true })

  const isVert = edgeA === 'left' || edgeA === 'right'
  const blendW = Math.max(4, Math.min(MAX_BLEND_PX,
    Math.round((isVert ? Math.min(cA.width, cB.width) : Math.min(cA.height, cB.height)) * BLEND_FRACTION)))
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
          applyGeometricWarp(cv, ctxB, edgeB, cB.width, cB.height, blendW, H)
          console.log('[seamBlendWorker] geometric warp applied to B')
        } finally {
          try { H.delete() } catch (_) {}
        }
      }
    } catch (err) {
      console.warn('[seamBlendWorker] ORB pass failed, continuing with feather-only:', err.message)
    }
  }

  // ── Pass 2: Narrow pixel feather ───────────────────────────────────────────
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
      : `Feathering ${pairs.length} seam${pairs.length !== 1 ? 's' : ''} (no OpenCV)…`,
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
