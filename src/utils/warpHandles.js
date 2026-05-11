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
/**
 * Max NDC distance to accept a corner match.  0.7 NDC = 35 % of screen —
 * generous enough that dragging a handle near a wall surface always finds a
 * match, but large enough to reject corners deliberately placed in empty space.
 */
const MAX_NDC_DIST = 0.7

/** Round a value to the nearest 0.5 */
const roundHalf = (v) => Math.round(v * 2) / 2

/**
 * Estimate the real-world width and height (inches) of the surface whose four
 * corners are marked as fractional positions in a perspective screenshot of a
 * LiDAR scan.
 *
 * Algorithm:
 *   For each corner (fractional screen position), project every LiDAR point
 *   into NDC using the camera matrices captured at screenshot time.  Find the
 *   nearest projected point to each corner (no hard distance cutoff — just
 *   best-nearest).  Reject the whole result only if any corner's nearest
 *   match is farther than MAX_NDC_DIST (corner placed way off the point cloud).
 *   Compute pairwise 3-D distances: width = average(top-edge, bottom-edge),
 *   height = average(left-edge, right-edge).
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

  // Subsample to ~40 000 points for real-time performance without missing wall clusters
  const step = Math.max(1, Math.floor(n / 40_000))

  for (let i = 0; i < n; i += step) {
    const b  = i * 6
    const wx = data[b]
    const wy = data[b + 1] + yOffset   // apply scene floor-offset to match camera space
    const wz = data[b + 2]

    // World → camera space via view matrix (matrixWorldInverse)
    const [vx, vy, vz] = m4v(viewE, wx, wy, wz)
    if (vz >= 0) continue   // behind camera (Three.js looks down −Z)

    // Camera space → clip / NDC via projection matrix
    const [cx, cy, , cw] = m4v(projE, vx, vy, vz)
    if (cw <= 0) continue
    const nx = cx / cw
    const ny = cy / cw
    if (nx < -1.1 || nx > 1.1 || ny < -1.1 || ny > 1.1) continue

    for (let c = 0; c < 4; c++) {
      const [cnx, cny] = cornerNDC[c]
      const d2 = (nx - cnx) ** 2 + (ny - cny) ** 2
      if (d2 < bestDists[c]) {
        bestDists[c]  = d2
        bestPoints[c] = [wx, wy, wz]   // world-space (yOffset already applied to wy)
      }
    }
  }

  // Reject if any corner has no match or is placed far off the point cloud
  const maxAllowed = MAX_NDC_DIST ** 2
  if (bestPoints.some((p, c) => p === null || bestDists[c] > maxAllowed)) return null

  const [tl, tr, br, bl] = bestPoints
  const dist3 = (a, b) => Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2])

  const widthM  = (dist3(tl, tr) + dist3(bl, br)) / 2
  const heightM = (dist3(tl, bl) + dist3(tr, br)) / 2

  return {
    widthIn:  Math.max(6, roundHalf(widthM  * M_TO_IN)),
    heightIn: Math.max(6, roundHalf(heightM * M_TO_IN)),
  }
}
