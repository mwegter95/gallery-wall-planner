/**
 * Wegter Projection Algorithm v2.2 (WPA-2.2)
 *
 * Pure-JS reference implementation — mirrors the GLSL fragment shader exactly.
 * Importable for testing and for the CPU-side splat-spacing pre-pass.
 *
 * WHAT CHANGED IN v2.2 (the "spin × warp" sub-algorithm)
 * ────────────────────────────────────────────────────────
 * WPA-2.1 score = angRes × facing² × cosView⁴
 *
 * The cosView⁴ term correctly penalises cameras that see the point far from
 * their optical axis.  But a camera that is yawed 30° away from the wall
 * normal while the wall point happens to lie near its image CENTRE is barely
 * penalised — cosView ≈ 1, so only facing² = cos(30°)² = 0.75 applies.
 * 0.75 > BLEND_RATIO = 0.70, so the oblique camera is still included and
 * contributes its warped, panoramically-stretched view of the wall.
 *
 * The "spin" fix — raise the facing exponent from 2 to 4:
 *   facing  = max(0, −normCam.z)  = cos(camera-to-wall-normal angle)
 *   facing⁴: the "spin alignment" penalty.  A camera 25° yawed relative to
 *             the wall normal scores cos(25°)⁴ ≈ 0.674, which is now BELOW
 *             BLEND_RATIO (0.70) and is excluded even when the wall point
 *             is centred in the image.
 *
 * The "warp" term — cosView⁴ (unchanged from v2.1):
 *   cosView = depth / |camera_space_point|  = cos(off-axis angle)
 *   Penalises sampling from the edge of the camera's FOV where wide-angle
 *   lenses are most distorted.  Steep fall-off: 20°→0.78, 30°→0.56, 45°→0.25.
 *
 * New score = angRes × facing⁴ × cosView⁴
 *
 * Both terms now carry equal ^4 weight, creating symmetric steep penalties for:
 *   "Spin"  — how much the camera is rotated relative to the wall normal.
 *   "Warp"  — how far from the camera's optical axis the wall point appears.
 * Combined, cameras beyond ~22° from either the wall normal or the optical
 * axis are excluded, eliminating the panoramic-circle smear.
 *
 * Exclusion summary with BLEND_RATIO = 0.70 and facing⁴ × cosView⁴:
 *   Camera yaw from wall normal:  > 25° → excluded (facing⁴ < 0.674)
 *   Point off optical axis:       > 22° → excluded (cosView⁴ < 0.739)
 *   Combined 18° + 18°:           score ≈ 0.686 × 0.686 = 0.471 → excluded
 *
 * WHY WPA-2 vs the original:
 * ──────────────────────────
 * v1 bug 1 — disc sub-pixel spreading:
 *   The old shader reconstructed a different 3D world-position for each
 *   sub-pixel of the splat disc (offsetting by view-space right/up vectors).
 *   Every disc fragment then projected to a *different* UV on every camera,
 *   causing textures to smear across the disc as the camera moved.
 *   Fix: project the point CENTER only — every disc fragment gets the same
 *   projected color (the splat is just a filled circle, not a micro-surface).
 *
 * v1 bug 2 — unconstrained multi-camera blending:
 *   Every camera whose frustum covered the point contributed to the blend,
 *   including cameras on the opposite side of the room.  Two cameras with
 *   different foreground occlusions double-imaged every object.
 *   Fix: soft winner-takes-all (WTA) — only cameras within BLEND_RATIO of
 *   the best score contribute.  Score^3 weighting further sharpens selection.
 *
 * v1 bug 3 — no surface-normal facing check:
 *   A camera could project through a wall onto backfacing geometry.
 *   Fix: rotate the surface normal into camera space; cameras where the
 *   normal points away from the lens (normCam.z > 0) get zero score.
 *
 * WPA-2.2 SCORE FORMULA
 * ─────────────────────
 *   score = (fxRaw / (depth² + ε)) × max(0, −normCam.z)⁴ × cosView⁴
 *
 *   fxRaw / depth²          → angular resolution (pixels/m² at this depth).
 *                             Closer, higher-fx cameras win.
 *   max(0, −normCam.z)⁴    → spin alignment.  Camera looks in −Z; normal
 *                             must point toward camera (ncz < 0 → facing > 0).
 *                             Raised to 4th power (was 2nd): cameras > 25°
 *                             yawed from wall normal are now excluded.
 *   cosView⁴ where          → warp/on-axis quality.  Penalises sampling from
 *   cosView = depth/|cp|      the edge of the FOV.  Together with facing⁴,
 *                             both spin and warp create symmetric exclusion.
 *
 * SOFT WINNER-TAKES-ALL
 * ─────────────────────
 *   threshold = bestScore × BLEND_RATIO
 *   Only cameras with score ≥ threshold contribute.
 *   With BLEND_RATIO = 0.70 and facing⁴ × cosView⁴, cameras are excluded
 *   when yawed > 25° from wall normal OR when the point is > 22° off-axis.
 *   Blending weight = score³ for sharp but smooth seams.
 *
 * ORIENTATION CONVENTION
 * ──────────────────────
 *   ARKit intrinsics are always in the sensor's landscape frame (fw > fh).
 *   When the saved JPEG is portrait (ih > iw), the pixel data was rotated 90°
 *   CW relative to the K matrix.  ori=1 applies the inverse UV rotation so
 *   the projected UV addresses the correct pixel in the stored portrait JPEG.
 *
 *   ori = 0  landscape       (u,v) = (u0, v0)
 *   ori = 1  portrait 90°CW  (u,v) = (1−v0, u0)
 *   ori = 2  180°            (u,v) = (1−u0, 1−v0)
 *   ori = 3  portrait 270°CW (u,v) = (v0, 1−u0)
 */

