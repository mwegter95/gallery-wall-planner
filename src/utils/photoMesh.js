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

/** Load a data URL into ImageData (RGBA Uint8ClampedArray) via an offscreen canvas. */
function loadPixels(dataUrl) {
  return new Promise((resolve, reject) => {
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
    img.src = dataUrl
  })
}

/**
 * Build a new Float32Array of per-point RGB colours by projecting each point
 * through the best-covering snapshot.
 *
 * @param {import('./pointCloud').PointCloudBuffer} buf
 * @param {{ dataUrl:string, transform:number[], intrinsics:number[] }[]} snapshots
 * @returns {Promise<Float32Array | null>}
 */
export async function buildPhotoColors(buf, snapshots) {
  if (!snapshots?.length) return null

  const n = buf.pointCount
  if (n === 0) return null

  // ── Load all snapshot images in parallel ─────────────────────────────────
  let pixMaps
  try {
    pixMaps = await Promise.all(snapshots.map(s => loadPixels(s.dataUrl)))
  } catch (err) {
    console.warn('[photoMesh] Failed to load snapshot images:', err)
    return null
  }

  const S = snapshots.length

  // ── Precompute per-snapshot data ──────────────────────────────────────────
  // views[si]  = column-major 4×4 world→camera matrix (inverse of cam→world)
  // intrs[si]  = [fx, fy, cx, cy, imgW, imgH]
  const views = snapshots.map(s => invertRigid(s.transform))
  const intrs = snapshots.map(s => s.intrinsics)   // already [fx,fy,cx,cy,w,h]

  // ── Per-point colour replacement ──────────────────────────────────────────
  const D         = buf._data               // zero-copy raw Float32Array
  const newColors = new Float32Array(n * 3)
  const YIELD_EVERY = 200_000               // yield to browser every 200 K pts

  for (let i = 0; i < n; i++) {
    // Yield to browser to keep UI responsive
    if (i > 0 && i % YIELD_EVERY === 0) {
      await new Promise(r => setTimeout(r, 0))
    }

    const b  = i * 6
    const wx = D[b],  wy = D[b+1], wz = D[b+2]   // original world coords (no yOffset)
    const or = D[b+3], og = D[b+4], ob = D[b+5]   // depth-sensor fallback colour

    let bestSnap  = -1
    let bestScore = 0   // cos²(off-axis angle) — avoids sqrt, still ranks correctly

    for (let si = 0; si < S; si++) {
      const V = views[si]
      // Multiply column-major 4×4 by [wx, wy, wz, 1]
      const cpx = V[0]*wx + V[4]*wy + V[8]*wz  + V[12]
      const cpy = V[1]*wx + V[5]*wy + V[9]*wz  + V[13]
      const cpz = V[2]*wx + V[6]*wy + V[10]*wz + V[14]
      if (cpz >= 0) continue                       // behind camera

      const intr = intrs[si]
      const fw   = intr[4], fh = intr[5]
      const negZ = -cpz
      const u    = intr[0] * cpx / negZ + intr[2]
      const v    = intr[1] * cpy / negZ + intr[3]
      if (u < 0 || v < 0 || u >= fw || v >= fh) continue  // outside frame

      // cos²(angle) = negZ² / (cpx²+cpy²+negZ²) — avoids sqrt, monotone with cos
      const score = (negZ * negZ) / (cpx*cpx + cpy*cpy + negZ*negZ)
      if (score > bestScore) { bestScore = score; bestSnap = si }
    }

    if (bestSnap >= 0) {
      // Recompute UV for the winner
      const V    = views[bestSnap]
      const cpx  = V[0]*wx + V[4]*wy + V[8]*wz  + V[12]
      const cpy  = V[1]*wx + V[5]*wy + V[9]*wz  + V[13]
      const cpz  = V[2]*wx + V[6]*wy + V[10]*wz + V[14]
      const intr = intrs[bestSnap]
      const fw   = intr[4], fh = intr[5]
      const negZ = -cpz
      const u    = intr[0] * cpx / negZ + intr[2]
      const v    = intr[1] * cpy / negZ + intr[3]
      const px   = pixMaps[bestSnap]
      const ix   = Math.min(fw - 1, Math.max(0, u | 0))
      const iy   = Math.min(fh - 1, Math.max(0, v | 0))
      const pidx = (iy * px.width + ix) * 4
      newColors[i*3]   = px.data[pidx]   / 255
      newColors[i*3+1] = px.data[pidx+1] / 255
      newColors[i*3+2] = px.data[pidx+2] / 255
    } else {
      // No snapshot covers this point — keep original depth-sensor colour
      newColors[i*3]   = or
      newColors[i*3+1] = og
      newColors[i*3+2] = ob
    }
  }

  return newColors
}
