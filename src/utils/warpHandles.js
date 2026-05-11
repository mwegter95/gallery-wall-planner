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
 * match, but rejects anchors that land in pure empty space far from any scan
 * geometry (corners dragged off the point cloud entirely).
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
  if (!cameraData || !pointCloud) return null
  const { projectionMatrixElements: projE, viewMatrixElements: viewE, yOffset = 0 } = cameraData
  if (!projE || !viewE) return null

  const source = pointCloud._buffer ?? pointCloud
  const data = source._data
  const n    = source._len ?? source.pointCount ?? 0
  if (!data || n === 0) return null

  const midpoint = (a, b) => [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5]
  const [tl, tr, br, bl] = corners

  // Measurement cross: always anchor at the center of each wall edge.
  // Width  = 3-D distance between left-edge midpoint and right-edge midpoint.
  // Height = 3-D distance between top-edge midpoint and bottom-edge midpoint.
  // This is automatic — it does not depend on the user dragging extra handles.
  const edgeAnchors = [
    midpoint(tl, tr),   // top edge center
    midpoint(tr, br),   // right edge center
    midpoint(br, bl),   // bottom edge center
    midpoint(bl, tl),   // left edge center
  ]

  const toNDC = ([fx, fy]) => [fx * 2 - 1, 1 - fy * 2]

  // TOP_K: for each anchor we keep the K nearest projected points by NDC
  // distance.  After the search we pick the median view-space depth among
  // those K candidates.  This rejects:
  //   • single-point outliers (sensor noise that projects close but is far off
  //     the wall surface in depth)
  //   • foreground objects (furniture etc.) that are closer in depth but whose
  //     surface is not the wall we are measuring
  // The median tends to land on the dominant surface at that screen location,
  // which for edge-center anchors is the wall.
  const TOP_K = 7

  const measure = (anchorSet, mode) => {
    const anchorNDC = anchorSet.map(toNDC)
    // top-K candidates per anchor: [{ d2, vz, wx, wy, wz }]
    const topK = [[], [], [], []]

    for (let i = 0; i < n; i += step) {
      const b  = i * 6
      const wx = data[b]
      const wy = data[b + 1] + yOffset
      const wz = data[b + 2]

      const [vx, vy, vz] = m4v(viewE, wx, wy, wz)
      if (vz >= 0) continue

      const [cx, cy, , cw] = m4v(projE, vx, vy, vz)
      if (cw <= 0) continue
      const nx = cx / cw
      const ny = cy / cw
      if (nx < -1.1 || nx > 1.1 || ny < -1.1 || ny > 1.1) continue

      for (let c = 0; c < 4; c++) {
        const [cnx, cny] = anchorNDC[c]
        const d2 = (nx - cnx) ** 2 + (ny - cny) ** 2
        const bucket = topK[c]
        if (bucket.length < TOP_K) {
          bucket.push({ d2, vz, wx, wy, wz })
          if (bucket.length === TOP_K) bucket.sort((a, b) => a.d2 - b.d2)
        } else if (d2 < bucket[TOP_K - 1].d2) {
          bucket[TOP_K - 1] = { d2, vz, wx, wy, wz }
          bucket.sort((a, b) => a.d2 - b.d2)
        }
      }
    }

    // For each anchor: from top-K candidates, pick the one with median vz
    // (view-space Z, most-negative = farthest).  Sorting by vz ascending
    // means index 0 is farthest (most negative).  The median is the dominant
    // surface at that screen position, filtering out stray foreground hits.
    const maxAllowed = MAX_NDC_DIST ** 2
    const bestPoints = topK.map(bucket => {
      if (bucket.length === 0 || bucket[0].d2 > maxAllowed) return null
      // Sort by view-space depth: ascending vz = farthest-first (vz is negative).
      bucket.sort((a, b) => a.vz - b.vz)
      const pick = bucket[Math.floor(bucket.length / 2)]
      return [pick.wx, pick.wy, pick.wz]
    })

    if (bestPoints.some(p => p === null)) return null

    const [a0, a1, a2, a3] = bestPoints
    const dist3 = (a, b) => Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2])
    const widthM  = mode === 'edges'
      ? dist3(a3, a1)
      : (dist3(a0, a1) + dist3(a3, a2)) / 2
    const heightM = mode === 'edges'
      ? dist3(a0, a2)
      : (dist3(a0, a3) + dist3(a1, a2)) / 2

    return {
      widthIn:  Math.max(6, roundHalf(widthM  * M_TO_IN)),
      heightIn: Math.max(6, roundHalf(heightM * M_TO_IN)),
    }
  }

  // Subsample to ~200 000 points — 5× more than before for better spatial
  // coverage of wall edges without sacrificing real-time response.
  const step = Math.max(1, Math.floor(n / 200_000))
  return measure(edgeAnchors, 'edges')
}