// ─── Constants ────────────────────────────────────────────────────────────────

// WPA v2 legacy constants — kept for test backward-compatibility.
/** Only blend cameras whose score is within this fraction of the best (WPA-2.2). */
export const WPA2_BLEND_RATIO = 0.70

// ── WPA v4 constants (v4 improvements) ──────────────────────────────────────
/**
 * WPA-v4 tighter soft-WTA blend ratio (0.85).
 *
 * Raising from 0.70 → 0.85 narrows the window of contributing cameras,
 * reducing the weighted-average blur at seam boundaries.  Analogous to
 * tightening the bandwidth of a Nadaraya-Watson kernel smoother: fewer
 * cameras blend → sharper but still smooth transitions.
 *
 * Combined with score⁵ weighting (was score³) the effective acceptance
 * window shrinks from ~25° down to ~18° yaw from the best camera.
 */
export const WPA4_BLEND_RATIO = 0.85

/**
 * Fallback UV margin for the two-pass coverage system.
 * First pass uses WPA2_UV_MARGIN (0.08).  If no camera covers a point,
 * a second pass retries with this reduced margin — accepting slight
 * lens-edge distortion rather than leaving the vertex uncolored.
 */
export const WPA4_UV_MARGIN_FALLBACK = 0.03

/** Splat covers this many camera-pixel-widths at the point's depth.        */
export const WPA2_OVERLAP = 2.5

/** Minimum / maximum allowed splat diameter (metres).                       */
export const WPA2_SPLAT_MIN_M = 0.001
export const WPA2_SPLAT_MAX_M = 0.08

/** Reject projections closer than this many normalised UV units to the edge.
 *  0.08 (8%) avoids the most distorted periphery of wide-angle phone lenses. */
export const WPA2_UV_MARGIN = 0.08

// ─── Projection helpers ───────────────────────────────────────────────────────

/**
 * Project a world-space point into one camera.
 *
 * Coordinate conventions:
 *   • Camera space: X right, Y up, Z toward viewer (OpenGL / ARKit).
 *     Points in front of the camera have cz < 0.
 *   • Image space: X right, Y DOWN, origin top-left.
 *     v increases downward, hence the −cy term.
 *   • w2c is column-major (like THREE.Matrix4.elements / WebGL uniform).
 *
 * @param {[number,number,number]} worldPos   Point position in world space.
 * @param {number[16]}             w2c        World→camera matrix, column-major.
 * @param {[number,number,number,number]} kNorm
 *   Normalised intrinsics [fx/fw, fy/fh, cx/fw, cy/fh].
 * @param {0|1|2|3} [ori=0]  Image orientation (see module doc).
 * @param {number}  [margin]  UV reject margin (default WPA2_UV_MARGIN).
 * @returns {{ u:number, v:number, depth:number, cosView:number } | null}
 *   null when point is behind the camera or outside the image frustum.
 *   cosView = depth / |camera_space_point|, how centred the point is in the FOV.
 */
