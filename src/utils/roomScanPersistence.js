/**
 * Helpers for safely cloning/saving room scans.
 *
 * PointCloudBuffer instances are class objects with typed-array backing.
 * JSON cloning destroys them, so we preserve references when present.
 */

/** Clone a room/space object while preserving live PointCloudBuffer instances. */
export function cloneRoomForEditing(room) {
  if (!room) return room
  const cloned = JSON.parse(JSON.stringify(room))
  const liveBuffer = room.roomScan?.pointCloud?._buffer
  if (liveBuffer && cloned.roomScan?.pointCloud) {
    cloned.roomScan.pointCloud._buffer = liveBuffer
  }
  return cloned
}

/**
 * Build a compact roomScan payload for persistence.
 * Keeps a compact keyframe snapshot set for reprojection and drops raw point-cloud binary fields.
 */
export function toRoomScanMeta(roomScan) {
  if (!roomScan) return roomScan
  const pc = roomScan.pointCloud
  const pointCloud = pc
    ? { pointCount: pc.pointCount, url: pc.url ?? null }
    : pc

  const snapshots = Array.isArray(roomScan.snapshots)
    ? roomScan.snapshots
        .filter(s =>
          (s?.dataUrl || s?.jpegB64) &&
          Array.isArray(s?.transform) && s.transform.length === 16 &&
          Array.isArray(s?.intrinsics) && s.intrinsics.length === 6,
        )
        // Keep a compact but useful keyframe set for post-reload reprojection.
        .slice(-36)
        .map(s => ({
          ...(s.dataUrl ? { dataUrl: s.dataUrl } : { jpegB64: s.jpegB64 }),
          transform: s.transform,
          intrinsics: s.intrinsics,
        }))
    : []

  return {
    ...roomScan,
    pointCloud,
    snapshots,
  }
}
