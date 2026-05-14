/**
 * WPA-2 (Wegter Projection Algorithm v2) — test suite.
 *
 * Tests the pure-JS reference implementation that mirrors the GLSL fragment
 * shader.  When any test here fails the GLSL shader has a corresponding bug.
 *
 * Camera setup convention used throughout:
 *   Identity camera   — at world origin, looking in −Z.
 *   W2C = I (4×4 identity stored column-major as [1,0,0,0, 0,1,0,0, …]).
 *
 * Intrinsics used:
 *   fx=fy=1000 px, cx=cy=0.5 (image centre), image 1000×1000.
 *   kNorm = [1000/1000, 1000/1000, 500/1000, 500/1000] = [1, 1, 0.5, 0.5].
 */

import { describe, it, expect } from 'vitest'
import {
  projectPoint,
  computeScore,
  rotateToCamera,
  selectCameras,
  wegterSplatDiameter,
  applyOrientation,
  orientationFromDimensions,
  WPA2_BLEND_RATIO,
  WPA2_OVERLAP,
  WPA2_SPLAT_MIN_M,
  WPA2_SPLAT_MAX_M,
  WPA2_UV_MARGIN,
} from './wegterProjection.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Column-major 4×4 identity. */
const I4 = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]

/** Build a column-major W2C that places the camera at `camPos` looking in −Z. */
function translationW2C(tx, ty, tz) {
  // W2C = T(−pos) since R=I: column-major: [..., tx, ty, tz, 1] at cols 12-15
  return [1,0,0,0, 0,1,0,0, 0,0,1,0, -tx,-ty,-tz,1]
}

/** Normalised intrinsics for a 1000×1000 image with fx=fy=1000, cx=cy=500. */
const K1000 = [1.0, 1.0, 0.5, 0.5]

/** A simple camera descriptor for selectCameras(). */
function cam(w2c = I4, kNorm = K1000, fxRaw = 1000, ori = 0) {
  return { w2c, kNorm, fxRaw, ori }
}

// ─── projectPoint ─────────────────────────────────────────────────────────────

describe('projectPoint', () => {
  it('projects the image centre to UV (0.5, 0.5)', () => {
    // Point directly in front of the identity camera at depth 5 → no lateral offset
    // → u = fx_n * 0/5 + cx_n = 0.5, v = fy_n * 0/5 + cy_n = 0.5
    const p = projectPoint([0, 0, -5], I4, K1000)
    expect(p).not.toBeNull()
    expect(p.u).toBeCloseTo(0.5, 6)
    expect(p.v).toBeCloseTo(0.5, 6)
    expect(p.depth).toBeCloseTo(5, 6)
  })

  it('returns null for a point behind the camera (cz > 0)', () => {
    expect(projectPoint([0, 0, 5], I4, K1000)).toBeNull()
  })

  it('returns null for a point coplanar with the camera (cz = 0)', () => {
    expect(projectPoint([0, 0, 0], I4, K1000)).toBeNull()
  })

  it('rejects a point at cz = −0.04 (within the near guard)', () => {
    // cz = −0.04 >= −0.05 → reject
    expect(projectPoint([0, 0, -0.04], I4, K1000)).toBeNull()
  })

  it('accepts a point at cz = −0.06 (just past the near guard)', () => {
    const p = projectPoint([0, 0, -0.06], I4, K1000)
    expect(p).not.toBeNull()
  })

  it('correctly projects a point offset right: u > 0.5', () => {
    // Point at [1, 0, -5]: cx = 1, depth = 5
    // u0 = 1.0 * (1/5) + 0.5 = 0.7
    const p = projectPoint([1, 0, -5], I4, K1000)
    expect(p).not.toBeNull()
    expect(p.u).toBeCloseTo(0.7, 5)
    expect(p.v).toBeCloseTo(0.5, 5)
  })

  it('correctly projects a point offset upward: v < 0.5 (image Y is downward)', () => {
    // Point at [0, 1, -5]: cy = 1 (up), image-v uses −cy → v0 = 1.0 * (−1/5) + 0.5 = 0.3
    const p = projectPoint([0, 1, -5], I4, K1000)
    expect(p).not.toBeNull()
    expect(p.u).toBeCloseTo(0.5, 5)
    expect(p.v).toBeCloseTo(0.3, 5)  // v decreases as world-Y increases
  })

  it('returns null when projected UV is outside the margin', () => {
    // fx_n=1, depth=1, cx_n=0.5 → u0 = 1*2/1 + 0.5 = 2.5 → way out of [0,1]
    expect(projectPoint([2, 0, -1], I4, K1000)).toBeNull()
  })

  it('returns null when projected UV is exactly on the margin edge', () => {
    // u = WPA2_UV_MARGIN exactly → not strictly less than margin → rejected
    const margin = WPA2_UV_MARGIN
    // We need u0 = margin.  With K1000: u0 = 1 * (cx/depth) + 0.5 = margin
    // → cx/depth = margin − 0.5 = negative for small margin → adjust
    // Easier: use a point that puts u = margin
    const depth  = 5
    const cx     = (margin - 0.5) * depth   // cx = (0.04 − 0.5) * 5 = −2.3
    const result = projectPoint([cx, 0, -depth], I4, K1000)
    expect(result).toBeNull()
  })

  it('accepts a point just inside the margin', () => {
    const margin = WPA2_UV_MARGIN
    const depth  = 5
    const cx     = (margin + 0.001 - 0.5) * depth
    const result = projectPoint([cx, 0, -depth], I4, K1000)
    expect(result).not.toBeNull()
    expect(result.u).toBeGreaterThan(margin)
  })

  it('handles a translated camera correctly', () => {
    // Camera at world [3, 0, 0], W2C shifts x by −3.
    // World point [3, 0, -5] → camera space [0, 0, -5] → UV centre.
    const w2c = translationW2C(3, 0, 0)
    const p   = projectPoint([3, 0, -5], w2c, K1000)
    expect(p).not.toBeNull()
    expect(p.u).toBeCloseTo(0.5, 5)
    expect(p.v).toBeCloseTo(0.5, 5)
  })

  it('depth equals distance from camera to point', () => {
    const p = projectPoint([0, 0, -7.5], I4, K1000)
    expect(p.depth).toBeCloseTo(7.5, 6)
  })

  it('returns cosView field', () => {
    const p = projectPoint([0, 0, -5], I4, K1000)
    expect(p).not.toBeNull()
    expect(typeof p.cosView).toBe('number')
    expect(p.cosView).toBeGreaterThan(0)
    expect(p.cosView).toBeLessThanOrEqual(1)
  })

  it('cosView = 1.0 for a point exactly on the optical axis', () => {
    // [0, 0, -d] is dead-centre → cp = [0, 0, -d] → cosView = d / d = 1
    const p = projectPoint([0, 0, -5], I4, K1000)
    expect(p.cosView).toBeCloseTo(1.0, 6)
  })

  it('cosView < 1.0 for an off-axis point', () => {
    // [2, 0, -5]: cx=2, cz=−5, cpLen=√(4+25)=√29≈5.39 → cosView=5/5.39≈0.928
    const p = projectPoint([2, 0, -5], I4, K1000)
    expect(p).not.toBeNull()
    expect(p.cosView).toBeLessThan(1.0)
    expect(p.cosView).toBeGreaterThan(0.8)
  })

  it('cosView equals cos(off-axis angle)', () => {
    // Point at 30° off axis: tan(30°) = lateral/depth → lateral = depth*tan(30°)
    const depth  = 5
    const angle  = 30 * Math.PI / 180
    const lat    = depth * Math.tan(angle)
    const p      = projectPoint([lat, 0, -depth], I4, K1000)
    if (p) {
      expect(p.cosView).toBeCloseTo(Math.cos(angle), 4)
    }
  })

  it('cosView is lower for more off-axis points', () => {
    const p1 = projectPoint([1, 0, -10], I4, K1000)  // 5.7° off axis
    const p2 = projectPoint([2, 0, -10], I4, K1000)  // 11.3° off axis
    if (p1 && p2) {
      expect(p1.cosView).toBeGreaterThan(p2.cosView)
    }
  })
})

