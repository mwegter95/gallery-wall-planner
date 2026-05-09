import { describe, expect, it } from 'vitest'

import {
  classifySurfaceNormal,
  computeUvBasis,
  segmentReconstructedMesh,
} from './scanReconstructionPipeline'

describe('scanReconstructionPipeline', () => {
  it('classifies planar normals for interior surfaces', () => {
    expect(classifySurfaceNormal([0, 1, 0])).toBe('floor')
    expect(classifySurfaceNormal([0, -1, 0])).toBe('ceiling')
    expect(classifySurfaceNormal([1, 0, 0])).toBe('wall')
  })

  it('builds a stable UV basis from a surface normal', () => {
    const { tangent, bitangent } = computeUvBasis([0, 0, 1])
    expect(Math.hypot(...tangent)).toBeCloseTo(1, 6)
    expect(Math.hypot(...bitangent)).toBeCloseTo(1, 6)
    expect(tangent[2]).toBeCloseTo(0, 6)
    expect(bitangent[2]).toBeCloseTo(0, 6)
  })

  it('segments and classifies reconstructed triangles into planar elements', () => {
    const positions = new Float32Array([
      0, 0, 0,
      0, 1, 0,
      0, 0, 1,
      0, 1, 1,
      0, 0, 0,
      1, 0, 0,
      0, 0, 1,
      1, 0, 1,
    ])
    const colors = new Float32Array(new Array(positions.length).fill(0.5))
    const indices = new Uint32Array([
      0, 1, 2,
      1, 3, 2,
      4, 6, 5,
      5, 6, 7,
    ])

    const segments = segmentReconstructedMesh(
      { positions, colors, indices },
      { minTriangles: 2, normalTolerance: 0.2, planeTolerance: 0.2 },
    )

    expect(segments).toHaveLength(2)
    expect(segments.map(segment => segment.classification).sort()).toEqual(['floor', 'wall'])
    for (const segment of segments) {
      expect(segment.uvs.length).toBe((segment.positions.length / 3) * 2)
      const minUv = Math.min(...segment.uvs)
      const maxUv = Math.max(...segment.uvs)
      expect(minUv).toBeGreaterThanOrEqual(0)
      expect(maxUv).toBeLessThanOrEqual(1)
    }
  })
})