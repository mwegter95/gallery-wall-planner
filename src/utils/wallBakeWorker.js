/**
 * wallBakeWorker.js — WPA-12 RANSAC plane detection for photo→wall baking.
 *
 * Runs in a classic Web Worker (no ES modules). Receives the deduplicated
 * point cloud + bounds, returns up to 8 wall planes + floor + ceiling with
 * full geometry (normal, offset, in-plane bounding box).
 *
 * Pipeline:
 *   1.  Y-histogram → seed floor & ceiling candidate slabs.
 *   2.  RANSAC vertical-normal floor (1000 trials, threshold 5 cm).
 *   3.  RANSAC vertical-normal ceiling (1000 trials).
 *   4.  Mark floor + ceiling inliers as consumed.
 *   5.  Iterate up to 8 times finding the largest remaining horizontal-normal
 *       wall plane (RANSAC 500 trials).  Stop when best plane has < 2 % of
 *       the original point count.
 *   6.  Per plane: refine normal/offset via covariance eigendecomposition on
 *       all inliers, then compute oriented bounding box in plane-local 2D.
 *
 * Posts progress messages so SpaceBuilderCanvas can report scan-load percent.
 *
 * Message protocol:
 *   IN  { type: 'detect', pts: Float32Array (xyz interleaved, 3 floats/point),
 *         count: int, bounds: {minX,maxX,minY,maxY,minZ,maxZ} }
 *   OUT { type: 'progress', pct: 0-100, phase: string }
 *   OUT { type: 'done', planes: [{type, normal[3], offset, centroid[3],
 *                                  uAxis[3], vAxis[3], uMin, uMax, vMin, vMax,
 *                                  inlierCount}] }
 *   OUT { type: 'error', message: string }
 */

// ── RNG: deterministic for reproducibility ────────────────────────────────────
let _rngState = 0x12345678
function rand() {
  // Xorshift32 — fast deterministic
  _rngState ^= _rngState << 13
  _rngState ^= _rngState >>> 17
  _rngState ^= _rngState << 5
  return ((_rngState >>> 0) / 0xffffffff)
}
function randInt(maxExclusive) { return Math.floor(rand() * maxExclusive) }

// ── Plane math ────────────────────────────────────────────────────────────────

/**
 * Compute plane from 3 points. Returns { nx, ny, nz, d } where nx*x+ny*y+nz*z+d=0
 * or null if the points are colinear.
 */
function planeFrom3(pts, i, j, k) {
  const ax = pts[i*3], ay = pts[i*3+1], az = pts[i*3+2]
  const bx = pts[j*3], by = pts[j*3+1], bz = pts[j*3+2]
  const cx = pts[k*3], cy = pts[k*3+1], cz = pts[k*3+2]

  const ux = bx - ax, uy = by - ay, uz = bz - az
  const vx = cx - ax, vy = cy - ay, vz = cz - az

  // normal = u × v
  let nx = uy * vz - uz * vy
  let ny = uz * vx - ux * vz
  let nz = ux * vy - uy * vx
  const len = Math.sqrt(nx*nx + ny*ny + nz*nz)
  if (len < 1e-8) return null
  nx /= len; ny /= len; nz /= len
  const d = -(nx * ax + ny * ay + nz * az)
  return { nx, ny, nz, d }
}

/** Count inliers within `thresh` of the plane.  Optional mask skips consumed points. */
function countInliers(pts, count, plane, thresh, mask) {
  const { nx, ny, nz, d } = plane
  let inliers = 0
  for (let i = 0; i < count; i++) {
    if (mask && mask[i]) continue
    const x = pts[i*3], y = pts[i*3+1], z = pts[i*3+2]
    const dist = nx*x + ny*y + nz*z + d
    if (dist < 0 ? -dist <= thresh : dist <= thresh) inliers++
  }
  return inliers
}

