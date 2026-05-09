import { describe, expect, it } from 'vitest'

import {
  buildPointCloudPreview,
  getPreviewStride,
  MAX_POINT_CLOUD_PREVIEW_POINTS,
  selectPreviewSnapshots,
} from './scanPreview'

describe('scanPreview', () => {
  it('keeps preview stride at one below the render budget', () => {
    expect(getPreviewStride(0)).toBe(1)
    expect(getPreviewStride(MAX_POINT_CLOUD_PREVIEW_POINTS)).toBe(1)
    expect(getPreviewStride(MAX_POINT_CLOUD_PREVIEW_POINTS + 1)).toBe(2)
  })

  it('evenly samples preview snapshots while keeping endpoints', () => {
    const snapshots = Array.from({ length: 75 }, (_, index) => ({ id: index }))
    const picked = selectPreviewSnapshots(snapshots, 5)
    expect(picked.map(s => s.id)).toEqual([0, 19, 37, 56, 74])
  })

  it('builds a spatially stable voxel preview from the full point cloud', () => {
    const raw = new Float32Array([
      0.01, 0.0, 0.02, 1, 0, 0,
      0.02, 0.0, 0.03, 0, 1, 0,
      1.01, 0.5, 0.04, 0, 0, 1,
      1.03, 0.5, 0.05, 1, 1, 1,
    ])
    const preview = buildPointCloudPreview(raw, 4, { maxPreviewPoints: 10, cellSize: 0.1 })
    expect(preview.positions.length).toBe(6)
    expect(preview.colors[0]).toBeCloseTo(0.5, 6)
    expect(preview.colors[1]).toBeCloseTo(0.5, 6)
    expect(preview.yOffset).toBeCloseTo(0, 6)
  })
})