export function projectPoint(worldPos, w2c, kNorm, ori = 0, margin = WPA2_UV_MARGIN) {
  const [wx, wy, wz] = worldPos
  const e = w2c

  // World → camera-space (column-major mat4 × vec4)
  const cx = e[0]*wx + e[4]*wy + e[8]*wz  + e[12]
  const cy = e[1]*wx + e[5]*wy + e[9]*wz  + e[13]
  const cz = e[2]*wx + e[6]*wy + e[10]*wz + e[14]

  // OpenGL convention: in-front points have cz < 0.  The -0.05 guard avoids
  // division by near-zero depth and rejects coplanar-with-camera points.
  if (cz >= -0.05) return null
  const depth = -cz

  // cosView = cos(angle from optical axis) = depth / |cp|
  // 1.0 = dead ahead; falls off toward 0 at the image edges.
  const cpLen   = Math.sqrt(cx*cx + cy*cy + cz*cz)
  const cosView = cpLen > 0.001 ? depth / cpLen : 0

  // Pinhole projection → normalised image UV
  const [fxn, fyn, cxn, cyn] = kNorm
  const u0 = fxn * (cx / depth) + cxn
  const v0 = fyn * (-cy / depth) + cyn   // −cy: image Y is downward

  // Apply image orientation rotation
  let u = u0, v = v0
  if      (ori === 1) { u = 1 - v0; v = u0       }  // 90° CW
  else if (ori === 2) { u = 1 - u0; v = 1 - v0   }  // 180°
  else if (ori === 3) { u = v0;     v = 1 - u0   }  // 270° CW

  if (u < margin || u > 1 - margin || v < margin || v > 1 - margin) return null

  return { u, v, depth, cosView }
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Rotate a world-space vector into camera space using the rotation part of W2C.
 * (Equivalent to (w2c * vec4(v, 0)).xyz in GLSL — only the 3×3 rotation block,
 * translation is ignored because direction vectors don't translate.)
 *
 * @param {[number,number,number]} v  World-space direction (e.g. surface normal).
 * @param {number[16]}             w2c  Column-major world→camera matrix.
 * @returns {[number,number,number]}
 */
export function rotateToCamera(v, w2c) {
  const [vx, vy, vz] = v
  const e = w2c
  return [
    e[0]*vx + e[4]*vy + e[8]*vz,
    e[1]*vx + e[5]*vy + e[9]*vz,
    e[2]*vx + e[6]*vy + e[10]*vz,
  ]
}

/**
 * WPA-2.2 quality score for one camera–point pairing.
 *
 *   score = angRes × facing⁴ × cosView⁴
 *
 * where:
 *   angRes   = fxRaw / (depth² + ε)    [angular resolution, pixels/m²]
 *   facing   = max(0, −normCam.z)      ["spin" alignment: camera faces wall]
 *              Raised to 4th power (was 2nd in v2.1).  A camera 25° yawed
 *              from the wall normal scores facing⁴ ≈ 0.674 < BLEND_RATIO →
 *              excluded.  Tightens acceptance from ~33° to ~25°.
 *   cosView  = depth / |cp|            ["warp" quality: point near FOV centre]
 *              default 1.0 when not available (e.g., unit tests that only
 *              have depth and not the full camera-space vector)
 *
 * @param {number}              depth     Distance from camera to point (m).
 * @param {number}              fxRaw     Raw focal length in pixels.
 * @param {[number,number,number]} surfNorm  World-space surface normal (unit).
 * @param {number[16]}          w2c       Column-major world→camera matrix.
 * @param {number}              [cosView=1]  cos(off-axis angle) from projectPoint.
 * @returns {number}  Score ≥ 0; 0 means this camera must not contribute.
 */
export function computeScore(depth, fxRaw, surfNorm, w2c, cosView = 1) {
  const angRes = fxRaw / (depth * depth + 0.001)
  const [, , ncz] = rotateToCamera(surfNorm, w2c)
  // Camera looks in −Z; surface normal must point toward camera (ncz < 0).
  const facing = Math.max(0, -ncz)
  const f2  = facing * facing
  const cv2 = cosView * cosView
  // WPA-2.2: facing⁴ × cosView⁴ — symmetric "spin × warp" penalty
  return angRes * f2 * f2 * cv2 * cv2
}

// ─── Camera selection (WPA-2 soft WTA) ───────────────────────────────────────

/**
 * Select the cameras that should contribute color to a given world point.
 *
 * Implements WPA-v4 soft winner-takes-all:
 *   1. Project the point CENTER into every camera (first pass: margin=WPA2_UV_MARGIN).
 *   2. Score each in-frustum, forward-facing projection.
 *   3. Find bestScore; reject cameras below bestScore × blendRatio.
 *   4. Blend survivors weighted by score⁵ (was score³ in v2.2).
 *   Two-pass UV margin fallback: if no camera covers the point at margin=0.08,
 *   retry with margin=WPA4_UV_MARGIN_FALLBACK (0.03) before returning empty.
 *
 * WPA-v4 changes vs v2.2:
 *   • blendRatio default: 0.70 → 0.85  (tighter WTA, fewer cameras blend)
 *   • score weight:       score³ → score⁵  (sharper single-winner preference)
 *   • two-pass UV margin: 0.08 first, 0.03 fallback for uncolored edge cases
 *
 * @param {[number,number,number]} worldPos   World-space position.
 * @param {[number,number,number]} surfNorm   World-space surface normal (unit).
 * @param {Array<{
 *   w2c:    number[16],
 *   kNorm:  [number,number,number,number],
 *   fxRaw:  number,
 *   ori:    0|1|2|3,
 * }>} cameras
 * @param {number} [blendRatio]  Override WPA4_BLEND_RATIO for this call.
 * @returns {Array<{
 *   camIdx: number,
 *   u:      number,
 *   v:      number,
 *   depth:  number,
 *   score:  number,
 *   weight: number,
 * }>}
 *   Contributing cameras, sorted best-first.  Empty array = no camera covers
 *   this point.  Weights are normalised to sum to 1.
 */
export function selectCameras(worldPos, surfNorm, cameras, blendRatio = WPA4_BLEND_RATIO) {
  /**
   * One pass: project every camera at the given UV margin and collect scored candidates.
   * Returns { candidates, bestScore }.
   */
  function runPass(margin) {
    const cands = []
    let best = 0
    for (let i = 0; i < cameras.length; i++) {
      const { w2c, kNorm, fxRaw, ori } = cameras[i]
      const proj = projectPoint(worldPos, w2c, kNorm, ori, margin)
      if (!proj) continue
      const score = computeScore(proj.depth, fxRaw, surfNorm, w2c, proj.cosView)
      if (score <= 0) continue
      cands.push({ camIdx: i, ...proj, score })
      if (score > best) best = score
    }
    return { cands, best }
  }

  // First pass: strict margin (avoids most-distorted periphery)
  let { cands: candidates, best: bestScore } = runPass(WPA2_UV_MARGIN)

  // Two-pass UV margin fallback: if nothing found, retry with reduced margin.
  // Accepts slight lens-edge distortion rather than leaving the vertex uncolored.
  if (bestScore <= 0) {
    const fb = runPass(WPA4_UV_MARGIN_FALLBACK)
    candidates = fb.cands
    bestScore  = fb.best
  }

  if (bestScore <= 0) return []

  const thresh = bestScore * blendRatio
  const survivors = candidates.filter(p => p.score >= thresh)

  // WPA-v4: score⁵ weighting (was score³) — sharper single-winner preference.
  // Higher exponent = the best camera dominates more strongly, reducing
  // weighted-average blur from secondary cameras near seams.
  const rawWeights = survivors.map(p => {
    const s2 = p.score * p.score
    return s2 * s2 * p.score  // score⁵
  })
  const totalW = rawWeights.reduce((s, w) => s + w, 0)

  return survivors
    .map((p, idx) => ({ ...p, weight: rawWeights[idx] / totalW }))
    .sort((a, b) => b.score - a.score)
}

// ─── Splat sizing ─────────────────────────────────────────────────────────────

/**
 * Compute the Wegter splat diameter for a point.
 *
 * The formula ties splat size to the camera pixel footprint at the scan depth:
 *
 *   splatDiam = depth / fxRaw × WPA2_OVERLAP
 *
 * This means:
 *   • Close-up points → small splats (depth is small → fine detail preserved).
 *   • Far-away points → larger splats (depth is large → bridges wider LiDAR gaps).
 *   • At any depth the splat covers exactly WPA2_OVERLAP camera pixels, so
 *     adjacent splats always overlap slightly and leave no gaps.
 *
 * Result is clamped to [WPA2_SPLAT_MIN_M, WPA2_SPLAT_MAX_M].
 *
 * @param {number} depth    Distance from best camera to point (metres).
 * @param {number} fxRaw    Raw focal length in pixels of the best camera.
 * @param {number} [overlap]  Override WPA2_OVERLAP for this call.
 * @returns {number}  Splat diameter in metres.
 */
export function wegterSplatDiameter(depth, fxRaw, overlap = WPA2_OVERLAP, nnDist = null) {
  // WPA-v4: adaptive splat sizing via nearest-neighbor distance.
  // When nnDist is provided (from computeNeighborDistances), use the actual
  // point-cloud spacing instead of the fixed pixel-footprint formula.
  // This shrinks splats in dense regions (removes blur) and expands them in
  // sparse regions (fills gaps) — analogous to Voronoi cell sizing.
  if (nnDist != null && nnDist > 0) {
    // Diameter = 2× the nearest-neighbor distance so each splat reaches its
    // neighbor's center, ensuring gapless coverage.
    return Math.max(WPA2_SPLAT_MIN_M, Math.min(WPA2_SPLAT_MAX_M, nnDist * 2.0))
  }
  const raw = depth / (fxRaw + 1e-4) * overlap
  return Math.max(WPA2_SPLAT_MIN_M, Math.min(WPA2_SPLAT_MAX_M, raw))
}

// ─── Orientation helpers ──────────────────────────────────────────────────────

/**
 * Determine image orientation from texture/image natural dimensions.
 * ARKit intrinsics (K) are always in the landscape sensor frame.
 * When the saved JPEG is portrait (naturalHeight > naturalWidth), a 90°CW
 * UV rotation is needed to align projected UV with the K matrix.
 *
 * @param {number} imageWidth   naturalWidth (or width) of the loaded image.
 * @param {number} imageHeight  naturalHeight (or height) of the loaded image.
 * @returns {0|1}
 */
export function orientationFromDimensions(imageWidth, imageHeight) {
  return imageHeight > imageWidth ? 1 : 0
}

/**
 * Apply UV orientation rotation (matches the GLSL shader's ori branches).
 *
 * @param {number} u0   Raw projected u ∈ [0,1].
 * @param {number} v0   Raw projected v ∈ [0,1].
 * @param {0|1|2|3} ori
 * @returns {[number, number]}  [u, v] after rotation.
 */
export function applyOrientation(u0, v0, ori) {
  if (ori === 1) return [1 - v0, u0]
  if (ori === 2) return [1 - u0, 1 - v0]
  if (ori === 3) return [v0,     1 - u0]
  return [u0, v0]
}

// ─── WPA-v4 utilities ─────────────────────────────────────────────────────────

/**
 * Smooth a surface normal by weighted-averaging with neighboring normals.
 *
 * The facing⁴ term in WPA-2.2+ is highly sensitive to normal accuracy:
 * a 10° noise error changes the score by (cos10°)⁴ ≈ 0.78, potentially
 * pushing marginal cameras below the blend threshold.  LiDAR normals
 * typically have 5-10° of inherent noise (the normal is the eigenvector
 * for the smallest eigenvalue of the local covariance — the least stable).
 *
 * This function averages nearby normals that are within `angularThresholdDeg`
 * of the input normal, discarding inconsistent neighbors (surface boundaries,
 * noise spikes).  The result is a more stable normal for WPA scoring.
 *
 * Analogy: this is a Laplacian bilateral filter on the normal field — the
 * bilateral weight prevents smoothing across surface discontinuities.
 *
 * @param {[number,number,number]}    normal             Input surface normal (unit vector).
 * @param {[number,number,number][]}  neighborNormals    Normals of nearby points.
 * @param {number} [angularThresholdDeg=30]  Max angle (°) for a neighbor to contribute.
 * @returns {[number,number,number]}  Smoothed, normalized surface normal.
 */
export function smoothSurfaceNormal(normal, neighborNormals, angularThresholdDeg = 30) {
  const cosThresh = Math.cos(angularThresholdDeg * Math.PI / 180)
  let sx = normal[0], sy = normal[1], sz = normal[2]
  for (const nn of neighborNormals) {
    // Only include neighbors pointing in roughly the same direction (same surface).
    const dot = normal[0]*nn[0] + normal[1]*nn[1] + normal[2]*nn[2]
    if (dot >= cosThresh) {
      sx += nn[0]; sy += nn[1]; sz += nn[2]
    }
  }
  const len = Math.sqrt(sx*sx + sy*sy + sz*sz)
  return len > 1e-6 ? [sx/len, sy/len, sz/len] : [normal[0], normal[1], normal[2]]
}

/**
 * Compute approximate per-point nearest-neighbor distances using a voxel hash grid.
 *
 * This enables adaptive splat sizing in wegterSplatDiameter: instead of the
 * fixed depth/fxRaw formula, each splat is sized to reach its closest
 * neighbor — like Voronoi cell sizing.  Dense regions get smaller splats
 * (less blur) and sparse regions get larger splats (no gaps).
 *
 * Complexity: O(n) average using a spatial hash with expected ~8 points/cell.
 *
 * @param {Float32Array | number[]} positions  [x,y,z, x,y,z, …] in world space.
 * @param {number}                  n          Number of points.
 * @returns {Float32Array}  Per-point nearest-neighbor distance, length = n.
 */
export function computeNeighborDistances(positions, n) {
  if (n === 0) return new Float32Array(0)

  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < n; i++) {
    const b = i * 3
    const x = positions[b], y = positions[b+1], z = positions[b+2]
    if (x < minX) minX = x;  if (x > maxX) maxX = x
    if (y < minY) minY = y;  if (y > maxY) maxY = y
    if (z < minZ) minZ = z;  if (z > maxZ) maxZ = z
  }

  // Choose cell size so each cell contains ~8 points on average.
  const vol = Math.max(1e-9, (maxX-minX) * (maxY-minY+1e-9) * (maxZ-minZ+1e-9))
  const cellSize = Math.max(1e-5, Math.cbrt(vol / n) * 2.0)
  const invCell = 1 / cellSize

  // Spatial hash: integer voxel key → list of point indices
  const grid = new Map()
  for (let i = 0; i < n; i++) {
    const b = i * 3
    const ix = (positions[b]   - minX) * invCell | 0
    const iy = (positions[b+1] - minY) * invCell | 0
    const iz = (positions[b+2] - minZ) * invCell | 0
    // Pack three 20-bit integers into a BigInt key for a collision-free hash.
    const key = (BigInt(ix) << 42n) | (BigInt(iy) << 21n) | BigInt(iz)
    const cell = grid.get(key)
    if (cell) cell.push(i)
    else grid.set(key, [i])
  }

  const nnDists = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const b = i * 3
    const px = positions[b], py = positions[b+1], pz = positions[b+2]
    const ix = (px - minX) * invCell | 0
    const iy = (py - minY) * invCell | 0
    const iz = (pz - minZ) * invCell | 0
    let minD2 = Infinity
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const key = (BigInt(ix+dx) << 42n) | (BigInt(iy+dy) << 21n) | BigInt(iz+dz)
          const cell = grid.get(key)
          if (!cell) continue
          for (const j of cell) {
            if (j === i) continue
            const bj = j * 3
            const ex = positions[bj]   - px
            const ey = positions[bj+1] - py
            const ez = positions[bj+2] - pz
            const d2 = ex*ex + ey*ey + ez*ez
            if (d2 < minD2) minD2 = d2
          }
        }
      }
    }
    nnDists[i] = minD2 === Infinity ? cellSize : Math.sqrt(minD2)
  }
  return nnDists
}
