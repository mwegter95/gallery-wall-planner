/**
 * inpaintWorker.js — Classic (non-module) Web Worker.
 *
 * Implements exemplar-based inpainting inspired by Criminisi et al. (2004).
 * This is the same principle as Photoshop's "Content-Aware Fill":
 *   • Find the fill-region boundary (Ω's ∂Ω).
 *   • For each boundary patch, compute a fill priority (confidence × isophote strength).
 *   • Find the best-matching patch in the source region by minimising SSD on known pixels.
 *   • Copy the matched patch pixels into the target, update confidence.
 *   • Repeat until the mask is fully filled.
 *
 * No external dependencies — pure typed-array arithmetic.
 * Messages:
 *   IN  { type:'inpaint', imageData:{width,height,data}, mask:{width,height,data} }
 *   OUT { type:'progress', pct }
 *   OUT { type:'done', imageData:{width,height,data} }
 *   OUT { type:'error', message }
 */

/* ── Constants ────────────────────────────────────────────────────────────── */
const PATCH      = 9    // half-size of patch window (full patch = 2*PATCH+1 square)
const PATCH_FULL = 2 * PATCH + 1
const OMEGA      = 0.5  // weight given to isophote (gradient) term in priority
const ALPHA      = 255  // normalisation for confidence

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function idx(x, y, w)      { return (y * w + x) * 4 }
function maskIdx(x, y, w)  { return y * w + x }

/** Clamp x to [lo, hi]. */
function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x }

/**
 * Build a Float32Array confidence map (C).
 * Pixels outside mask = 1.0 (known).  Inside mask = 0.0 (unknown).
 */
function buildConfidence(mask, w, h) {
  const C = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) C[i] = mask[i] ? 0 : 1
  return C
}

/**
 * Returns the list of all pixels on the fill boundary:
 * mask[p]=1 and at least one 4-connected neighbour has mask=0.
 */
function getBoundary(mask, w, h) {
  const boundary = []
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!mask[maskIdx(x, y, w)]) continue
      if (!mask[maskIdx(x-1,y,w)] || !mask[maskIdx(x+1,y,w)] ||
          !mask[maskIdx(x,y-1,w)] || !mask[maskIdx(x,y+1,w)]) {
        boundary.push({ x, y })
      }
    }
  }
  return boundary
}

/**
 * Compute the confidence term C(p) for a boundary patch centred at (px, py).
 * C(p) = sum of confidence of known pixels in patch / patch area.
 */
function patchConfidence(px, py, C, mask, w, h) {
  let sum = 0, count = 0
  for (let dy = -PATCH; dy <= PATCH; dy++) {
    for (let dx = -PATCH; dx <= PATCH; dx++) {
      const nx = clamp(px + dx, 0, w - 1)
      const ny = clamp(py + dy, 0, h - 1)
      if (!mask[maskIdx(nx, ny, w)]) {
        sum += C[ny * w + nx]
      }
      count++
    }
  }
  return sum / count
}

/**
 * Compute the data term D(p) = |grad(I) · n̂| / alpha
 * where grad is estimated from the source region and n̂ is the boundary normal.
 */
function dataterm(px, py, img, mask, w, h) {
  // Compute image gradient (Sobel) using only known pixels
  let gx = 0, gy = 0
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = clamp(px + dx, 0, w - 1)
      const ny = clamp(py + dy, 0, h - 1)
      if (mask[maskIdx(nx, ny, w)]) continue
      const i   = idx(nx, ny, w)
      const lum = (img[i] * 0.299 + img[i+1] * 0.587 + img[i+2] * 0.114) / 255
      gx += lum * dx
      gy += lum * dy
    }
  }
  // Boundary normal (approximate from 4-connected mask neighbours)
  let nx2 = 0, ny2 = 0
  if (px > 0     && !mask[maskIdx(px-1,py,w)]) nx2--
  if (px < w - 1 && !mask[maskIdx(px+1,py,w)]) nx2++
  if (py > 0     && !mask[maskIdx(px,py-1,w)]) ny2--
  if (py < h - 1 && !mask[maskIdx(px,py+1,w)]) ny2++
  const nlen = Math.sqrt(nx2*nx2 + ny2*ny2) || 1
  return Math.abs(gx * (nx2 / nlen) + gy * (ny2 / nlen)) / ALPHA
}

/**
 * Find the source patch (in the known region) that best matches the
 * target patch centred at (px, py) — only comparing KNOWN pixels of the patch.
 * Returns { sx, sy } of the best match centre.
 */
