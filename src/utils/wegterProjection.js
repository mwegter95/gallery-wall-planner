/**
 * Wegter Projection Algorithm v2.1 (WPA-2.1)
 *
 * Pure-JS reference implementation — mirrors the GLSL fragment shader exactly.
 * Importable for testing and for the CPU-side splat-spacing pre-pass.
 *
 * WHAT CHANGED IN v2.1 (the "panoramic wrapping" fix)
 * ────────────────────────────────────────────────────
 * WPA-2 used score = angRes × facing².  This correctly rejects cameras that
 * see a surface from the back, but does not penalise cameras that have the
 * point far off their own optical axis.  A wide-angle phone camera in the
 * south corner of a bedroom can "see" the north wall, but the north wall
 * occupies the extreme top-left of that image — heavily distorted, wrong
 * perspective.  WPA-2 gave it a high facing score (it IS facing the wall)
 * and let it blend, creating the "panoramic circle" smear.
 *
 * Fix — add a cosView⁴ term:
 *   cosView = depth / |camera_space_point| = cos(off-axis angle)
 *   1.0 when the point is dead-centre in the camera FOV;
 *   cos(θ) at angle θ off the optical axis.
 *   Raised to the 4th power → steep fall-off:  20°→0.78  30°→0.56  45°→0.25
 *
 * New score = angRes × facing² × cosView⁴
 *
 * With BLEND_RATIO = 0.70, cameras more than ~22° off-axis are excluded even
 * before the facing term matters.  Combined, a camera 25° off either axis
 * scores < 0.55 of the best → excluded.  This restricts each camera to the
 * central, undistorted region of its FOV, eliminating the panoramic sweep.
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
 * WPA-2.1 SCORE FORMULA
 * ─────────────────────
 *   score = (fxRaw / (depth² + ε)) × max(0, −normCam.z)² × cosView⁴
 *
 *   fxRaw / depth²          → angular resolution (pixels/m² at this depth).
 *                             Closer, higher-fx cameras win.
 *   max(0, −normCam.z)²     → surface facing.  Camera looks in −Z; normal
 *                             must point toward camera (ncz < 0 → facing > 0).
 *                             Squared to penalise grazing angles.
 *   cosView⁴ where          → on-axis quality.  Penalises sampling from the
 *   cosView = depth/|cp|      edge of the camera's FOV where wide-angle lenses
 *                             are most distorted.  4th power → aggressive:
 *                             20°off-axis → 0.78,  30° → 0.56,  45° → 0.25.
 *
 * SOFT WINNER-TAKES-ALL
 * ─────────────────────
 *   threshold = bestScore × BLEND_RATIO
 *   Only cameras with score ≥ threshold contribute.
 *   With BLEND_RATIO = 0.70 and the combined facing²×cosView⁴ penalty,
 *   cameras more than ~22° off the combined surface-normal / optical axis
 *   are excluded.  Blending weight = score³ for sharp but smooth seams.
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

/** Only blend cameras whose score is within this fraction of the best. */
export const WPA2_BLEND_RATIO = 0.70

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
 * WPA-2.1 quality score for one camera–point pairing.
 *
 *   score = angRes × facing² × cosView⁴
 *
 * where:
 *   angRes   = fxRaw / (depth² + ε)    [angular resolution, pixels/m²]
 *   facing   = max(0, −normCam.z)      [surface faces the camera's −Z axis]
 *   cosView  = depth / |cp|            [point is centred in the camera FOV]
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
  const cv2 = cosView * cosView
  return angRes * facing * facing * cv2 * cv2
}

// ─── Camera selection (WPA-2 soft WTA) ───────────────────────────────────────

/**
 * Select the cameras that should contribute color to a given world point.
 *
 * Implements WPA-2 soft winner-takes-all:
 *   1. Project the point CENTER into every camera.
 *   2. Score each in-frustum, forward-facing projection.
 *   3. Find bestScore; reject cameras below bestScore × BLEND_RATIO.
 *   4. Blend survivors weighted by score³.
 *
 * @param {[number,number,number]} worldPos   World-space position.
 * @param {[number,number,number]} surfNorm   World-space surface normal (unit).
 * @param {Array<{
 *   w2c:    number[16],
 *   kNorm:  [number,number,number,number],
 *   fxRaw:  number,
 *   ori:    0|1|2|3,
 * }>} cameras
 * @param {number} [blendRatio]  Override WPA2_BLEND_RATIO for this call.
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
export function selectCameras(worldPos, surfNorm, cameras, blendRatio = WPA2_BLEND_RATIO) {
  const candidates = []
  let bestScore = 0

  for (let i = 0; i < cameras.length; i++) {
    const { w2c, kNorm, fxRaw, ori } = cameras[i]
    const proj = projectPoint(worldPos, w2c, kNorm, ori)
    if (!proj) continue
    const score = computeScore(proj.depth, fxRaw, surfNorm, w2c, proj.cosView)
    if (score <= 0) continue
    candidates.push({ camIdx: i, ...proj, score })
    if (score > bestScore) bestScore = score
  }

  if (bestScore <= 0) return []

  const thresh = bestScore * blendRatio
  const survivors = candidates.filter(p => p.score >= thresh)

  // Compute score³ weights and normalise
  const rawWeights = survivors.map(p => p.score * p.score * p.score)
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
export function wegterSplatDiameter(depth, fxRaw, overlap = WPA2_OVERLAP) {
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
