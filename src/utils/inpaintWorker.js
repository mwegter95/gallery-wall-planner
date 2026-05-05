/**
 * inpaintWorker.js — Classic (non-module) Web Worker.
 *
 * Implements diffusion-based inpainting: iteratively fills masked pixels by
 * blending inward from the known surrounding pixels.  This works well for
 * uniform/textured backgrounds (walls, floors, sky) — it produces smooth,
 * natural-looking results without the risk of copy-paste artefacts.
 *
 * Algorithm overview:
 *   1.  Collect all masked ("unknown") pixels that have at least one known
 *       neighbour — the "fill front".
 *   2.  For each fill-front pixel compute a weighted average of known pixels
 *       in a small window (inverse-distance² weights, 7×7 kernel).
 *   3.  Write the new colour; mark pixel as known; advance the front.
 *   4.  Repeat until all masked pixels are filled.  Alternating scan direction
 *       each pass avoids directional bias.
 *   5.  Two Gaussian smoothing passes on the originally-masked region to
 *       blend hard fill edges seamlessly into the background.
 *
 * No external dependencies — pure typed-array arithmetic.
 * Messages:
 *   IN  { type:'inpaint', imageData:{width,height,data:ArrayBuffer},
 *                         mask:{width,height,data:ArrayBuffer} }
 *   OUT { type:'progress', pct }
 *   OUT { type:'done',     imageData:{width,height,data:Uint8ClampedArray} }
 *   OUT { type:'error',    message }
 */

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

/**
 * One diffusion sweep across the image.
 * For each still-masked pixel, compute a weighted average of all KNOWN pixels
 * in a 7×7 window (inverse-distance² weights) and write the result.
 * Marks filled pixels as known immediately (Gauss-Seidel style — converges faster).
 * @returns number of pixels filled this sweep
 */
function sweep(img, mask, w, h, fwd) {
  let filled = 0
  for (let yi = 0; yi < h; yi++) {
    const y = fwd ? yi : h - 1 - yi
    for (let xi = 0; xi < w; xi++) {
      const x = fwd ? xi : w - 1 - xi
      if (!mask[y * w + x]) continue   // already known

      let R = 0, G = 0, B = 0, W = 0
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx, ny = y + dy
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
          if (mask[ny * w + nx]) continue   // also unknown — skip
          const d2 = dx * dx + dy * dy
          const wt = 1.0 / d2
          const i4 = (ny * w + nx) * 4
          R += img[i4]     * wt
          G += img[i4 + 1] * wt
          B += img[i4 + 2] * wt
          W += wt
        }
      }
      if (W === 0) continue   // no known neighbours yet — reached in a later pass

      const i4 = (y * w + x) * 4
      img[i4]     = Math.round(R / W)
      img[i4 + 1] = Math.round(G / W)
      img[i4 + 2] = Math.round(B / W)
      img[i4 + 3] = 255
      mask[y * w + x] = 0
      filled++
    }
  }
  return filled
}

/**
 * Fallback for isolated fully-masked islands: expands search radius up to 16px.
 */
function fillIsolated(img, mask, w, h) {
  let remaining = 0
  for (let i = 0; i < mask.length; i++) if (mask[i]) remaining++
  if (remaining === 0) return

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue
      let R = 0, G = 0, B = 0, W = 0
      outer: for (let r = 4; r <= 24; r += 2) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const nx = x + dx, ny = y + dy
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
            if (mask[ny * w + nx]) continue
            const d2 = dx * dx + dy * dy
            const wt = 1.0 / d2
            const i4 = (ny * w + nx) * 4
            R += img[i4] * wt; G += img[i4+1] * wt; B += img[i4+2] * wt; W += wt
          }
        }
        if (W > 0) break outer
      }
      if (W === 0) continue
      const i4 = (y * w + x) * 4
      img[i4]   = Math.round(R / W)
      img[i4+1] = Math.round(G / W)
      img[i4+2] = Math.round(B / W)
      img[i4+3] = 255
      mask[y * w + x] = 0
    }
  }
}

/**
 * Two-pass Gaussian smoothing confined to the originally-masked region.
 * Blends fill edges seamlessly into the surrounding background.
 */
function smoothFilled(img, origMask, w, h) {
  const tmp = new Uint8ClampedArray(img)
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!origMask[y * w + x]) continue   // only touch originally-masked area
        let R = 0, G = 0, B = 0, n = 0
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = clamp(x + dx, 0, w - 1)
            const ny = clamp(y + dy, 0, h - 1)
            const i4 = (ny * w + nx) * 4
            R += tmp[i4]; G += tmp[i4 + 1]; B += tmp[i4 + 2]
            n++
          }
        }
        const i4 = (y * w + x) * 4
        tmp[i4]     = Math.round(R / n)
        tmp[i4 + 1] = Math.round(G / n)
        tmp[i4 + 2] = Math.round(B / n)
        tmp[i4 + 3] = 255
      }
    }
    if (pass === 0) img.set(tmp)
  }
  return tmp
}

/* ── Main handler ─────────────────────────────────────────────────────────── */

self.onmessage = ({ data }) => {
  if (data.type !== 'inpaint') return

  const { imageData, mask: maskIn } = data
  const { width: w, height: h }     = imageData

  try {
    // imageData.data and maskIn.data arrive as ArrayBuffer (transferred via Transferable)
    const img  = new Uint8Array(imageData.data)
    const mask = new Uint8Array(maskIn.data)   // 1 = fill, 0 = keep

    if (maskIn.width !== w || maskIn.height !== h) {
      throw new Error(`Dimension mismatch: image ${w}×${h} vs mask ${maskIn.width}×${maskIn.height}`)
    }

    let totalMasked = 0
    for (let i = 0; i < mask.length; i++) if (mask[i]) totalMasked++

    console.log(`[inpaintWorker] diffusion fill ${w}×${h}, masked=${totalMasked}`)

    if (totalMasked === 0) {
      self.postMessage({ type: 'progress', pct: 100 })
      self.postMessage({ type: 'done', imageData: { width: w, height: h, data: new Uint8ClampedArray(img) } })
      return
    }

    const origMask = new Uint8Array(mask)
    let remaining  = totalMasked
    let pass       = 0

    while (remaining > 0) {
      const filled = sweep(img, mask, w, h, pass % 2 === 0)
      remaining -= filled
      pass++

      // If no progress: isolated pixels — use wide-radius fallback
      if (filled === 0 && remaining > 0) {
        fillIsolated(img, mask, w, h)
        // Recount
        remaining = 0
        for (let i = 0; i < mask.length; i++) if (mask[i]) remaining++
        break   // stop main loop — isolated islands handled
      }

      const pct = Math.round(((totalMasked - remaining) / totalMasked) * 90)
      self.postMessage({ type: 'progress', pct })
    }

    const result = smoothFilled(img, origMask, w, h)

    self.postMessage({ type: 'progress', pct: 100 })
    self.postMessage({
      type: 'done',
      imageData: { width: w, height: h, data: result },
    })
  } catch (err) {
    console.error('[inpaintWorker] error:', err)
    self.postMessage({ type: 'error', message: err.message })
  }
}

