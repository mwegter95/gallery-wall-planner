/**
 * photoMesh.js
 *
 * Projects high-res snapshot photos onto LiDAR point/mesh data by finding,
 * for each vertex/point, the snapshot that covers it most directly (highest
 * cos² off-axis angle) and sampling that JPEG at the projected pixel.
 *
 * Used in two ways:
 *   buildPhotoColors(buf, snapshots)
 *     — colors a PointCloudBuffer in-place; buf._data is [x,y,z,r,g,b] per pt.
 *   buildPhotoColorsForPositions(positions, fallback, snapshots, yOffset)
 *     — convenience wrapper for separate position/color arrays (mesh vertices).
 *
 * Coordinate system (ARKit):
 *   Camera looks along –Z.  Y is up, X is right.
 *   Projection:  u = fx*(cp.x / –cp.z) + cx,  v = fy*(cp.y / –cp.z) + cy
 *   transform[] = 16-float column-major cam→world matrix.
 */

/** Invert a rigid-body (R + t) 4×4 column-major matrix. */
function invertRigid(t) {
  const r00=t[0],r10=t[1],r20=t[2], r01=t[4],r11=t[5],r21=t[6], r02=t[8],r12=t[9],r22=t[10]
  const px=t[12],py=t[13],pz=t[14]
  const itx=-(r00*px+r10*py+r20*pz), ity=-(r01*px+r11*py+r21*pz), itz=-(r02*px+r12*py+r22*pz)
  return new Float32Array([r00,r01,r02,0, r10,r11,r12,0, r20,r21,r22,0, itx,ity,itz,1])
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
 * Build a Float32Array of per-point RGB colours by projecting each point
 * through the best-covering snapshot (highest cos² off-axis angle).
 *
 * @param {{ _data: Float32Array, pointCount: number }} buf
 *   _data layout: [x, y, z, r, g, b] per point, in ARKit world space.
 * @param {{ dataUrl:string, transform:number[], intrinsics:number[] }[]} snapshots
 *   intrinsics: [fx, fy, cx, cy, imageW, imageH]
 * @returns {Promise<Float32Array | null>}  RGB in [0,1], length = pointCount*3
 */
export async function buildPhotoColors(buf, snapshots) {
  if (!snapshots?.length) return null
  const n = buf.pointCount
  if (n === 0) return null

  // Load all snapshot images in parallel
  let pixMaps
  try {
    pixMaps = await Promise.all(snapshots.map(s => loadPixels(s.dataUrl)))
  } catch (err) {
    console.warn('[photoMesh] Failed to load snapshot images:', err)
    return null
  }

  const S     = snapshots.length
  const views = snapshots.map(s => invertRigid(s.transform))
  const intrs = snapshots.map(s => s.intrinsics)

  const D         = buf._data
  const newColors = new Float32Array(n * 3)
  const YIELD_EVERY = 200_000

  for (let i = 0; i < n; i++) {
    if (i > 0 && i % YIELD_EVERY === 0) {
      await new Promise(r => setTimeout(r, 0))
    }

    const b  = i * 6
    const wx = D[b], wy = D[b+1], wz = D[b+2]
    const or = D[b+3], og = D[b+4], ob = D[b+5]

    let bestSnap  = -1
    let bestScore = 0  // cos²(off-axis angle) — avoids sqrt, ranks correctly

    for (let si = 0; si < S; si++) {
      const V = views[si]
      const cpx = V[0]*wx + V[4]*wy + V[8]*wz  + V[12]
      const cpy = V[1]*wx + V[5]*wy + V[9]*wz  + V[13]
      const cpz = V[2]*wx + V[6]*wy + V[10]*wz + V[14]
      if (cpz >= 0) continue  // behind camera

      const intr = intrs[si]
      const fw = intr[4], fh = intr[5]
      const negZ = -cpz
      const u = intr[0] * cpx / negZ + intr[2]
      const v = intr[1] * cpy / negZ + intr[3]
      if (u < 0 || v < 0 || u >= fw || v >= fh) continue

      const score = (negZ * negZ) / (cpx*cpx + cpy*cpy + negZ*negZ)
      if (score > bestScore) { bestScore = score; bestSnap = si }
    }

    if (bestSnap >= 0) {
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
      newColors[i*3]   = or
      newColors[i*3+1] = og
      newColors[i*3+2] = ob
    }
  }

  return newColors
}

/**
 * Convenience wrapper: builds photo colors from separate positions/fallback
 * arrays rather than a PointCloudBuffer.
 *
 * positions: Float32Array [x,y,z …] in display coords (yOffset already applied).
 * fallback:  Float32Array [r,g,b …] base colours when no snapshot covers a vertex.
 * yOffset:   the offset that was added to Y to put the floor at y=0 — we subtract
 *            it back so the ARKit world-space projection is correct.
 */
export async function buildPhotoColorsForPositions(positions, fallback, snapshots, yOffset = 0) {
  const n = (positions.length / 3) | 0
  if (n === 0 || !snapshots?.length) return null
  const data = new Float32Array(n * 6)
  for (let i = 0; i < n; i++) {
    data[i*6]   = positions[i*3]
    data[i*6+1] = positions[i*3+1] - yOffset  // display → ARKit world Y
    data[i*6+2] = positions[i*3+2]
    data[i*6+3] = fallback[i*3]
    data[i*6+4] = fallback[i*3+1]
    data[i*6+5] = fallback[i*3+2]
  }
  return buildPhotoColors({ _data: data, pointCount: n }, snapshots)
}
