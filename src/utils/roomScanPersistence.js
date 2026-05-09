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
 * Drops heavy snapshot image payloads and raw point-cloud binary fields.
 */
export function toRoomScanMeta(roomScan) {
  if (!roomScan) return roomScan
  const pc = roomScan.pointCloud
  const pointCloud = pc
    ? { pointCount: pc.pointCount, url: pc.url ?? null }
    : pc
  return {
    ...roomScan,
    pointCloud,
    snapshots: [],
  }
}