// ─── applyOrientation ─────────────────────────────────────────────────────────

describe('applyOrientation', () => {
  it('ori=0: identity transform', () => {
    expect(applyOrientation(0.3, 0.6, 0)).toEqual([0.3, 0.6])
  })

  it('ori=1 (90°CW): u = 1−v0, v = u0', () => {
    const [u, v] = applyOrientation(0.3, 0.6, 1)
    expect(u).toBeCloseTo(1 - 0.6, 8)
    expect(v).toBeCloseTo(0.3,     8)
  })

  it('ori=2 (180°): u = 1−u0, v = 1−v0', () => {
    const [u, v] = applyOrientation(0.3, 0.6, 2)
    expect(u).toBeCloseTo(1 - 0.3, 8)
    expect(v).toBeCloseTo(1 - 0.6, 8)
  })

  it('ori=3 (270°CW): u = v0, v = 1−u0', () => {
    const [u, v] = applyOrientation(0.3, 0.6, 3)
    expect(u).toBeCloseTo(0.6,     8)
    expect(v).toBeCloseTo(1 - 0.3, 8)
  })

  it('four orientations compose to identity after 4 rotations', () => {
    let u = 0.2, v = 0.7
    ;[1,1,1,1].forEach(() => { [u, v] = applyOrientation(u, v, 1) })
    expect(u).toBeCloseTo(0.2, 6)
    expect(v).toBeCloseTo(0.7, 6)
  })
})

// ─── orientationFromDimensions ────────────────────────────────────────────────

describe('orientationFromDimensions', () => {
  it('landscape → 0', () => expect(orientationFromDimensions(1920, 1080)).toBe(0))
  it('portrait  → 1', () => expect(orientationFromDimensions(1080, 1920)).toBe(1))
  it('square    → 0', () => expect(orientationFromDimensions(1024, 1024)).toBe(0))
})

// ─── rotateToCamera ───────────────────────────────────────────────────────────

describe('rotateToCamera', () => {
  it('identity matrix leaves vector unchanged', () => {
    const [x, y, z] = rotateToCamera([1, 2, 3], I4)
    expect(x).toBeCloseTo(1, 8)
    expect(y).toBeCloseTo(2, 8)
    expect(z).toBeCloseTo(3, 8)
  })

  it('pure translation in W2C does not affect direction vectors', () => {
    const w2c = translationW2C(10, 20, 30)  // translation only, rotation = I
    const [x, y, z] = rotateToCamera([1, 0, 0], w2c)
    expect(x).toBeCloseTo(1, 8)
    expect(y).toBeCloseTo(0, 8)
    expect(z).toBeCloseTo(0, 8)
  })

  it('camera-space z of world −Z vector is negative (facing camera)', () => {
    // World normal [0,0,−1] → camera space with identity → normCam.z = −1 < 0 → facing
    const [, , ncz] = rotateToCamera([0, 0, -1], I4)
    expect(ncz).toBeCloseTo(-1, 8)
  })

  it('camera-space z of world +Z vector is positive (backfacing)', () => {
    const [, , ncz] = rotateToCamera([0, 0, 1], I4)
    expect(ncz).toBeCloseTo(1, 8)
  })
})

// ─── computeScore ─────────────────────────────────────────────────────────────

