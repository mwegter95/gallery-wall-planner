import { describe, expect, it } from 'vitest'

import { normalizeIntrinsicsForImage } from './photoMesh'

describe('photoMesh', () => {
  it('rescales intrinsics to the decoded image size', () => {
    expect(normalizeIntrinsicsForImage([10, 20, 30, 40, 100, 200], 200, 100)).toEqual([
      20, 10, 60, 20, 200, 100,
    ])
  })

})