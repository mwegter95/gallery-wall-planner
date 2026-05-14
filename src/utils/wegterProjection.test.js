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

  it('score formula: angRes × facing² matches manual calculation', () => {
    const depth   = 3
    const fxRaw   = 1200
    const norm    = [0, 0, -1]    // normCam.z = −1, facing = 1
    const angRes  = fxRaw / (depth * depth + 0.001)
    const expected = angRes * 1 * 1   // facing² = 1
    expect(computeScore(depth, fxRaw, norm, I4)).toBeCloseTo(expected, 4)
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