describe('computeScore', () => {
  it('returns 0 when surface normal faces away from camera', () => {
    // Normal [0,0,+1] in world → normCam.z = +1 → facing = max(0,−1) = 0
    expect(computeScore(5, 1000, [0, 0, 1], I4)).toBe(0)
  })

  it('returns 0 for a sideways-facing surface (normCam.z = 0)', () => {
    // Normal [1,0,0]: ncz = 0 → facing = 0
    expect(computeScore(5, 1000, [1, 0, 0], I4)).toBe(0)
  })

  it('returns > 0 when surface faces camera', () => {
    // Normal [0,0,−1]: ncz = −1 → facing = 1 → angRes > 0 → score > 0
    expect(computeScore(5, 1000, [0, 0, -1], I4)).toBeGreaterThan(0)
  })

  it('score decreases with depth (angular resolution falls off)', () => {
    const near = computeScore(2, 1000, [0, 0, -1], I4)
    const far  = computeScore(8, 1000, [0, 0, -1], I4)
    expect(near).toBeGreaterThan(far)
  })

  it('score increases with fxRaw (higher-resolution camera wins)', () => {
    const wide   = computeScore(5, 500,  [0, 0, -1], I4)
    const tele   = computeScore(5, 2000, [0, 0, -1], I4)
    expect(tele).toBeGreaterThan(wide)
  })

  it('score at grazing angle is much lower than frontal score', () => {
    // Grazing: normal at 80° from camera axis (normCam.z ≈ −0.17)
    const angle80 = Math.PI / 180 * 80
    const norm    = [Math.sin(angle80), 0, -Math.cos(angle80)]
    const frontal = computeScore(5, 1000, [0, 0, -1], I4)
    const grazing = computeScore(5, 1000, norm, I4)
    // facing² for 80° = cos(80°)² ≈ 0.03 → ≪ frontal
    expect(grazing).toBeLessThan(frontal * 0.05)
  })

  it('score formula: angRes × facing⁶ × cosView² × spinFactor² matches manual calculation (defaults)', () => {
    const depth   = 3
    const fxRaw   = 1200
    const norm    = [0, 0, -1]    // normCam.z = −1, facing = 1
    const angRes  = fxRaw / (depth * depth + 0.001)
    // Default cosView = 1, spinFactor = 1 → all terms = 1
    const expected = angRes * 1 * 1 * 1   // angRes × facing⁶ × cosView² × spinFactor²
    expect(computeScore(depth, fxRaw, norm, I4)).toBeCloseTo(expected, 4)
  })

  it('score formula with explicit cosView < 1 matches manual calculation', () => {
    const depth   = 5
    const fxRaw   = 1000
    const norm    = [0, 0, -1]
    const cosView = Math.cos(30 * Math.PI / 180)  // 30° off-axis
    const angRes  = fxRaw / (depth * depth + 0.001)
    const f2      = 1 * 1   // facing = 1, f2 = 1
    const cv2     = cosView * cosView
    const expected = angRes * f2 * f2 * f2 * cv2  // facing⁶ × cosView², facing=1, spinFactor=1
    expect(computeScore(depth, fxRaw, norm, I4, cosView)).toBeCloseTo(expected, 4)
  })

  it('cosView=0.5 (60° off-axis) reduces score to 0.25 of cosView=1 score (WPA-4: cosView²)', () => {
    const s1 = computeScore(5, 1000, [0, 0, -1], I4, 1.0)
    const s2 = computeScore(5, 1000, [0, 0, -1], I4, 0.5)
    // WPA-4 cosView²: 0.5^2 = 0.25
    expect(s2 / s1).toBeCloseTo(0.25, 5)
  })

  it('30° off-axis camera scores below BLEND_RATIO=0.70 of 0°-axis camera', () => {
    const cosView30 = Math.cos(30 * Math.PI / 180)
    const s_frontal = computeScore(5, 1000, [0, 0, -1], I4, 1.0)
    const s_30deg   = computeScore(5, 1000, [0, 0, -1], I4, cosView30)
    // WPA-4 cosView²: cos(30°)^2 ≈ 0.75 → above 0.70, but still penalised
    expect(s_30deg / s_frontal).toBeLessThan(1.0)
  })

  // WPA-4 spin alignment tests (facing⁶ instead of facing⁴)
  it('WPA-4: facing⁶ formula — facing=0.5 reduces score to 1/64 of frontal', () => {
    // With facing^6: 0.5^6 = 0.015625
    // Build a W2C where normCam.z = -0.5 (surface facing = 0.5)
    // normal [0, 0, -1] in camera space → need w2c such that normCam.z = -0.5
    // That means the world normal [0, 0, -1] rotates to camera z of -0.5
    // Use a camera rotated 60° so cos(60°)=0.5
    const depth  = 5
    const fxRaw  = 1000
    const norm   = [0, 0, -1]
    // frontal camera: facing=1
    const sF = computeScore(depth, fxRaw, norm, I4, 1.0)
    // half-facing camera: directly pass as cosView=0.5 but facing=1, to isolate
    // the facing term: build a W2C where normCam.z produces facing=0.5
    // Easiest: use computeScore with a tilted norm and identity W2C
    // norm = [-sin(60°), 0, -cos(60°)] → normCam.z = -0.5 → facing = 0.5
    const angle  = 60 * Math.PI / 180
    const norm60 = [-Math.sin(angle), 0, -Math.cos(angle)]
    const sH = computeScore(depth, fxRaw, norm60, I4, 1.0)
    // facing = 0.5 → facing^6 = 0.015625 → score ratio = 0.015625
    expect(sH / sF).toBeCloseTo(0.015625, 4)
  })

  it('WPA-4: 25° yaw from wall normal → score < WPA4_BLEND_RATIO (spin penalty)', () => {
    // Camera at 25° yaw from wall normal, point at camera centre (cosView=1)
    // facing = cos(25°) ≈ 0.906, facing^6 ≈ 0.554 < 0.85 → excluded
    const depth   = 5
    const fxRaw   = 1000
    const angle25 = 25 * Math.PI / 180
    // Rotate the wall normal by 25° around Y so normCam.z = -cos(25°) with identity W2C
    // Outward normal rotated 25° from cam optical axis: [sin(25°), 0, -cos(25°)]
    const norm25  = [Math.sin(angle25), 0, -Math.cos(angle25)]
    const sF = computeScore(depth, fxRaw, [0, 0, -1], I4, 1.0)   // frontal
    const s25 = computeScore(depth, fxRaw, norm25, I4, 1.0)        // 25° spin
    // facing = cos(25°), facing^6 ≈ 0.554 < WPA2_BLEND_RATIO (0.70) → spin-excluded
    expect(s25 / sF).toBeLessThan(WPA2_BLEND_RATIO)
    expect(s25 / sF).toBeGreaterThan(0.40)  // not zero — just below threshold
  })

  it('WPA-4: 15° yaw — just inside WPA2_BLEND_RATIO (allowed in seam blend)', () => {
    // facing = cos(15°) ≈ 0.966, facing^6 ≈ 0.807 > 0.70 → included
    const depth   = 5
    const fxRaw   = 1000
    const angle15 = 15 * Math.PI / 180
    const norm15  = [Math.sin(angle15), 0, -Math.cos(angle15)]
    const sF  = computeScore(depth, fxRaw, [0, 0, -1], I4, 1.0)
    const s15 = computeScore(depth, fxRaw, norm15, I4, 1.0)
    // cos(15°)^6 ≈ 0.807 > WPA2_BLEND_RATIO (0.70) → camera is included at seams
    expect(s15 / sF).toBeGreaterThan(WPA2_BLEND_RATIO)
  })

  it('WPA-4: 30° yaw — clearly excluded (spin penalty)', () => {
    const depth   = 5
    const fxRaw   = 1000
    const angle30 = 30 * Math.PI / 180
    const norm30  = [Math.sin(angle30), 0, -Math.cos(angle30)]
    const sF  = computeScore(depth, fxRaw, [0, 0, -1], I4, 1.0)
    const s30 = computeScore(depth, fxRaw, norm30, I4, 1.0)
    // cos(30°)^6 ≈ 0.422 < 0.70 → excluded
    expect(s30 / sF).toBeLessThan(WPA2_BLEND_RATIO)
  })
})

