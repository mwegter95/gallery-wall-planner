/**
 * inpaintWorker.js — Classic (non-module) Web Worker.
 *
 * Gradient-aware inpaint for uniform backgrounds (walls, floors, sky).
 *
 * Phase 1 – Jacobi fill from original background:
 *   For each masked pixel, estimate the wall colour at that spatial position by
 *   sampling all ORIGINAL (never-masked) pixels within an adaptive large radius,
 *   using inverse-distance² weights.  All predictions are computed independently
 *   from the unmodified source image (Jacobi, not Gauss-Seidel), so no boundary
 *   contamination from object edges propagates inward.  Because distant wall
 *   pixels are included, the wall's lighting gradient is naturally reproduced.
 *
 * Phase 2 – Diffusion cleanup:
 *   Any pixels still unfilled after Phase 1 (very large selections) are filled
 *   with a Gauss-Seidel diffusion pass using the Phase-1 result as source.
 *
 * Phase 3 – Seam smoothing:
 *   3-pass weighted smooth on the filled region + a 2-pixel feather into the
 *   surrounding known pixels to eliminate hard visible edges.
 *
 * Messages:
 *   IN  { type:'inpaint', imageData:{width,height,data:ArrayBuffer},
 *                         mask:{width,height,data:ArrayBuffer} }
 *   OUT { type:'progress', pct }
 *   OUT { type:'done',     imageData:{width,height,data} }
 *   OUT { type:'error',    message }
 */

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

/* ── Phase 1: Jacobi gradient fill ──────────────────────────────────────── */
/**
 * For every originally-masked pixel, independently estimate the background
 * colour by sampling only the ORIGINAL known (never-masked) pixels in a large
 * adaptive radius with inverse-distance² weights.
 *
 * Key design choices:
 *  • Reads from `origImg` (frozen) — ensures erased-object colours never
 *    influence the fill, even when scanning row-by-row.
 *  • Checks `origMask` (frozen) — never treats already-filled pixels as source.
 *  • Large radius (≥ half the mask diagonal) ensures every pixel, including the
 *    dead-centre, samples actual wall background on all sides.
 *  • Inverse-distance² naturally weights nearer wall pixels more, so the fill
 *    follows the wall's spatial colour gradient instead of producing a flat average.
 */
function jacobiPhase(img, origImg, origMask, mask, w, h, sampleR, stride) {
  let predicted = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!origMask[y * w + x]) continue   // not originally masked

      const y0 = Math.max(0, y - sampleR), y1 = Math.min(h - 1, y + sampleR)
      const x0 = Math.max(0, x - sampleR), x1 = Math.min(w - 1, x + sampleR)
      const r2  = sampleR * sampleR

      let R = 0, G = 0, B = 0, W = 0
      for (let sy = y0; sy <= y1; sy += stride) {
        for (let sx = x0; sx <= x1; sx += stride) {
          if (origMask[sy * w + sx]) continue    // skip originally masked pixels
          const dx = sx - x, dy = sy - y
          const d2 = dx * dx + dy * dy
          if (d2 > r2) continue                  // circular clip
          const wt = 1.0 / (d2 || 0.25)
          const i4 = (sy * w + sx) * 4
          R += origImg[i4] * wt; G += origImg[i4+1] * wt
          B += origImg[i4+2] * wt;  W += wt
        }
      }
      if (W === 0) continue
      const i4 = (y * w + x) * 4
      img[i4]   = Math.round(R / W)
      img[i4+1] = Math.round(G / W)
      img[i4+2] = Math.round(B / W)
      img[i4+3] = 255
      mask[y * w + x] = 0   // mark as filled
      predicted++
    }
  }
  return predicted
}

/* ── Phase 2: Diffusion cleanup ──────────────────────────────────────────── */
/**
 * Gauss-Seidel diffusion for any pixels Phase 1 couldn't reach
 * (e.g. a fully-masked island with no background within sampleR).
 * Uses Phase-1 results (now stored in img) as source.
 */
function diffusionCleanup(img, mask, w, h) {
  let pass = 0
  while (true) {
    let filled = 0
    const fwd = pass % 2 === 0
    for (let yi = 0; yi < h; yi++) {
      const y = fwd ? yi : h - 1 - yi
      for (let xi = 0; xi < w; xi++) {
        const x = fwd ? xi : w - 1 - xi
        if (!mask[y * w + x]) continue
        let R = 0, G = 0, B = 0, W = 0
        for (let dy = -5; dy <= 5; dy++) {
          for (let dx = -5; dx <= 5; dx++) {
            if (!dx && !dy) continue
            const nx = x + dx, ny = y + dy
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
            if (mask[ny * w + nx]) continue
            const wt = 1.0 / (dx * dx + dy * dy)
            const i4 = (ny * w + nx) * 4
            R += img[i4] * wt; G += img[i4+1] * wt; B += img[i4+2] * wt; W += wt
          }
        }
        if (W === 0) continue
        const i4 = (y * w + x) * 4
        img[i4]   = Math.round(R / W); img[i4+1] = Math.round(G / W)
        img[i4+2] = Math.round(B / W); img[i4+3] = 255
        mask[y * w + x] = 0; filled++
      }
    }
    pass++
    if (filled === 0 || pass > 20) break
  }
}

