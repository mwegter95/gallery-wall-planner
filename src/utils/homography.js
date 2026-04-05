/**
 * Perspective-warp utilities using homography (projective transform).
 *
 * Theory: A homography H maps homogeneous source coords to dest coords:
 *   [xd, yd, 1] ~ H * [xs, ys, 1]
 * We compute H via Direct Linear Transform from 4 point correspondences,
 * then use the INVERSE homography for pixel-level inverse mapping
 * (for each output pixel, find the source pixel to sample from).
 */

/* ── Gaussian elimination (8×8 augmented matrix) ──────────── */
function solveLinear8(A, b) {
  const n = 8
  // Build augmented matrix
  const M = A.map((row, i) => [...row, b[i]])

  for (let col = 0; col < n; col++) {
    // Partial pivot
    let maxRow = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row
    }
    ;[M[col], M[maxRow]] = [M[maxRow], M[col]]

    // Eliminate below
    for (let row = col + 1; row < n; row++) {
      const f = M[row][col] / M[col][col]
      for (let k = col; k <= n; k++) M[row][k] -= f * M[col][k]
    }
  }

  // Back substitution
  const x = new Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    x[i] = M[i][n]
    for (let j = i + 1; j < n; j++) x[i] -= M[i][j] * x[j]
    x[i] /= M[i][i]
  }
  return x
}

/**
 * Compute a 3×3 homography matrix from 4 point correspondences.
 * srcPts / dstPts: [[x0,y0],[x1,y1],[x2,y2],[x3,y3]]
 * Returns a flat 9-element array H (row-major, H[8] = 1, normalized).
 */
export function computeHomography(srcPts, dstPts) {
  const A = []
  const b = []

  for (let i = 0; i < 4; i++) {
    const [sx, sy] = srcPts[i]
    const [dx, dy] = dstPts[i]
    // x equation: h0*sx + h1*sy + h2 - h6*sx*dx - h7*sy*dx = dx
    A.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx])
    b.push(dx)
    // y equation: h3*sx + h4*sy + h5 - h6*sx*dy - h7*sy*dy = dy
    A.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy])
    b.push(dy)
  }

  const h = solveLinear8(A, b)
  return [...h, 1]  // h[8] = 1 (scale normalization)
}

/**
 * Apply homography H to point (x, y).
 * H is a flat 9-element array.
 */
export function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8]
  return [(H[0] * x + H[1] * y + H[2]) / w,
          (H[3] * x + H[4] * y + H[5]) / w]
}

/**
 * Async perspective warp using requestAnimationFrame for chunked processing.
 *
 * @param {HTMLImageElement} imgEl  - The fully-loaded source image
 * @param {number[][]} srcCorners   - [[tl],[tr],[br],[bl]] pixel coords in the source image
 * @param {number} dstW             - Output width in pixels
 * @param {number} dstH             - Output height in pixels
 * @param {function} onProgress     - Called with 0..1 as processing advances
 * @param {object}  [options]       - { transparent: boolean } — preserve alpha channel and output PNG
 * @returns {Promise<string>}       - Resolves to a data URL (JPEG by default, PNG when transparent)
 */
export function warpPerspectiveAsync(imgEl, srcCorners, dstW, dstH, onProgress, options = {}) {
  const { transparent = false } = options
  return new Promise((resolve, reject) => {
    try {
      // --- Read source pixels ---
      const srcW = imgEl.naturalWidth
      const srcH = imgEl.naturalHeight
      const srcCanvas = document.createElement('canvas')
      srcCanvas.width  = srcW
      srcCanvas.height = srcH
      const srcCtx = srcCanvas.getContext('2d')
      srcCtx.drawImage(imgEl, 0, 0)
      const srcData = srcCtx.getImageData(0, 0, srcW, srcH).data

      // --- Homography: destination → source (inverse mapping) ---
      const [tl, tr, br, bl] = srcCorners
      const H = computeHomography(
        [[0, 0], [dstW, 0], [dstW, dstH], [0, dstH]],  // destination rectangle
        [tl, tr, br, bl]                                   // corresponding source corners
      )

      // --- Output buffer ---
      const dstCanvas  = document.createElement('canvas')
      dstCanvas.width  = dstW
      dstCanvas.height = dstH
      const dstCtx     = dstCanvas.getContext('2d')
      const imgData    = dstCtx.createImageData(dstW, dstH)
      const dstData    = imgData.data

      // --- Pre-extract H elements for tight inner loop ---
      const h0 = H[0], h1 = H[1], h2 = H[2]
      const h3 = H[3], h4 = H[4], h5 = H[5]
      const h6 = H[6], h7 = H[7], h8 = H[8]

      const CHUNK = 50   // rows per animation frame
      let dy = 0

      function processChunk() {
        const end = Math.min(dy + CHUNK, dstH)

        for (; dy < end; dy++) {
          for (let dx = 0; dx < dstW; dx++) {
            // Inverse map: dst pixel (dx,dy) → src pixel (sx,sy)
            const w  = h6 * dx + h7 * dy + h8
            const sx = (h0 * dx + h1 * dy + h2) / w
            const sy = (h3 * dx + h4 * dy + h5) / w

            // Bilinear interpolation in source
            const x0 = sx | 0,  y0 = sy | 0
            const x1 = x0 + 1, y1 = y0 + 1

            if (x0 >= 0 && x1 < srcW && y0 >= 0 && y1 < srcH) {
              const fx = sx - x0, fy = sy - y0
              const w00 = (1 - fx) * (1 - fy)
              const w10 = fx       * (1 - fy)
              const w01 = (1 - fx) * fy
              const w11 = fx       * fy

              const i00 = (y0 * srcW + x0) * 4
              const i10 = (y0 * srcW + x1) * 4
              const i01 = (y1 * srcW + x0) * 4
              const i11 = (y1 * srcW + x1) * 4
              const od  = (dy * dstW + dx) * 4

              dstData[od]   = srcData[i00]   * w00 + srcData[i10]   * w10 + srcData[i01]   * w01 + srcData[i11]   * w11
              dstData[od+1] = srcData[i00+1] * w00 + srcData[i10+1] * w10 + srcData[i01+1] * w01 + srcData[i11+1] * w11
              dstData[od+2] = srcData[i00+2] * w00 + srcData[i10+2] * w10 + srcData[i01+2] * w01 + srcData[i11+2] * w11
              dstData[od+3] = transparent
                ? srcData[i00+3] * w00 + srcData[i10+3] * w10 + srcData[i01+3] * w01 + srcData[i11+3] * w11
                : 255
            }
          }
        }

        onProgress?.(dy / dstH)

        if (dy >= dstH) {
          dstCtx.putImageData(imgData, 0, 0)
          resolve(transparent ? dstCanvas.toDataURL('image/png') : dstCanvas.toDataURL('image/jpeg', 0.93))
        } else {
          requestAnimationFrame(processChunk)
        }
      }

      requestAnimationFrame(processChunk)
    } catch (err) {
      reject(err)
    }
  })
}