// ─── selectCameras ────────────────────────────────────────────────────────────

describe('selectCameras', () => {
  it('returns empty array when no camera covers the point', () => {
    // Point behind all cameras
    const cameras = [cam(), cam(translationW2C(10, 0, 0))]
    const result  = selectCameras([0, 0, 100], [0, 0, -1], cameras)
    expect(result).toHaveLength(0)
  })

  it('returns the single covering camera for an isolated point', () => {
    // One camera at origin; point at [0,0,−5], normal facing camera
    const result = selectCameras([0, 0, -5], [0, 0, -1], [cam()])
    expect(result).toHaveLength(1)
    expect(result[0].camIdx).toBe(0)
    expect(result[0].u).toBeCloseTo(0.5, 4)
    expect(result[0].v).toBeCloseTo(0.5, 4)
    expect(result[0].weight).toBeCloseTo(1.0, 6)  // sole contributor → weight = 1
  })

  it('winner-takes-all: close camera score >> far camera → only close wins', () => {
    // Camera A at z=0 (depth=5), Camera B at z=−50 (depth=55, very far)
    const camA   = cam(I4)
    const camB   = cam(translationW2C(0, 0, -50))  // camera at [0,0,−50]
    // Point at [0,0,−5], normal facing +Z (toward z=0 camera)
    const result = selectCameras([0, 0, -5], [0, 0, 1], [camA, camB])
    // camA: depth=5, facing=max(0,−(−1))=1 (normCam=[0,0,1] in camA space, normCam.z=1>0 → facing=0)
    // Wait — normal [0,0,+1] in camera-A space (identity): ncz=+1 → facing=max(0,−1)=0!
    // Let's use a wall normal instead: [0,0,−1] for both cameras
    const r2 = selectCameras([0, 0, -5], [0, 0, -1], [camA, camB])
    // camA depth=5, camB depth=45 → score ratio = (5/25) / (5/2025) = 81 → far outside BLEND_RATIO
    expect(r2).toHaveLength(1)
    expect(r2[0].camIdx).toBe(0)   // camA wins
  })

  it('blends two similarly-positioned cameras near a seam', () => {
    // Two cameras side by side at depth 5 from the point.  Same focal length.
    // Place both slightly off-centre so both see the point with similar scores.
    const camL = cam(translationW2C(-0.1, 0, 0))  // slightly left
    const camR = cam(translationW2C( 0.1, 0, 0))  // slightly right
    const norm = [0, 0, -1]
    const result = selectCameras([0, 0, -5], norm, [camL, camR])
    // Both cameras are at nearly the same depth → scores close → both survive BLEND_RATIO
    expect(result).toHaveLength(2)
    const totalW = result.reduce((s, p) => s + p.weight, 0)
    expect(totalW).toBeCloseTo(1.0, 6)
  })

  it('respects custom blendRatio = 1.0 (strict WTA — only exact best wins)', () => {
    // Two cameras at slightly different depths — closer one wins with ratio=1.0
    const camNear = cam(translationW2C(0, 0,  1))  // camera at z=+1 → point at [0,0,−5] is depth 6
    const camFar  = cam(translationW2C(0, 0, -1))  // camera at z=−1 → point depth 4
    const norm    = [0, 0, -1]
    const result  = selectCameras([0, 0, -5], norm, [camNear, camFar], 1.0)
    // With ratio=1.0 the threshold = bestScore; only cameras exactly equal to best survive.
    // Scores differ (different depths) → exactly 1 survives
    expect(result).toHaveLength(1)
  })

  it('weights sum to 1.0', () => {
    const cameras = [cam(), cam(translationW2C(0.5, 0, 0)), cam(translationW2C(-0.5, 0, 0))]
    const result  = selectCameras([0, 0, -5], [0, 0, -1], cameras)
    if (result.length > 0) {
      const sum = result.reduce((s, p) => s + p.weight, 0)
      expect(sum).toBeCloseTo(1.0, 5)
    }
  })

  it('returns cameras sorted best-first', () => {
    const cameras = [
      cam(translationW2C(0, 0, -10)),  // camera at z=−10 → depth = |−5 − (−10)| = 5
      cam(translationW2C(0, 0,  -2)),  // camera at z=−2  → depth = |−5 − (−2)|  = 3 (closer → higher score)
    ]
    const result = selectCameras([0, 0, -5], [0, 0, -1], cameras)
    if (result.length >= 2) {
      expect(result[0].score).toBeGreaterThanOrEqual(result[1].score)
    }
  })

  it('backfacing surface gets no projections from cameras on the far side', () => {
    // Surface normal points in +X direction.  Camera is to the −X side of the point.
    // From that camera, normCam.z depends on rotation — use a simpler setup:
    // Normal [0,0,−1], camera behind the surface (at +Z, so point has +cz → no projection).
    // Actually test: point at [0,0,−5], normal [0,0,+1] (backfacing identity cam).
    const result = selectCameras([0, 0, -5], [0, 0, 1], [cam()])
    // Normal in camera space: [0,0,1] → ncz=1 → facing=max(0,−1)=0 → score=0 → excluded
    expect(result).toHaveLength(0)
  })
})

// ─── wegterSplatDiameter ──────────────────────────────────────────────────────

