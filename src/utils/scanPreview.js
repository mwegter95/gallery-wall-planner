export const MAX_POINT_CLOUD_PREVIEW_POINTS = 900_000
export const MAX_POINT_CLOUD_PREVIEW_SNAPSHOTS = 24

export function getPreviewStride(pointCount, maxPreviewPoints = MAX_POINT_CLOUD_PREVIEW_POINTS) {
  if (!Number.isFinite(pointCount) || pointCount <= 0) return 1
  return Math.max(1, Math.ceil(pointCount / maxPreviewPoints))
}

export function selectPreviewSnapshots(snapshots, maxSnapshots = MAX_POINT_CLOUD_PREVIEW_SNAPSHOTS) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return []
  if (snapshots.length <= maxSnapshots) return snapshots
  if (maxSnapshots <= 1) return [snapshots[0]]

  const selected = []
  let lastIndex = -1
  for (let i = 0; i < maxSnapshots; i++) {
    const index = Math.round((i * (snapshots.length - 1)) / (maxSnapshots - 1))
    if (index === lastIndex) continue
    selected.push(snapshots[index])
    lastIndex = index
  }
  return selected
}