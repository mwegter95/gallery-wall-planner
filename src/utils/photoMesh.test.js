import { describe, expect, it } from 'vitest'

import { fuseVisibleCandidates, isDepthVisible, normalizeIntrinsicsForImage } from './photoMesh'

describe('photoMesh', () => {
  it('rescales intrinsics to the decoded image size', () => {
    expect(normalizeIntrinsicsForImage([10, 20, 30, 40, 100, 200], 200, 100)).toEqual([
      20, 10, 60, 20, 200, 100,
    ])
  })

  it('treats small depth residuals as visible and large residuals as occluded', () => {
    expect(isDepthVisible(2.04, 2.0)).toBe(true)
    expect(isDepthVisible(2.25, 2.0)).toBe(false)
  })

  it('fuses close colors and rejects strong outliers', () => {
    const fused = fuseVisibleCandidates([
      { color: [0.50, 0.40, 0.30], score: 0.90 },
      { color: [0.52, 0.39, 0.31], score: 0.80 },
      { color: [0.95, 0.95, 0.95], score: 0.70 },
    ])
    expect(fused[0]).toBeGreaterThan(0.49)
    expect(fused[0]).toBeLessThan(0.55)
    expect(fused[1]).toBeGreaterThan(0.35)
    expect(fused[1]).toBeLessThan(0.45)
    expect(fused[2]).toBeGreaterThan(0.28)
    expect(fused[2]).toBeLessThan(0.34)
  })

})