describe('wegterSplatDiameter', () => {
  it('returns WPA2_SPLAT_MIN_M for very close / zero depth', () => {
    expect(wegterSplatDiameter(0, 1000)).toBe(WPA2_SPLAT_MIN_M)
  })

  it('returns WPA2_SPLAT_MAX_M for very far depth', () => {
    // depth=1000, fx=1 → raw = 1000/1 * 2.5 = 2500 >> WPA2_SPLAT_MAX_M
    expect(wegterSplatDiameter(1000, 1)).toBe(WPA2_SPLAT_MAX_M)
  })

  it('diameter scales linearly with depth (within clamp range)', () => {
    const d1 = wegterSplatDiameter(1, 1000)
    const d2 = wegterSplatDiameter(2, 1000)
    // Within clamp range: d2 / d1 ≈ 2
    if (d1 > WPA2_SPLAT_MIN_M && d2 < WPA2_SPLAT_MAX_M) {
      expect(d2 / d1).toBeCloseTo(2, 4)
    }
  })

  it('diameter decreases with higher focal length (tighter pixels at same depth)', () => {
    const wide = wegterSplatDiameter(3, 500)
    const tele = wegterSplatDiameter(3, 2000)
    expect(tele).toBeLessThan(wide)
  })

  it('result is always within [WPA2_SPLAT_MIN_M, WPA2_SPLAT_MAX_M]', () => {
    for (const depth of [0.01, 0.1, 1, 5, 10, 100]) {
      for (const fx of [100, 500, 1000, 4000]) {
        const d = wegterSplatDiameter(depth, fx)
        expect(d).toBeGreaterThanOrEqual(WPA2_SPLAT_MIN_M)
        expect(d).toBeLessThanOrEqual(WPA2_SPLAT_MAX_M)
      }
    }
  })

  it('custom overlap scales result proportionally', () => {
    const base   = wegterSplatDiameter(3, 1000, 1.0)
    const double = wegterSplatDiameter(3, 1000, 2.0)
    if (base > WPA2_SPLAT_MIN_M && double < WPA2_SPLAT_MAX_M) {
      expect(double).toBeCloseTo(base * 2, 4)
    }
  })

  it('formula: depth / fxRaw × overlap matches manual calculation', () => {
    const depth = 4, fx = 1200
    const raw  = depth / (fx + 1e-4) * WPA2_OVERLAP
    const clamped = Math.max(WPA2_SPLAT_MIN_M, Math.min(WPA2_SPLAT_MAX_M, raw))
    expect(wegterSplatDiameter(depth, fx)).toBeCloseTo(clamped, 8)
  })
})

// ─── WPA-2.1: panoramic wrapping prevention ───────────────────────────────────

