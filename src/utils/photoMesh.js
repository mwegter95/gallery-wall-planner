/**
 * photoMesh.js
 *
 * Re-textures a LiDAR point cloud with high-res photo colours sampled from
 * snapshots taken during the scan. Each snapshot carries:
 *   { dataUrl, transform: [16 floats, col-major cam→world], intrinsics: [fx,fy,cx,cy,w,h] }
 *
 * Algorithm for each point P in world space:
 *   1. Transform P into each snapshot's camera space: cp = V * P  (V = inverse(transform))
 *   2. Skip if cp.z ≥ 0 (behind camera) or projected UV is outside image bounds.
 *   3. Score = cosine of angle from camera axis = (-cp.z) / |cp| (want ≈ 1 = dead-on).
 *   4. Pick the snapshot with the highest score (most directly facing the point).
 *   5. Sample that JPEG at the projected pixel; replace the depth-sensor colour.
 *
 * Coordinate system (ARKit):
 *   - Camera looks along –Z in camera space.
 *   - Y is up, X is right.
 *   - Projection:  u = fx*(cp.x / –cp.z) + cx,  v = fy*(cp.y / –cp.z) + cy
 *
 * Performance: ~1–2 s for 10 M points × 20 snapshots in a modern browser (V8 JIT).
 * The loop yields to the browser every 200 K points to keep the UI responsive.
 */

/** ── Invert a rigid-body (rotation + translation) 4×4 column-major matrix ── */
function invertRigid(t) {
  // Rotation part: R^T (transpose of the upper-left 3×3)
  const r00 = t[0], r10 = t[1], r20 = t[2]
  const r01 = t[4], r11 = t[5], r21 = t[6]
  const r02 = t[8], r12 = t[9], r22 = t[10]
  // Translation: –R^T · p
  const px = t[12], py = t[13], pz = t[14]
  const itx = -(r00*px + r10*py + r20*pz)
  const ity = -(r01*px + r11*py + r21*pz)
  const itz = -(r02*px + r12*py + r22*pz)
  // Column-major output: row-major view of the transposed rotation + new translation
  return new Float32Array([
    r00, r01, r02, 0,
    r10, r11, r12, 0,
    r20, r21, r22, 0,
    itx, ity, itz, 1,
  ])
}

/** Load a data URL or base64 JPEG payload into ImageData via an offscreen canvas. */
function loadPixels(snapshot) {
  return new Promise((resolve, reject) => {
    const src = snapshot.dataUrl || (snapshot.jpegB64 ? `data:image/jpeg;base64,${snapshot.jpegB64}` : null)
    if (!src) {
      reject(new Error('Snapshot has no image source'))
      return
    }
    const img = new Image()
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight
      const cv = document.createElement('canvas')
      cv.width = w; cv.height = h
      const ctx = cv.getContext('2d')
      ctx.drawImage(img, 0, 0)
      resolve({ data: ctx.getImageData(0, 0, w, h).data, width: w, height: h })
    }
    img.onerror = reject
    img.src = src
  })
}

function bilinearSampleRGBA(pix, width, height, u, v) {
  const x = Math.max(0, Math.min(width - 1, u))
  const y = Math.max(0, Math.min(height - 1, v))
  const x0 = x | 0
  const y0 = y | 0
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const tx = x - x0
  const ty = y - y0
  const i00 = (y0 * width + x0) * 4
  const i10 = (y0 * width + x1) * 4
  const i01 = (y1 * width + x0) * 4
  const i11 = (y1 * width + x1) * 4

  const w00 = (1 - tx) * (1 - ty)
  const w10 = tx * (1 - ty)
  const w01 = (1 - tx) * ty
  const w11 = tx * ty

  return [
    (pix[i00] * w00 + pix[i10] * w10 + pix[i01] * w01 + pix[i11] * w11) / 255,
    (pix[i00 + 1] * w00 + pix[i10 + 1] * w10 + pix[i01 + 1] * w01 + pix[i11 + 1] * w11) / 255,
    (pix[i00 + 2] * w00 + pix[i10 + 2] * w10 + pix[i01 + 2] * w01 + pix[i11 + 2] * w11) / 255,
  ]
}

export function normalizeIntrinsicsForImage(intrinsics, width, height) {
  if (!Array.isArray(intrinsics) || intrinsics.length < 6) return null
  const fx = intrinsics[0]
  const fy = intrinsics[1]
  const cx = intrinsics[2]
  const cy = intrinsics[3]
  const srcW = intrinsics[4]
  const srcH = intrinsics[5]
  const dstW = Number.isFinite(width) && width > 0 ? width : srcW
  const dstH = Number.isFinite(height) && height > 0 ? height : srcH
  const sx = Number.isFinite(srcW) && srcW > 0 ? dstW / srcW : 1
  const sy = Number.isFinite(srcH) && srcH > 0 ? dstH / srcH : 1
  return [fx * sx, fy * sy, cx * sx, cy * sy, dstW, dstH]
}

