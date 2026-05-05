/**
 * seamBlendWorker.js — Web Worker for seam blending.
 *
 * Runs entirely off the main thread so:
 *   • OpenCV WASM compiles here, never blocking the UI
 *   • All pixel loops run here, UI stays at 60 fps
 *   • Progress messages come back to main thread between each step
 *
 * Uses OffscreenCanvas + createImageBitmap (no DOM access needed).
 */

// ── OpenCV loader ─────────────────────────────────────────────────────────────

let _cv = null

async function loadCV() {
  if (_cv) return _cv
  try {
    const { default: Cv } = await import('@techstark/opencv-js')
    // Race: either WASM is already initialized, or wait up to 45 s
    await Promise.race([
      new Promise(resolve => {
        if (typeof Cv.Mat !== 'undefined') resolve()
        else Cv.onRuntimeInitialized = resolve
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('OpenCV init timeout')), 45_000)
      ),
    ])
    _cv = Cv
    return _cv
  } catch (err) {
    console.warn('[seamBlendWorker] OpenCV load failed:', err.message)
    return null   // caller falls back to colour-only mode
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
  // Chunked btoa avoids maximum call-stack errors on large images
  const CHUNK = 8192
  let binary  = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)))
  }
  return 'data:image/jpeg;base64,' + btoa(binary)
}

// ── Constants ─────────────────────────────────────────────────────────────────

const BLEND_FRACTION = 0.13   // blend-zone = 13 % of the perpendicular dimension
const MAX_BLEND_PX   = 130
const SAMPLE_PX      = 14     // strip depth for colour sampling
const ORB_FEATURES   = 500
const MIN_MATCHES    = 8
const NORM_SIZE      = 256    // strips are normalised to this before ORB

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
 * Compute a homography H that maps B-strip → A-strip (normalised NORM_SIZE coords).
 * Returns the cv.Mat H, or null if too few inliers.
 * Caller must call H.delete() when done.
 */
function computeHomography(cv, imgDataA, imgDataB) {
  const del = (...m) => m.forEach(x => { try { x?.delete() } catch (_) {} })

  const matA = cv.matFromImageData(imgDataA)
  const matB = cv.matFromImageData(imgDataB)
  const gA = new cv.Mat(), gB = new cv.Mat()
  cv.cvtColor(matA, gA, cv.COLOR_RGBA2GRAY)
  cv.cvtColor(matB, gB, cv.COLOR_RGBA2GRAY)
  const rA = new cv.Mat(), rB = new cv.Mat()
  cv.resize(gA, rA, new cv.Size(NORM_SIZE, NORM_SIZE))
  cv.resize(gB, rB, new cv.Size(NORM_SIZE, NORM_SIZE))

  const orb  = new cv.ORB(ORB_FEATURES)
  const kpA  = new cv.KeyPointVector(), kpB = new cv.KeyPointVector()
  const dA   = new cv.Mat(), dB = new cv.Mat()
  const none = new cv.Mat()
  orb.detectAndCompute(rA, none, kpA, dA)
  orb.detectAndCompute(rB, none, kpB, dB)

  if (dA.rows < 4 || dB.rows < 4) {
    del(matA, matB, gA, gB, rA, rB, kpA, kpB, dA, dB, none); orb.delete()
    return null
  }

  const bf      = new cv.BFMatcher(cv.NORM_HAMMING, true)
  const matches = new cv.DMatchVector()
  bf.match(dA, dB, matches)

  const arr = []
  for (let i = 0; i < matches.size(); i++) arr.push(matches.get(i))
  arr.sort((a, b) => a.distance - b.distance)
  const best = arr.slice(0, 60)

  if (best.length < MIN_MATCHES) {
    del(matA, matB, gA, gB, rA, rB, kpA, kpB, dA, dB, none, matches)
    orb.delete(); bf.delete()
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
  const H         = cv.findHomography(srcMat, dstMat, cv.RANSAC, 4.0, inlierMat, 2000, 0.995)

  let inliers = 0
  for (let i = 0; i < inlierMat.rows; i++) if (inlierMat.data[i]) inliers++

  del(matA, matB, gA, gB, rA, rB, kpA, kpB, dA, dB, none, matches, srcMat, dstMat, inlierMat)
  orb.delete(); bf.delete()

  if (inliers < MIN_MATCHES || H.empty()) { del(H); return null }
  return H
}

/**
 * Warp a strip's ImageData using H (normalised → native resolution).
 * Returns a new ImageData of the same size as origData.
 */
function warpStrip(cv, H, origData) {
  const { width: sw, height: sh } = origData
  const del = (...m) => m.forEach(x => { try { x?.delete() } catch (_) {} })

  const mat     = cv.matFromImageData(origData)
  const resized = new cv.Mat()
  cv.resize(mat, resized, new cv.Size(NORM_SIZE, NORM_SIZE))
  const warped = new cv.Mat()
  cv.warpPerspective(resized, warped, H, new cv.Size(NORM_SIZE, NORM_SIZE),
    cv.INTER_LINEAR, cv.BORDER_REFLECT)
  const full = new cv.Mat()
  cv.resize(warped, full, new cv.Size(sw, sh))
  const rgba = new cv.Mat()
  if (full.channels() === 1)      cv.cvtColor(full, rgba, cv.COLOR_GRAY2RGBA)
  else if (full.channels() === 3) cv.cvtColor(full, rgba, cv.COLOR_RGB2RGBA)
  else                            full.copyTo(rgba)

  const result = new ImageData(new Uint8ClampedArray(rgba.data), sw, sh)
  del(mat, resized, warped, full, rgba)
  return result
}

/**
 * Feather-blend a warped strip back into the canvas blend zone.
 * Weight: 1.0 at the seam edge → 0.0 at the inner boundary.
 */
function applyWarpedStrip(ctx, edge, cw, ch, blendW, origData, warpedData) {
  const { x, y, w, h } = stripRect(edge, cw, ch, blendW)
  const od = origData.data, wd = warpedData.data
  const bd = new Uint8ClampedArray(od.length)

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
      const wt = 1 - t * t * (3 - 2 * t)   // smoothstep: 1 at edge, 0 at boundary
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
      const si  = (isVert ? row : col) * 3
      const dr  = (targetSeam[si]     - seamAvg[si])     * wt
      const dg  = (targetSeam[si + 1] - seamAvg[si + 1]) * wt
      const db  = (targetSeam[si + 2] - seamAvg[si + 2]) * wt
      const pi  = (row * scanW + col) * 4
      d[pi]     = Math.round(Math.min(255, Math.max(0, d[pi]     + dr)))
      d[pi + 1] = Math.round(Math.min(255, Math.max(0, d[pi + 1] + dg)))
      d[pi + 2] = Math.round(Math.min(255, Math.max(0, d[pi + 2] + db)))
    }
  }
  ctx.putImageData(iData, x0, y0)
}