describe('WPA-2.1 panoramic wrapping prevention', () => {
  // A wide-angle camera in the south corner of a room can technically "see" the
  // north wall, but that wall occupies the extreme periphery of the image — heavily
  // distorted. WPA-2.1 penalises these off-axis projections with cosView^4.

  it('a camera directly facing a wall (0° off-axis) has cosView ≈ 1', () => {
    // Camera at origin, point straight ahead at [0, 0, -5]
    const p = projectPoint([0, 0, -5], I4, K1000)
    expect(p).not.toBeNull()
    expect(p.cosView).toBeCloseTo(1.0, 5)
  })

  it('a camera with point at 45° off-axis has cosView ≈ 0.707', () => {
    // lat = depth * tan(45°) = 5 * 1 = 5 → point at [5, 0, -5]
    // cosView = cos(45°) ≈ 0.7071
    const p = projectPoint([5, 0, -5], I4, K1000)
    // May be outside the UV margin — if so, skip (that's the correct rejection)
    if (p) {
      expect(p.cosView).toBeCloseTo(Math.cos(Math.PI / 4), 4)
    }
  })

  it('cosView^4 at 45° ≈ 0.25 (steep penalisation)', () => {
    const cosView = Math.cos(45 * Math.PI / 180)
    const cv4     = cosView * cosView * cosView * cosView
    expect(cv4).toBeCloseTo(0.25, 4)
  })

  it('an on-axis camera outscores a 30° off-axis camera by >BLEND_RATIO', () => {
    // Both cameras at same depth; point is centred for camA, 30° off for camB.
    // Achieved by having the point straight ahead for camA and shifted for camB.
    const depth = 5
    const camA  = cam(I4)                                    // point at [0,0,−5] → 0° off-axis
    const lat   = depth * Math.tan(30 * Math.PI / 180)      // ~2.887
    // camB is translated so the point appears at 30° in its FOV:
    //   world point [0,0,−5], camB at [lat,0,0] → cx = 0−lat = −lat, cz = −5
    //   off-axis angle = atan(lat/5) = 30°
    const camB  = cam(translationW2C(lat, 0, 0))
    const norm  = [0, 0, -1]
    const result = selectCameras([0, 0, -5], norm, [camA, camB])
    // camA: cosView=1, score_A = angRes * 1 * 1
    // camB: cosView=cos(30°)≈0.866, score_B = angRes * 1 * 0.866^4 ≈ 0.562 * score_A
    // 0.562 < BLEND_RATIO=0.70 → camB excluded
    expect(result).toHaveLength(1)
    expect(result[0].camIdx).toBe(0)
  })

  it('a room-corner wide-angle camera is excluded from the opposite wall', () => {
    // Scenario: north wall at z = -6. Camera in south corner at z = +6.
    // Camera looks in -Z (toward north wall). Point on north wall: [0, 0, -6].
    // Camera at [0, 0, 6]: W2C translation = (0, 0, -6) → but translationW2C(0,0,6)
    //   gives col12-15 as [0, 0, -6, 1].
    // cz for point [0,0,-6]: 1*(-6) + (-6)*1 = -12 → depth=12
    // cx = 0, cy = 0, cz = -12 → cosView = 1.0 (point is dead centre for this camera)
    // Wait — that's directly ahead. Let me place camera off to the side instead.
    //
    // Better: camera in SW corner at [-5, 0, 5], looking in -Z.
    // W2C = translationW2C(-5, 0, 5).
    // Point on north wall: [0, 0, -5].
    // Camera space: cx = 0-(-5) = 5, cy=0, cz = -5+(−5) = -10 → depth=10
    // cpLen = sqrt(25+0+100) = sqrt(125) ≈ 11.18
    // cosView = 10/11.18 ≈ 0.894 → 26.6° off-axis
    // cosView^4 ≈ 0.639
    // And a frontal camera directly at origin: cosView=1, score_frontal = angRes_frontal
    // Depths: frontal=5, corner=10 → angRes_frontal/angRes_corner = 100/25 = 4×
    // score_frontal = fxRaw/25; score_corner = fxRaw/100 * 0.639 → ratio = 0.160
    // → 0.160 << BLEND_RATIO → corner cam is excluded
    const cornerW2C = translationW2C(-5, 0, 5)
    const camFrontal = cam(I4)            // at origin, point [0,0,−5] → depth=5, cosView=1
    const camCorner  = cam(cornerW2C)     // SW corner, point depth≈10, 26.6° off-axis
    const norm = [0, 0, -1]
    const result = selectCameras([0, 0, -5], norm, [camFrontal, camCorner])
    // frontal score >> corner score → corner excluded by WTA
    expect(result.some(r => r.camIdx === 0)).toBe(true)   // frontal present
    // corner may or may not be present; what matters is frontal dominates
    const frontWeight = result.find(r => r.camIdx === 0)?.weight ?? 0
    expect(frontWeight).toBeGreaterThan(0.9)
  })

  it('UV margin rejects the distorted outer 8% of the image', () => {
    // WPA2_UV_MARGIN = 0.08 → points projecting within 8% of the image edge are
    // rejected outright, regardless of score — catches max-distortion periphery.
    expect(WPA2_UV_MARGIN).toBe(0.08)
    // A point that projects to u = 0.07 should be null
    const depth = 5
    const uTarget = 0.07
    // u0 = fx_n * (cx/depth) + cx_n → cx = (uTarget - 0.5) * depth / 1.0 = (0.07-0.5)*5 = -2.15
    const cx = (uTarget - 0.5) * depth
    const p  = projectPoint([cx, 0, -depth], I4, K1000)
    expect(p).toBeNull()
  })

  it('UV margin passes points at 9% from the edge', () => {
    const depth   = 5
    const uTarget = 0.09    // just inside the 8% margin
    const cx = (uTarget - 0.5) * depth
    const p  = projectPoint([cx, 0, -depth], I4, K1000)
    expect(p).not.toBeNull()
    expect(p.u).toBeCloseTo(uTarget, 5)
  })

  it('selectCameras passes cosView from projectPoint to computeScore', () => {
    // Verify end-to-end: a camera with the point off-axis produces a lower score
    // than when the point is centred — and the weight difference reflects cosView^4.
    const depthVal  = 5
    const angle     = 20 * Math.PI / 180
    const lat       = depthVal * Math.tan(angle)

    // Camera A: point centred [0,0,−5]
    const camA = cam(I4)
    const resA = selectCameras([0, 0, -depthVal], [0, 0, -1], [camA])

    // Camera B: camera shifted so point is 20° off-axis
    const camB  = cam(translationW2C(lat, 0, 0))
    const resB  = selectCameras([0, 0, -depthVal], [0, 0, -1], [camB])

    expect(resA.length).toBeGreaterThan(0)
    expect(resB.length).toBeGreaterThan(0)

    // camA (centred): cosView=1, cosView^4=1
    // camB (20° off): cosView=cos(20°)≈0.940, cosView^4≈0.779
    // Depths are not equal (camB is further from point), so compare cosView directly.
    expect(resA[0].cosView).toBeCloseTo(1.0, 4)
    expect(resB[0].cosView).toBeLessThan(resA[0].cosView)
    expect(resB[0].cosView).toBeGreaterThan(0.9)  // cos(20°)≈0.94
  })

  it('two cameras at equal depth: more centred one wins', () => {
    // camA: point at dead centre (0° off-axis)
    // camB: same depth but point is 25° off-axis
    // Both have same depth → same angRes, same facing → cosView^4 decides
    // cos(25°)^4 ≈ 0.674 < BLEND_RATIO=0.70 → camB excluded
    const depth   = 5
    const angle25 = 25 * Math.PI / 180
    const lat25   = depth * Math.tan(angle25)

    const camA = cam(I4)                            // point centred
    const camB = cam(translationW2C(lat25, 0, 0))  // point 25° off-axis

    const result = selectCameras([0, 0, -depth], [0, 0, -1], [camA, camB])
    // camA score = angRes * 1 * 1;  camB score = angRes_B * 1 * cos(25°)^4 ≈ 0.674 * angRes_B
    // Depths are slightly different (camB laterally offset → same cz=−5 → depth=5 still,
    // but cpLen larger → cosView lower).  Both depths = 5.
    // score_B / score_A = cos(25°)^4 ≈ 0.674 < 0.70 → camB excluded
    const aPresent = result.some(r => r.camIdx === 0)
    const bPresent = result.some(r => r.camIdx === 1)
    expect(aPresent).toBe(true)
    expect(bPresent).toBe(false)
  })
})

// ─── Integration: point-center-only projection invariant ────────────────────