function findBestMatch(px, py, img, mask, w, h) {
  let bestSSD = Infinity
  let bestX = px, bestY = py

  // Search radius: scan the full image but favour the region around the target.
  // To keep it practical we subsample with a stride of 3.
  const STRIDE = 3
  for (let sy = PATCH; sy < h - PATCH; sy += STRIDE) {
    for (let sx = PATCH; sx < w - PATCH; sx += STRIDE) {
      // Skip if this candidate patch is entirely inside the mask
      if (mask[maskIdx(sx, sy, w)]) continue

      let ssd = 0, n = 0
      for (let dy = -PATCH; dy <= PATCH; dy++) {
        for (let dx = -PATCH; dx <= PATCH; dx++) {
          const tx = px + dx, ty = py + dy
          const qx = sx + dx, qy = sy + dy
          if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue
          if (qx < 0 || qx >= w || qy < 0 || qy >= h) continue
          // Only compare pixels known in both patches
          if (mask[maskIdx(tx, ty, w)]) continue
          if (mask[maskIdx(qx, qy, w)]) continue

          const ti = idx(tx, ty, w), qi = idx(qx, qy, w)
          let d
          d = img[ti]   - img[qi];   ssd += d * d
          d = img[ti+1] - img[qi+1]; ssd += d * d
          d = img[ti+2] - img[qi+2]; ssd += d * d
          n++
        }
      }
      if (n === 0) continue
      const normSSD = ssd / n
      if (normSSD < bestSSD) {
        bestSSD = normSSD
        bestX = sx; bestY = sy
      }
    }
  }
  return { sx: bestX, sy: bestY }
}

/**
 * Copy pixels from source patch (sx,sy) into target patch (px,py)
 * for all masked (unknown) pixels in the target patch.
 * Also updates confidence and clears the mask for those pixels.
 */
function copyPatch(px, py, sx, sy, img, mask, C, w, h, newConf) {
  for (let dy = -PATCH; dy <= PATCH; dy++) {
    for (let dx = -PATCH; dx <= PATCH; dx++) {
      const tx = px + dx, ty = py + dy
      const qx = sx + dx, qy = sy + dy
      if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue
      if (qx < 0 || qx >= w || qy < 0 || qy >= h) continue
      if (!mask[maskIdx(tx, ty, w)]) continue   // already known

      const ti = idx(tx, ty, w), qi = idx(qx, qy, w)
      img[ti]   = img[qi]
      img[ti+1] = img[qi+1]
      img[ti+2] = img[qi+2]
      img[ti+3] = 255

      mask[maskIdx(tx, ty, w)] = 0          // mark as filled
      C[ty * w + tx] = newConf
    }
  }
}

/**
 * Quick Gaussian feather pass: average each still-slightly-masked border pixel
 * with its 8-connected neighbours.  Smooths blockiness at the fill edge.
 */
function featherBorder(img, origMask, w, h) {
  const out = new Uint8ClampedArray(img)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!origMask[maskIdx(x, y, w)]) continue
      // At least one neighbour was originally masked → this is a boundary pixel
      let r = 0, g = 0, b = 0, n = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const i = idx(x + dx, y + dy, w)
          r += img[i]; g += img[i+1]; b += img[i+2]
          n++
        }
      }
      const i = idx(x, y, w)
      out[i]   = Math.round(r / n)
      out[i+1] = Math.round(g / n)
      out[i+2] = Math.round(b / n)
      out[i+3] = 255
    }
  }
  return out
}

/* ── Main handler ─────────────────────────────────────────────────────────── */

self.onmessage = ({ data }) => {
  if (data.type !== 'inpaint') return

  const { imageData, mask: maskIn } = data
  const { width: w, height: h }     = imageData

  console.log(`[inpaintWorker] start: ${w}×${h}, mask pixels: ${maskIn.data.filter(Boolean).length}`)

  try {
    // Working copies — Uint8Array (not Uint8ClampedArray) so we can index freely
    const img  = new Uint8Array(imageData.data)
    const mask = new Uint8Array(maskIn.data)

    const origMask = new Uint8Array(mask)   // keep for feather pass
    const C        = buildConfidence(mask, w, h)

    // Count total masked pixels for progress reporting
    let totalMasked = 0
    for (let i = 0; i < mask.length; i++) if (mask[i]) totalMasked++
    let filled = 0

    const REPORT_INTERVAL = Math.max(1, Math.floor(totalMasked / 40))

    while (true) {
      const boundary = getBoundary(mask, w, h)
      if (boundary.length === 0) break

      // Find highest-priority boundary pixel
      let bestP = null, bestPriority = -1
      for (const p of boundary) {
        const conf = patchConfidence(p.x, p.y, C, mask, w, h)
        const data = OMEGA * dataterm(p.x, p.y, img, mask, w, h)
        const pri  = conf + data
        if (pri > bestPriority) { bestPriority = pri; bestP = p }
      }
      if (!bestP) break

      const { sx, sy } = findBestMatch(bestP.x, bestP.y, img, mask, w, h)
      const newConf    = patchConfidence(bestP.x, bestP.y, C, mask, w, h)
      copyPatch(bestP.x, bestP.y, sx, sy, img, mask, C, w, h, newConf)

      // Count how many we just filled
      let stillMasked = 0
      for (let i = 0; i < mask.length; i++) if (mask[i]) stillMasked++
      const justFilled = totalMasked - stillMasked - filled
      filled += justFilled

      if (filled % REPORT_INTERVAL < PATCH_FULL) {
        const pct = Math.round((filled / totalMasked) * 98)
        self.postMessage({ type: 'progress', pct })
      }
    }

    // Feather the boundary
    const smoothed = featherBorder(img, origMask, w, h)

    self.postMessage({ type: 'progress', pct: 100 })
    self.postMessage({
      type: 'done',
      imageData: { width: w, height: h, data: smoothed },
    })
  } catch (err) {
    console.error('[inpaintWorker] error:', err)
    self.postMessage({ type: 'error', message: err.message })
  }
}
