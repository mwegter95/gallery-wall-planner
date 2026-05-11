/**
 * warpHandles.js
 * Shared constants and utilities for all perspective-warp handle UIs.
 * Imported by WallSetup (Add Wall / Add Surface / Declare Surface) and
 * CropOverlay (re-crop existing surface) so every warp experience is
 * visually and behaviourally identical.
 */

/** SVG offset (viewBox units) from the exact corner to the drag-ring centre */
export const HANDLE_OFFSET = 28

/** Padding added to all sides of the viewBox so offset handles never clip */
export const HANDLE_PAD = HANDLE_OFFSET + 15   // = 43

/** Outward diagonal direction for each corner */
export const HANDLE_DIR = Object.freeze({
  tl: [-1, -1],
  tr: [ 1, -1],
  br: [ 1,  1],
  bl: [-1,  1],
})

/** Per-corner accent colour */
export const HANDLE_COLORS = Object.freeze({
  tl: '#f97316',  // orange
  tr: '#22d3ee',  // cyan
  br: '#a78bfa',  // purple
  bl: '#34d399',  // green
})

/** Fixed SVG coordinate width; height is derived from image aspect ratio */
export const WARP_SVG_W = 540

// ── LiDAR Dimension Measurement ──────────────────────────────────────────────

/**
 * Multiply a column-major 4×4 matrix (16-element flat array, Three.js order)
 * by a 3-D point (implicit w=1), returning [x', y', z', w'].
 *
 * Three.js column-major layout:
 *   e[0]  e[4]  e[8]  e[12]   ← row 0
 *   e[1]  e[5]  e[9]  e[13]   ← row 1
 *   e[2]  e[6]  e[10] e[14]   ← row 2
 *   e[3]  e[7]  e[11] e[15]   ← row 3
 */
export function m4v(e, x, y, z) {
  return [
    e[0]*x + e[4]*y + e[8]*z  + e[12],
    e[1]*x + e[5]*y + e[9]*z  + e[13],
    e[2]*x + e[6]*y + e[10]*z + e[14],
    e[3]*x + e[7]*y + e[11]*z + e[15],
  ]
}

const M_TO_IN    = 39.3701
/** Max squared NDC distance to accept a point as matching a corner (~10 % of screen) */
const MAX_DIST2  = 0.04   // = 0.2 NDC²

/**
 * Estimate the real-world width and height (inches) of the surface whose four
 * corners are marked as fractional positions in a perspective screenshot of a
 * LiDAR scan.
 *
 * Algorithm:
 *   For each corner (fractional screen position), project every LiDAR point
 *   into NDC using the camera matrices captured at screenshot time.  Find the
 *   nearest projected point to each corner.  Compute pairwise 3-D distances
 *   to derive width (top + bottom average) and height (left + right average).
 *
 * @param {Array<[number, number]>} corners
 *   [[fx,fy], …] — TL / TR / BR / BL in [0,1] fractions of the screenshot
 * @param {{ projectionMatrixElements: number[], viewMatrixElements: number[], yOffset?: number }} cameraData
 * @param {{ _data: Float32Array, _len: number }} pointCloud
 * @returns {{ widthIn: number, heightIn: number } | null}
 */
export function computeLidarDims(corners, cameraData, pointCloud) {
  if (!cameraData || !pointCloud || pointCloud._len === 0) return null
  const { projectionMatrixElements: projE, viewMatrixElements: viewE, yOffset = 0 } = cameraData
  if (!projE || !viewE) return null

  const data = pointCloud._data
  const n    = pointCloud._len

  // Fractional [0,1] corners → NDC: x left→right, y bottom→top
  const cornerNDC = corners.map(([fx, fy]) => [fx * 2 - 1, 1 - fy * 2])

  const bestPoints = [null, null, null, null]
  const bestDists  = [Infinity, Infinity, Infinity, Infinity]

  // Subsample to ~25 000 points for real-time performance
  const step = Math.max(1, Math.floor(n / 25_000))

  for (let i = 0; i < n; i += step) {
    const b  = i * 6
    const wx = data[b]
    const wy = data[b + 1] + yOffset   // offset matches scene/camera coordinate frame
    const wz = data[b + 2]

    // World → camera space via view matrix
    const [vx, vy, vz] = m4v(viewE, wx, wy, wz)
    if (vz >= 0) continue   // behind camera (Three.js looks down −Z)

    // Camera space → clip / NDC via projection matrix
    const [cx, cy, , cw] = m4v(projE, vx, vy, vz)
    if (cw <= 0) continue
    const nx = cx / cw
    const ny = cy / cw
    if (nx < -1.05 || nx > 1.05 || ny < -1.05 || ny > 1.05) continue

    for (let c = 0; c < 4; c++) {
      const [cnx, cny] = cornerNDC[c]
      const d2 = (nx - cnx) ** 2 + (ny - cny) ** 2
      if (d2 < bestDists[c]) {
        bestDists[c] = d2
        bestPoints[c] = [wx, wy, wz]   // world-space (y-offset already applied)
      }
    }
  }

  // All four corners must have a point within the search radius
  if (bestPoints.some((p, c) => p === null || bestDists[c] > MAX_DIST2)) return null

  const [tl, tr, br, bl] = bestPoints
  const topW    = Math.hypot(tr[0]-tl[0], tr[1]-tl[1], tr[2]-tl[2])
  const bottomW = Math.hypot(br[0]-bl[0], br[1]-bl[1], br[2]-bl[2])
  const leftH   = Math.hypot(bl[0]-tl[0], bl[1]-tl[1], bl[2]-tl[2])
  const rightH  = Math.hypot(br[0]-tr[0], br[1]-tr[1], br[2]-tr[2])

  const widthM  = (topW + bottomW) / 2
  const heightM = (leftH + rightH) / 2

  return {
    widthIn:  Math.max(1, Math.round(widthM  * M_TO_IN)),
    heightIn: Math.max(1, Math.round(heightM * M_TO_IN)),
  }
}