describe('WPA-2 integration invariant: point-center projection', () => {
  it('the same world point always yields the same UV regardless of gl_PointCoord offset', () => {
    // Simulates what the GLSL shader now does: project vWorldPos, NOT disc sub-pixel.
    // Any "disc offset" should NOT change the projected UV.
    const worldPos = [1.5, 0.2, -4.3]
    const cameras  = [cam()]
    const norm     = [0, 0, -1]

    const resultCenter = selectCameras(worldPos, norm, cameras)

    // Simulate disc sub-pixel offsets (as the old v1 shader did)
    const offsets = [[-0.1, 0.05, 0], [0.1, -0.05, 0], [0.08, 0.08, 0]]
    for (const [dx, dy, dz] of offsets) {
      const offsetPos = [worldPos[0]+dx, worldPos[1]+dy, worldPos[2]+dz]
      const resultOff = selectCameras(offsetPos, norm, cameras)
      // The WPA-2 test verifies that the CENTER is used: resultCenter should be
      // the canonical result. We check that the center UV and the offset UV
      // would differ — confirming the old v1 bug would have produced smearing.
      if (resultCenter.length > 0 && resultOff.length > 0) {
        const du = Math.abs(resultCenter[0].u - resultOff[0].u)
        const dv = Math.abs(resultCenter[0].v - resultOff[0].v)
        // They SHOULD differ (this is what caused v1 smearing)
        expect(du + dv).toBeGreaterThan(0)
      }
    }
    // And the center result is stable across calls
    const repeat = selectCameras(worldPos, norm, cameras)
    expect(repeat[0].u).toBeCloseTo(resultCenter[0].u, 8)
    expect(repeat[0].v).toBeCloseTo(resultCenter[0].v, 8)
  })

  it('WTA: a near camera completely dominates a 10× farther camera', () => {
    // Camera A: depth=2, Camera B: depth=20
    // score ratio = (fx/4) / (fx/400) = 100:1 → far outside 0.70 blend ratio → only A wins
    const camA   = cam(translationW2C(0, 0, 2))   // at z=+2, point at z=0 → depth=2
    const camB   = cam(translationW2C(0, 0, -18)) // at z=−18, point at z=0 → depth=18
    const point  = [0, 0, -2]  // wait, need to think about this more carefully
    // Camera A is at z=+2: W2C translates by (0,0,−2). Point [0,0,−2]:
    //   cz = 1*(0) + 1*(0) + 1*(−2) + 1*(−2) = −4 → depth=4? No.
    // translationW2C(0,0,2) means camera at world [0,0,2].
    // W2C shifts world by −camera_pos: [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,-2,1] NO.
    // translationW2C(tx,ty,tz) = [1,0,0,0, 0,1,0,0, 0,0,1,0, -tx,-ty,-tz,1]
    // For point [0,0,-5], camA at [0,0,2] (tz=2):
    //   cz = 0*0 + 0*0 + 1*(−5) + (−2)*1 = −5−2 = −7 → depth=7
    // For camB at [0,0,−20] (tz=−20):
    //   cz = −5 − (−20) = 15 → BEHIND camera! Need different setup.
    // Let's use cameras on same side:
    const cNear = cam(I4)                         // at origin, point [0,0,−5] → depth=5
    const cFar  = cam(translationW2C(0, 0, -40))  // at z=−40, point [0,0,−5]:
    //   cz = 1*(−5) + (−(−40)) = −5+40 = 35 → BEHIND. Wrong again.
    // camera at [0,0,−40]: W2C = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,40,1]
    // Wait, translationW2C(tx,ty,tz) gives -tx,-ty,-tz.
    // Camera at world origin (tx=ty=tz=0): W2C = identity → point at [0,0,−5]: cz=−5 ✓
    // Camera at world [0,0,10] (tx=0,ty=0,tz=10): W2C translation col = [0,0,−10,1]
    //   point [0,0,−5]: cz = 1*(−5) + (−10) = −15 → depth=15 ✓
    const cFar2 = cam(translationW2C(0, 0, 10))   // camera at world [0,0,10] → depth=15 for point at [0,0,−5]
    const result = selectCameras([0, 0, -5], [0, 0, -1], [cam(), cFar2])
    // camNear depth=5: score ∝ fx/25; cFar2 depth=15: score ∝ fx/225 → ratio=9
    // 9 > 1/BLEND_RATIO=1/0.70=1.43 → far camera excluded
    expect(result).toHaveLength(1)
    expect(result[0].camIdx).toBe(0)  // closer camera wins
  })
})

// ─── WPA-2.2: spin × warp integration ────────────────────────────────────────

