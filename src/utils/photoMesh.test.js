import { describe, expect, it } from 'vitest'

import { blendSnapshotColors, normalizeIntrinsicsForImage } from './photoMesh'

describe('photoMesh', () => {
  it('rescales intrinsics to the decoded image size', () => {
    expect(normalizeIntrinsicsForImage([10, 20, 30, 40, 100, 200], 200, 100)).toEqual([
      20, 10, 60, 20, 200, 100,
    ])
  })

  it('blends snapshot samples with weighted averaging', () => {
    const blended = blendSnapshotColors([
      { color: [1, 0, 0], weight: 4 },
      { color: [0, 0, 1], weight: 1 },
    ])

    expect(blended?.[0]).toBeCloseTo(0.8, 6)
    expect(blended?.[1]).toBeCloseTo(0, 6)
    expect(blended?.[2]).toBeCloseTo(0.2, 6)
  })
})