/** Refine plane via covariance eigendecomposition of inliers.  Returns refined plane. */
function refinePlane(pts, count, plane, thresh, mask) {
  const { nx, ny, nz, d } = plane
  // Pass 1: centroid of inliers
  let cx = 0, cy = 0, cz = 0, n = 0
  for (let i = 0; i < count; i++) {
    if (mask && mask[i]) continue
    const x = pts[i*3], y = pts[i*3+1], z = pts[i*3+2]
    const dist = nx*x + ny*y + nz*z + d
    if ((dist < 0 ? -dist : dist) <= thresh) {
      cx += x; cy += y; cz += z; n++
    }
  }
  if (n < 10) return plane
  cx /= n; cy /= n; cz /= n

  // Pass 2: 3×3 covariance (symmetric → 6 unique entries)
  let sxx=0, syy=0, szz=0, sxy=0, sxz=0, syz=0
  for (let i = 0; i < count; i++) {
    if (mask && mask[i]) continue
    const x = pts[i*3], y = pts[i*3+1], z = pts[i*3+2]
    const dist = nx*x + ny*y + nz*z + d
    if ((dist < 0 ? -dist : dist) <= thresh) {
      const dx = x - cx, dy = y - cy, dz = z - cz
      sxx += dx*dx; syy += dy*dy; szz += dz*dz
      sxy += dx*dy; sxz += dx*dz; syz += dy*dz
    }
  }

  // Eigenvector of smallest eigenvalue of [[sxx,sxy,sxz],[sxy,syy,syz],[sxz,syz,szz]]
  // Use 8-iter power iteration on inverse (== smallest eigenvalue of M, but we use
  // (trace*I - M) which inverts spectrum; equivalent to power iteration on largest
  // eigenvalue of that adjoint).
  const trace = sxx + syy + szz
  const a11 = trace - sxx, a22 = trace - syy, a33 = trace - szz
  const a12 = -sxy, a13 = -sxz, a23 = -syz

  let vx = nx, vy = ny, vz = nz  // seed with current normal
  for (let it = 0; it < 12; it++) {
    const wx = a11*vx + a12*vy + a13*vz
    const wy = a12*vx + a22*vy + a23*vz
    const wz = a13*vx + a23*vy + a33*vz
    const wlen = Math.sqrt(wx*wx + wy*wy + wz*wz) || 1
    vx = wx / wlen; vy = wy / wlen; vz = wz / wlen
  }
  // vx,vy,vz is largest eigenvector of (trace*I - M), == smallest eigenvector of M
  // → it's the plane normal.
  const dNew = -(vx*cx + vy*cy + vz*cz)
  return { nx: vx, ny: vy, nz: vz, d: dNew }
}

/** Mark inliers in `mask` (Uint8Array, 1=consumed). Returns new inlier count. */
function markInliers(pts, count, plane, thresh, mask) {
  const { nx, ny, nz, d } = plane
  let added = 0
  for (let i = 0; i < count; i++) {
    if (mask[i]) continue
    const x = pts[i*3], y = pts[i*3+1], z = pts[i*3+2]
    const dist = nx*x + ny*y + nz*z + d
    if ((dist < 0 ? -dist : dist) <= thresh) {
      mask[i] = 1
      added++
    }
  }
  return added
}

// ── RANSAC core ───────────────────────────────────────────────────────────────

/**
 * Run RANSAC to find the best plane satisfying `constraint(normal)`.
 *
 * @param pts        Float32Array, 3 floats/point
 * @param count      total points
 * @param trials     number of random hypotheses
 * @param thresh     inlier distance (m)
 * @param mask       Uint8Array, 1 means "skip this point"
 * @param constraint function(nx,ny,nz) → bool
 * @returns          { plane: {nx,ny,nz,d}, inliers: int } | null
 */