/**
 * Apply photo colours to mesh vertices produced by reconstructSurface().
 *
 * Vertex positions include yOffset (floor at y=0), but snapshot camera transforms
 * are in ARKit world space (no yOffset).  We subtract yOffset before projecting.
 *
 * @param {Float32Array} positions  [x,y,z …] in display coords (yOffset applied)
 * @param {Float32Array} fallback   [r,g,b …] base colours when no snapshot covers a vertex
 * @param {{ dataUrl:string, transform:number[], intrinsics:number[] }[]} snapshots
 * @param {number} [yOffset=0]
 * @returns {Promise<Float32Array | null>}
 */
export async function buildPhotoColorsForPositions(positions, fallback, snapshots, yOffset = 0) {
  const n = (positions.length / 3) | 0
  if (n === 0 || !snapshots?.length) return null
  // Assemble a fake PointCloudBuffer row layout: [x, y_arkit, z, r, g, b]
  const data = new Float32Array(n * 6)
  for (let i = 0; i < n; i++) {
    data[i*6]   = positions[i*3]
    data[i*6+1] = positions[i*3+1] - yOffset   // display → ARKit world Y
    data[i*6+2] = positions[i*3+2]
    data[i*6+3] = fallback[i*3]
    data[i*6+4] = fallback[i*3+1]
    data[i*6+5] = fallback[i*3+2]
  }
  return buildPhotoColors({ _data: data, pointCount: n }, snapshots)
}

/**
 * Build a new Float32Array of per-point RGB colours by projecting each point
 * through the best-covering snapshot.
 *
 * @param {import('./pointCloud').PointCloudBuffer} buf
 * @param {{ dataUrl?:string, jpegB64?:string, transform:number[], intrinsics:number[] }[]} snapshots
 * @returns {Promise<Float32Array | null>}
 */
export async function buildPhotoColors(buf, snapshots) {
  if (!snapshots?.length) return null

  const n = buf.pointCount
  if (n === 0) return null

  // ── Load all snapshot images in parallel ─────────────────────────────────
  let pixMaps
  try {
    pixMaps = await Promise.all(snapshots.map(loadPixels))
  } catch (err) {
    console.warn('[photoMesh] Failed to load snapshot images:', err)
    return null
  }

  const S = snapshots.length

  // ── Per-point colour replacement ──────────────────────────────────────────
  const D         = buf._data               // zero-copy raw Float32Array
  const newColors = new Float32Array(n * 3)
  const YIELD_EVERY = 200_000               // yield to browser every 200 K pts

  // ── Precompute per-snapshot data ──────────────────────────────────────────
  // views[si]  = column-major 4×4 world→camera matrix (inverse of cam→world)
  // intrs[si]  = [fx, fy, cx, cy, imgW, imgH]
  const views = snapshots.map(s => invertRigid(s.transform))
  const intrs = snapshots.map((s, index) => normalizeIntrinsicsForImage(s.intrinsics, pixMaps[index].width, pixMaps[index].height))

  for (let i = 0; i < n; i++) {
    // Yield to browser to keep UI responsive
    if (i > 0 && i % YIELD_EVERY === 0) {
      await new Promise(r => setTimeout(r, 0))
    }

    const b  = i * 6
    const wx = D[b],  wy = D[b+1], wz = D[b+2]   // original world coords (no yOffset)
    const or = D[b+3], og = D[b+4], ob = D[b+5]   // depth-sensor fallback colour

    let bestCandidate = null

    for (let si = 0; si < S; si++) {
      const V = views[si]
      // Multiply column-major 4×4 by [wx, wy, wz, 1]
      const cpx = V[0]*wx + V[4]*wy + V[8]*wz  + V[12]
      const cpy = V[1]*wx + V[5]*wy + V[9]*wz  + V[13]
      const cpz = V[2]*wx + V[6]*wy + V[10]*wz + V[14]
      if (cpz >= 0) continue                       // behind camera

      const intr = intrs[si]
      if (!intr) continue
      const fw   = intr[4], fh = intr[5]
      const negZ = -cpz
      const u    = intr[0] * cpx / negZ + intr[2]
      const v    = intr[1] * cpy / negZ + intr[3]
      if (u < 0 || v < 0 || u >= fw || v >= fh) continue  // outside frame

      // Score balances view alignment with proximity so closer snapshots win
      // when angles are similar (less blur / less reprojection drift).
      const score = ((negZ * negZ) / (cpx*cpx + cpy*cpy + negZ*negZ)) / (1.0 + 0.08 * negZ)
      if (!bestCandidate || score > bestCandidate.score) {
        bestCandidate = { si, score, u, v }
      }
    }

    if (bestCandidate) {
      const px = pixMaps[bestCandidate.si]
      const [r, g, b] = bilinearSampleRGBA(px.data, px.width, px.height, bestCandidate.u, bestCandidate.v)
      newColors[i*3]   = r
      newColors[i*3+1] = g
      newColors[i*3+2] = b
    } else {
      // No snapshot covers this point — keep original depth-sensor colour
      newColors[i*3]   = or
      newColors[i*3+1] = og
      newColors[i*3+2] = ob
    }
  }

  return newColors
}