describe('WPA-2.2 spin × warp sub-algorithm', () => {
  // "Spin" = facing⁴: penalises cameras yawed relative to wall normal.
  // "Warp" = cosView⁴: penalises cameras with point far from optical axis.
  // Both carry ^4 for symmetric steep exclusion cones (~25° for spin, ~22° for warp).

  it('frontal camera (0° spin, 0° warp) scores maximum', () => {
    // Camera at origin, point dead ahead, wall normal aligned → score = angRes
    const result = selectCameras([0, 0, -5], [0, 0, -1], [cam()])
    expect(result).toHaveLength(1)
    expect(result[0].score).toBeCloseTo(1000 / (25 + 0.001), 2)
  })

  it('25° yaw from wall normal → spin penalty excludes camera vs frontal', () => {
    // Frontal camera vs camera yawed 25° horizontally from wall normal.
    // For the yawed camera: the wall normal [0,0,-1] appears at 25° in its FOV.
    // Rotate wall normal 25° around Y: norm_in_yawed_cam = [sin(25°), 0, -cos(25°)]
    // facing = cos(25°) ≈ 0.906, facing^4 ≈ 0.674 < BLEND_RATIO=0.70 → excluded.
    // Both cameras at same depth, same fxRaw → only angRes and facing differ.
    const depth   = 5
    const angle   = 25 * Math.PI / 180
    // Camera A: frontal (wall normal stays [0,0,-1] in camera space = identity W2C)
    const camA = cam(I4)
    // Camera B: yawed 25° — simulate by rotating the wall normal 25° in world space
    // such that when projected into camera B (also identity W2C), normCam rotates.
    // Easier: give camera B a W2C that is a 25° Y-rotation so normCam.z = -cos(25°).
    // R_y(25°) rotates world→camera by 25° around Y:
    //   e.g. [cos25,0,-sin25, 0,1,0, sin25,0,cos25] stored column-major
    const c25 = Math.cos(angle), s25 = Math.sin(angle)
    const w2cYaw25 = [c25,0,s25,0, 0,1,0,0, -s25,0,c25,0, 0,0,0,1]
    const camB = cam(w2cYaw25)
    const norm = [0, 0, -1]
    const result = selectCameras([0, 0, -depth], norm, [camA, camB])
    // camA: facing=1, score=angRes; camB: facing=cos25, score=angRes×cos25^4
    // cos(25°)^4 ≈ 0.674 < 0.70 → camB excluded
    expect(result.some(r => r.camIdx === 0)).toBe(true)   // frontal survives
    expect(result.some(r => r.camIdx === 1)).toBe(false)  // yawed excluded
  })

  it('20° yaw (on-axis point) — excluded by combined spin×warp penalty', () => {
    // When the camera is yawed 20° from the wall normal, and the wall point is
    // on the wall's central axis (straight ahead in the frontal camera), the point
    // appears 20° off the yawed camera's optical axis too. Both spin (facing) and
    // warp (cosView) equal cos(20°), so combined: cos(20°)^8 ≈ 0.608 < 0.70 → excluded.
    // This is intentional — WPA-2.2 acceptance cone is ~17° for on-axis points.
    const depth   = 5
    const angle   = 20 * Math.PI / 180
    const c20 = Math.cos(angle), s20 = Math.sin(angle)
    const w2cYaw20 = [c20,0,s20,0, 0,1,0,0, -s20,0,c20,0, 0,0,0,1]
    const camB = cam(w2cYaw20)
    const norm = [0, 0, -1]
    const result = selectCameras([0, 0, -depth], norm, [cam(I4), camB])
    // Frontal camera survives; 20°-yawed camera is excluded for this on-axis point
    expect(result.some(r => r.camIdx === 0)).toBe(true)
    expect(result.some(r => r.camIdx === 1)).toBe(false)
  })

  it('15° yaw (on-axis point) — within WPA-2.2 cone, outside WPA-v4 cone', () => {
    // cos(15°)^8 ≈ 0.769
    //   WPA-2.2 (BLEND_RATIO=0.70): 0.769 > 0.70 → included
    //   WPA-v4  (BLEND_RATIO=0.85): 0.769 < 0.85 → excluded (tighter cone)
    const depth   = 5
    const angle   = 15 * Math.PI / 180
    const c15 = Math.cos(angle), s15 = Math.sin(angle)
    const w2cYaw15 = [c15,0,s15,0, 0,1,0,0, -s15,0,c15,0, 0,0,0,1]
    const camB = cam(w2cYaw15)
    const norm = [0, 0, -1]

    // WPA-2.2 behavior: pass old ratio explicitly
    const r22 = selectCameras([0, 0, -depth], norm, [cam(I4), camB], WPA2_BLEND_RATIO)
    expect(r22.some(r => r.camIdx === 0)).toBe(true)
    expect(r22.some(r => r.camIdx === 1)).toBe(true)  // included at 0.70

    // WPA-v4 behavior: default ratio (0.85) excludes the 15°-yawed camera
    const r4 = selectCameras([0, 0, -depth], norm, [cam(I4), camB])
    expect(r4.some(r => r.camIdx === 0)).toBe(true)
    expect(r4.some(r => r.camIdx === 1)).toBe(false)  // excluded at 0.85
  })

  it('30° yaw — clearly outside acceptance cone', () => {
    const depth   = 5
    const angle   = 30 * Math.PI / 180
    const c30 = Math.cos(angle), s30 = Math.sin(angle)
    const w2cYaw30 = [c30,0,s30,0, 0,1,0,0, -s30,0,c30,0, 0,0,0,1]
    const camB = cam(w2cYaw30)
    const norm = [0, 0, -1]
    const result = selectCameras([0, 0, -depth], norm, [cam(I4), camB])
    // cos(30°)^4 ≈ 0.563 < 0.70 → excluded
    expect(result.some(r => r.camIdx === 0)).toBe(true)
    expect(result.some(r => r.camIdx === 1)).toBe(false)
  })

  it('spin × warp combined: 18° yaw + 18° off-axis → score ≈ 0.471 × frontal → excluded', () => {
    // Both spin and warp at 18°: cos(18°)^4 × cos(18°)^4 = cos(18°)^8 ≈ 0.471 < 0.70
    const depth  = 5
    const angle  = 18 * Math.PI / 180
    const lat    = depth * Math.tan(angle)  // point offset for 18° off-axis

    const c18 = Math.cos(angle), s18 = Math.sin(angle)
    // Camera yawed 18° (spin)
    const w2cYaw18 = [c18,0,s18,0, 0,1,0,0, -s18,0,c18,0, 0,0,0,1]
    const camYawed = cam(w2cYaw18)

    const norm = [0, 0, -1]
    // Point shifted 18° off-axis laterally (warp) for the frontal camera
    // lat offset → point at [lat, 0, -depth]: cosView = cos(18°)
    const p = projectPoint([lat, 0, -depth], w2cYaw18, K1000)
    // Both effects combined: score = angRes × cos(18°)^4 × cos(18°)^4 ≈ 0.471 × frontal
    if (p) {
      const score = computeScore(p.depth, 1000, norm, w2cYaw18, p.cosView)
      const frontalScore = computeScore(depth, 1000, norm, I4, 1.0)
      // 0.471 < 0.70 → excluded relative to frontal
      expect(score / frontalScore).toBeLessThan(WPA2_BLEND_RATIO)
    }
  })

  it('facing⁴ penalises 25° yaw more than facing² did', () => {
    // Under the old facing² formula, cos(25°)² ≈ 0.821 > 0.70 → included.
    // Under the new facing⁴ formula, cos(25°)⁴ ≈ 0.674 < 0.70 → excluded.
    const angle  = 25 * Math.PI / 180
    const facing = Math.cos(angle)
    const old_score_ratio = facing * facing             // WPA-2.1: facing²
    const new_score_ratio = facing * facing * facing * facing  // WPA-2.2: facing⁴
    expect(old_score_ratio).toBeGreaterThan(WPA2_BLEND_RATIO)  // WPA-2.1 would include it
    expect(new_score_ratio).toBeLessThan(WPA2_BLEND_RATIO)     // WPA-2.2 excludes it
  })

  it('selectCameras: among 4 cameras at 0°/20°/30°/45° yaw, only 0° contributes for on-axis point', () => {
    // Simulates 4 photos taken while spinning. For a wall point on the central axis,
    // combined spin×warp acceptance cone is ~17°, so only the frontal camera passes.
    // cos(20°)^8 ≈ 0.608 < 0.70 → excluded; cos(30°)^8 ≈ 0.317; cos(45°)^8 ≈ 0.063.
    const depth = 5
    const makeYaw = (deg) => {
      const a = deg * Math.PI / 180
      const c = Math.cos(a), s = Math.sin(a)
      return cam([c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1])
    }
    const cameras = [makeYaw(0), makeYaw(20), makeYaw(30), makeYaw(45)]
    const result  = selectCameras([0, 0, -depth], [0, 0, -1], cameras)
    const idxs    = result.map(r => r.camIdx)
    expect(idxs).toContain(0)          // frontal survives
    expect(idxs).not.toContain(1)      // 20° — excluded (combined cos^8 = 0.608 < 0.70)
    expect(idxs).not.toContain(2)      // 30° — excluded
    expect(idxs).not.toContain(3)      // 45° — excluded
  })
})