function ransacPlane(pts, count, trials, thresh, mask, constraint) {
  // Build a list of available indices once.
  const avail = []
  for (let i = 0; i < count; i++) if (!mask[i]) avail.push(i)
  if (avail.length < 3) return null

  let bestPlane = null
  let bestInliers = 0

  for (let t = 0; t < trials; t++) {
    const i = avail[randInt(avail.length)]
    const j = avail[randInt(avail.length)]
    const k = avail[randInt(avail.length)]
    if (i === j || i === k || j === k) continue
    const plane = planeFrom3(pts, i, j, k)
    if (!plane) continue
    if (!constraint(plane.nx, plane.ny, plane.nz)) continue
    const ins = countInliers(pts, count, plane, thresh, mask)
    if (ins > bestInliers) {
      bestInliers = ins
      bestPlane = plane
    }
  }
  if (!bestPlane) return null
  return { plane: bestPlane, inliers: bestInliers }
}

// ── 2D extent in plane-local coords ───────────────────────────────────────────

/**
 * Given a plane and its inliers, compute oriented bounding box in plane-local 2D.
 *
 * Returns: { centroid[3], uAxis[3], vAxis[3], uMin, uMax, vMin, vMax }
 *
 * uAxis is the in-plane horizontal axis: cross(worldUp, normal) for walls,
 * or worldX for floor/ceiling.
 * vAxis is then cross(normal, uAxis) — completes a right-handed orthonormal
 * basis in the plane.
 */
function planeExtent(pts, count, plane, thresh, mask, planeType) {
  const { nx, ny, nz, d } = plane

  // Pick a "horizontal in-plane" reference direction
  let ux, uy, uz
  if (planeType === 'floor' || planeType === 'ceiling') {
    // For horizontal planes: u along world X (project worldX onto plane)
    ux = 1 - nx*nx; uy = -nx*ny; uz = -nx*nz
  } else {
    // For walls: u = worldUp × normal (gives the horizontal in-plane direction)
    // worldUp = (0,1,0): cross = (1*nz - 0*ny, 0*nx - 0*nz, 0*ny - 1*nx) = (nz, 0, -nx)
    ux = nz; uy = 0; uz = -nx
  }
  const ulen = Math.sqrt(ux*ux + uy*uy + uz*uz) || 1
  ux /= ulen; uy /= ulen; uz /= ulen

  // v = normal × u  (right-handed)
  const vx = ny*uz - nz*uy
  const vy = nz*ux - nx*uz
  const vz = nx*uy - ny*ux

  // Pass 1: compute extent and centroid from this plane's inliers (mask[i] === 2)
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity
  let cx = 0, cy = 0, cz = 0, n = 0
  for (let i = 0; i < count; i++) {
    if (mask && mask[i] !== 2) continue
    const x = pts[i*3], y = pts[i*3+1], z = pts[i*3+2]
    cx += x; cy += y; cz += z; n++
    const u = x*ux + y*uy + z*uz
    const v = x*vx + y*vy + z*vz
    if (u < uMin) uMin = u
    if (u > uMax) uMax = u
    if (v < vMin) vMin = v
    if (v > vMax) vMax = v
  }
  if (n < 1) return null
  cx /= n; cy /= n; cz /= n

  // Pass 2: rasterize inliers into a small 2D coverage grid (~64 px/m, capped).
  // Used at bake time to mask out unscanned regions — critical for partial
  // scans where the floor or ceiling has a "donut" shape (scanned perimeter,
  // unscanned interior).  Without the mask the bake fills the whole bounding
  // rectangle with photo content even where nothing was scanned, producing the
  // floor-wrapping-into-walls artefact.
  const COVERAGE_PX_PER_M = 64
  const COVERAGE_MAX = 256
  const wMeters = Math.max(0.05, uMax - uMin)
  const hMeters = Math.max(0.05, vMax - vMin)
  let cW = Math.min(COVERAGE_MAX, Math.max(16, Math.round(wMeters * COVERAGE_PX_PER_M)))
  let cH = Math.min(COVERAGE_MAX, Math.max(16, Math.round(hMeters * COVERAGE_PX_PER_M)))
  const coverageRaw = new Uint8Array(cW * cH)
  const uSpan = uMax - uMin
  const vSpan = vMax - vMin
  for (let i = 0; i < count; i++) {
    if (mask && mask[i] !== 2) continue
    const x = pts[i*3], y = pts[i*3+1], z = pts[i*3+2]
    const u = x*ux + y*uy + z*uz
    const v = x*vx + y*vy + z*vz
    const cx0 = Math.min(cW - 1, Math.max(0, Math.floor((u - uMin) / uSpan * cW)))
    const cy0 = Math.min(cH - 1, Math.max(0, Math.floor((v - vMin) / vSpan * cH)))
    coverageRaw[cy0 * cW + cx0] = 255
  }
  // Dilate by 2 cells (two 3×3 max passes) so the mask doesn't have ragged
  // single-pixel holes between adjacent inliers.  Roughly 6 cm of grow at
  // 64 px/m — enough to fill scan dropouts, small enough to preserve real
  // unscanned regions.
  let coverage = coverageRaw
  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8Array(cW * cH)
    for (let y = 0; y < cH; y++) {
      for (let x = 0; x < cW; x++) {
        let any = 0
        for (let dy = -1; dy <= 1 && !any; dy++) {
          for (let dx = -1; dx <= 1 && !any; dx++) {
            const xx = x + dx, yy = y + dy
            if (xx < 0 || xx >= cW || yy < 0 || yy >= cH) continue
            if (coverage[yy * cW + xx]) any = 255
          }
        }
        next[y * cW + x] = any
      }
    }
    coverage = next
  }

  return {
    centroid: [cx, cy, cz],
    uAxis: [ux, uy, uz],
    vAxis: [vx, vy, vz],
    uMin, uMax, vMin, vMax,
    coverage, coverageW: cW, coverageH: cH,
  }
}