/* ── Phase 3: Seam smoothing ─────────────────────────────────────────────── */
/**
 * 3-pass weighted smooth over the filled region + a 2-pixel feathered border
 * into the surrounding known pixels.  The border pixels are only lightly
 * affected (20% blend) so wall texture outside the selection is preserved.
 * Using two ping-pong buffers avoids scan-order bias.
 */
function seamSmooth(img, origMask, w, h) {
  // Build smooth zone: filled region + 2px expansion into known border
  const zone = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!origMask[y * w + x]) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = clamp(x + dx, 0, w - 1)
          const ny = clamp(y + dy, 0, h - 1)
          zone[ny * w + nx] = 1
        }
      }
    }
  }

  // Ping-pong buffers so each pass reads clean previous-pass data
  let src = new Uint8ClampedArray(img)
  let dst = new Uint8ClampedArray(img)

  for (let pass = 0; pass < 3; pass++) {
    // swap
    const tmp = src; src = dst; dst = tmp
    // src = previous pass result (or original img on pass 0, since both start equal)

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i4 = (y * w + x) * 4
        if (!zone[y * w + x]) {
          dst[i4] = src[i4]; dst[i4+1] = src[i4+1]
          dst[i4+2] = src[i4+2]; dst[i4+3] = src[i4+3]
          continue
        }
        let R = 0, G = 0, B = 0, W = 0
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = clamp(x + dx, 0, w - 1)
            const ny = clamp(y + dy, 0, h - 1)
            const d2 = dx * dx + dy * dy
            const wt = 1.0 / (d2 || 0.5)
            const qi = (ny * w + nx) * 4
            R += src[qi] * wt; G += src[qi+1] * wt; B += src[qi+2] * wt; W += wt
          }
        }
        // Known border pixels: blend lightly (20%) to avoid smearing wall texture
        const blend = origMask[y * w + x] ? 1.0 : 0.20
        dst[i4]   = Math.round(src[i4]   * (1 - blend) + (R / W) * blend)
        dst[i4+1] = Math.round(src[i4+1] * (1 - blend) + (G / W) * blend)
        dst[i4+2] = Math.round(src[i4+2] * (1 - blend) + (B / W) * blend)
        dst[i4+3] = 255
      }
    }
  }
  return dst   // dst holds the final pass result
}

/* ── Main handler ─────────────────────────────────────────────────────────── */

self.onmessage = ({ data }) => {
  if (data.type !== 'inpaint') return

  const { imageData, mask: maskIn } = data
  const { width: w, height: h }     = imageData

  try {
    if (maskIn.width !== w || maskIn.height !== h)
      throw new Error(`Dimension mismatch: image ${w}×${h} vs mask ${maskIn.width}×${maskIn.height}`)

    const img  = new Uint8Array(imageData.data)
    const mask = new Uint8Array(maskIn.data)

    // Measure mask and compute bounding box for adaptive radius
    let totalMasked = 0
    let minX = w, maxX = 0, minY = h, maxY = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x]) {
          totalMasked++
          if (x < minX) minX = x; if (x > maxX) maxX = x
          if (y < minY) minY = y; if (y > maxY) maxY = y
        }
      }
    }

    if (totalMasked === 0) {
      self.postMessage({ type: 'progress', pct: 100 })
      self.postMessage({ type: 'done', imageData: { width: w, height: h, data: new Uint8ClampedArray(img) } })
      return
    }

    // Adaptive sample radius: must be large enough that even the dead-centre pixel
    // can reach original background on all sides.  Add 30px margin beyond half-diagonal.
    const maskW   = maxX - minX + 1
    const maskH   = maxY - minY + 1
    const halfDiag = Math.ceil(Math.sqrt(maskW * maskW + maskH * maskH) / 2)
    const sampleR  = Math.max(60, halfDiag + 30)
    // Adaptive stride: target ~2 000 candidates per masked pixel
    const stride   = Math.max(2, Math.ceil(sampleR / 22))

    console.log(`[inpaintWorker] gradient fill ${w}×${h}, masked=${totalMasked}, sampleR=${sampleR}, stride=${stride}`)

    const origMask = new Uint8Array(mask)   // never modified — Phase 1 filter & Phase 3 zone
    const origImg  = new Uint8Array(img)    // never modified — Phase 1 samples only from here

    self.postMessage({ type: 'progress', pct: 5 })

    // Phase 1: gradient-aware fill from original background
    jacobiPhase(img, origImg, origMask, mask, w, h, sampleR, stride)
    self.postMessage({ type: 'progress', pct: 75 })

    // Phase 2: diffusion cleanup for any isolated unfilled pixels
    diffusionCleanup(img, mask, w, h)
    self.postMessage({ type: 'progress', pct: 90 })

    // Phase 3: seam smooth + feather into border
    const result = seamSmooth(img, origMask, w, h)
    self.postMessage({ type: 'progress', pct: 100 })
    self.postMessage({ type: 'done', imageData: { width: w, height: h, data: result } })

  } catch (err) {
    console.error('[inpaintWorker] error:', err)
    self.postMessage({ type: 'error', message: err.message })
  }
}

