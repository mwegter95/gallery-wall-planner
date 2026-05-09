import { describe, expect, it } from 'vitest'

import {
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
})