/** Re-mark inliers of a specific plane with value 2 (for extent calc), then back to 1. */
function tagInliersForExtent(pts, count, plane, thresh, mask) {
  const { nx, ny, nz, d } = plane
  for (let i = 0; i < count; i++) {
    if (mask[i] !== 1) continue
    const x = pts[i*3], y = pts[i*3+1], z = pts[i*3+2]
    const dist = nx*x + ny*y + nz*z + d
    if ((dist < 0 ? -dist : dist) <= thresh) {
      mask[i] = 2
    }
  }
}
function untagInliersForExtent(mask) {
  for (let i = 0; i < mask.length; i++) if (mask[i] === 2) mask[i] = 1
}

// ── Main message handler ──────────────────────────────────────────────────────

self.onmessage = function (e) {
  const msg = e.data
  if (msg?.type !== 'detect') return

  try {
    const pts = msg.pts                  // Float32Array, transferred
    const count = msg.count
    const bounds = msg.bounds
    const THRESH = msg.thresh ?? 0.05    // 5 cm default
    const MAX_WALLS = msg.maxWalls ?? 12 // up to 12 walls (alcoves, doorways, etc.)

    // Separate thresholds: floor/ceiling are often partial scans (the user
    // walks around the room and only catches the perimeter / occasional
    // ceiling glance), so a 2 % overall threshold rejects valid ceilings.
    // Walls keep the stricter threshold to suppress noise planes.
    const FLOOR_MIN   = Math.max(2000, Math.floor(count * (msg.floorMinFrac   ?? 0.005))) // 0.5 %
    const CEILING_MIN = Math.max(1500, Math.floor(count * (msg.ceilingMinFrac ?? 0.003))) // 0.3 %
    const WALL_MIN    = Math.max(2000, Math.floor(count * (msg.wallMinFrac    ?? 0.015))) // 1.5 %

    self.postMessage({ type: 'progress', pct: 5, phase: 'Plane detection starting' })

    const mask = new Uint8Array(count)   // 0 = available, 1 = consumed
    const detected = []

    // ── Floor: largest vertical-normal plane in the lower half ────────────────
    self.postMessage({ type: 'progress', pct: 10, phase: 'Detecting floor' })
    const yMid = (bounds.minY + bounds.maxY) * 0.5
    const floorConstraint = (nx, ny, nz) => Math.abs(ny) > 0.9
    let res = ransacPlane(pts, count, 1500, THRESH, mask, floorConstraint)
    if (res) {
      let refined = refinePlane(pts, count, res.plane, THRESH, mask)
      const yPlane = -refined.d / (refined.ny || 1e-6)
      if (yPlane < yMid) {
        const finalInliers = countInliers(pts, count, refined, THRESH, mask)
        if (finalInliers >= FLOOR_MIN) {
          markInliers(pts, count, refined, THRESH, mask)
          tagInliersForExtent(pts, count, refined, THRESH, mask)
          const ext = planeExtent(pts, count, refined, THRESH, mask, 'floor')
          untagInliersForExtent(mask)
          if (ext) {
            detected.push({ type: 'floor', normal: [refined.nx, refined.ny, refined.nz],
              offset: refined.d, ...ext, inlierCount: finalInliers })
          }
        }
      }
    }

    // ── Ceiling ───────────────────────────────────────────────────────────────
    self.postMessage({ type: 'progress', pct: 20, phase: 'Detecting ceiling' })
    res = ransacPlane(pts, count, 1500, THRESH, mask, floorConstraint)
    if (res) {
      let refined = refinePlane(pts, count, res.plane, THRESH, mask)
      const yPlane = -refined.d / (refined.ny || 1e-6)
      if (yPlane > yMid) {
        const finalInliers = countInliers(pts, count, refined, THRESH, mask)
        if (finalInliers >= CEILING_MIN) {
          markInliers(pts, count, refined, THRESH, mask)
          tagInliersForExtent(pts, count, refined, THRESH, mask)
          const ext = planeExtent(pts, count, refined, THRESH, mask, 'ceiling')
          untagInliersForExtent(mask)
          if (ext) {
            detected.push({ type: 'ceiling', normal: [refined.nx, refined.ny, refined.nz],
              offset: refined.d, ...ext, inlierCount: finalInliers })
          }
        }
      }
    }

    // ── Walls (iterative, up to MAX_WALLS) ────────────────────────────────────
    const wallConstraint = (nx, ny, nz) => Math.abs(ny) < 0.2
    const MIN_INLIERS = WALL_MIN
    for (let w = 0; w < MAX_WALLS; w++) {
      const pct = 25 + Math.floor(70 * w / MAX_WALLS)
      self.postMessage({ type: 'progress', pct, phase: `Detecting wall ${w+1}` })

      res = ransacPlane(pts, count, 700, THRESH, mask, wallConstraint)
      if (!res) break

      let refined = refinePlane(pts, count, res.plane, THRESH, mask)
      // Re-check constraint after refinement (could drift)
      if (Math.abs(refined.ny) >= 0.2) break

      const finalInliers = countInliers(pts, count, refined, THRESH, mask)
      if (finalInliers < MIN_INLIERS) break

      markInliers(pts, count, refined, THRESH, mask)
      tagInliersForExtent(pts, count, refined, THRESH, mask)
      const ext = planeExtent(pts, count, refined, THRESH, mask, 'wall')
      untagInliersForExtent(mask)
      if (!ext) break

      detected.push({ type: 'wall', normal: [refined.nx, refined.ny, refined.nz],
        offset: refined.d, ...ext, inlierCount: finalInliers })
    }

    self.postMessage({ type: 'progress', pct: 100, phase: 'Plane detection complete' })
    self.postMessage({ type: 'done', planes: detected })
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) })
  }
}