// ── Main per-pair blend ───────────────────────────────────────────────────────

async function blendPair(cv, dataUrlA, edgeA, dataUrlB, edgeB) {
  const [cA, cB] = await Promise.all([dataUrlToCanvas(dataUrlA), dataUrlToCanvas(dataUrlB)])
  const ctxA = cA.getContext('2d', { willReadFrequently: true })
  const ctxB = cB.getContext('2d', { willReadFrequently: true })

  const isVert = edgeA === 'left' || edgeA === 'right'
  const perpA  = isVert ? cA.width : cA.height
  const perpB  = isVert ? cB.width : cB.height
  const blendW = Math.max(4, Math.min(MAX_BLEND_PX,
    Math.round(perpA * BLEND_FRACTION),
    Math.round(perpB * BLEND_FRACTION),
  ))

  // ── Pass 1: ORB geometric alignment ────────────────────────────────────────
  if (cv) {
    try {
      const rA = stripRect(edgeA, cA.width, cA.height, blendW)
      const rB = stripRect(edgeB, cB.width, cB.height, blendW)
      const idA = ctxA.getImageData(rA.x, rA.y, rA.w, rA.h)
      const idB = ctxB.getImageData(rB.x, rB.y, rB.w, rB.h)

      const H = computeHomography(cv, idA, idB)
      if (H) {
        try {
          const origB   = ctxB.getImageData(rB.x, rB.y, rB.w, rB.h)
          const warpedB = warpStrip(cv, H, origB)
          applyWarpedStrip(ctxB, edgeB, cB.width, cB.height, blendW, origB, warpedB)
        } finally {
          try { H.delete() } catch (_) {}
        }
      }
    } catch (err) {
      console.warn('[seamBlendWorker] ORB failed, colour-only fallback:', err.message)
    }
  }

  // ── Pass 2: Colour-tone correction ─────────────────────────────────────────
  const seamLenA = isVert ? cA.height : cA.width
  const seamLenB = isVert ? cB.height : cB.width
  const avgA     = getSeamAvg(ctxA, edgeA, cA.width, cA.height)
  const avgB     = getSeamAvg(ctxB, edgeB, cB.width, cB.height)
  const rAvgB    = resampleSeam(avgB, seamLenB, seamLenA)
  const targetA  = new Float32Array(seamLenA * 3)
  for (let i = 0; i < seamLenA * 3; i++) targetA[i] = (avgA[i] + rAvgB[i]) / 2
  const targetB  = resampleSeam(targetA, seamLenA, seamLenB)

  applyColorCorrection(ctxA, edgeA, cA.width, cA.height, blendW, avgA, targetA)
  applyColorCorrection(ctxB, edgeB, cB.width, cB.height, blendW,
    resampleSeam(avgB, seamLenB, seamLenB), targetB)

  return {
    dataUrlA: await canvasToDataUrl(cA),
    dataUrlB: await canvasToDataUrl(cB),
  }
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = async ({ data }) => {
  if (data.type !== 'stitch') return
  const { pairs } = data

  self.postMessage({ type: 'progress', pct: 2, status: 'Loading OpenCV…' })
  const cv = await loadCV()
  self.postMessage({
    type: 'progress', pct: 12,
    status: cv
      ? `OpenCV ready — stitching ${pairs.length} seam${pairs.length !== 1 ? 's' : ''}…`
      : `Using colour correction (OpenCV unavailable) — ${pairs.length} seam${pairs.length !== 1 ? 's' : ''}…`,
  })

  const resultMap = {}

  for (let i = 0; i < pairs.length; i++) {
    const { idA, dataUrlA, edgeA, idB, dataUrlB, edgeB } = pairs[i]
    const pct = 12 + Math.round((i / pairs.length) * 85)
    self.postMessage({ type: 'progress', pct, status: `Seam ${i + 1} of ${pairs.length}…` })

    const srcA = resultMap[idA] || dataUrlA
    const srcB = resultMap[idB] || dataUrlB

    try {
      const result = await blendPair(cv, srcA, edgeA, srcB, edgeB)
      resultMap[idA] = result.dataUrlA
      resultMap[idB] = result.dataUrlB
    } catch (err) {
      self.postMessage({ type: 'warn', msg: `Seam ${i + 1} failed: ${err.message}` })
    }
  }

  self.postMessage({ type: 'done', results: Object.entries(resultMap) })
}
