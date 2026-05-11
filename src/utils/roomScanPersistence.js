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
 * Drops raw point-cloud binary fields and keeps only point-count + URL metadata.
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
  }
}

/** Build a localStorage-safe rooms map (drops live binary payloads, keeps scan URLs). */
export function toRoomsSnapshot(rooms) {
  const out = {}
  for (const [roomId, room] of Object.entries(rooms || {})) {
    if (!room) continue
    out[roomId] = room.roomScan
      ? { ...room, roomScan: toRoomScanMeta(room.roomScan) }
      : { ...room }
  }
  return out
}

/** Normalize loaded rooms by fixing relative URLs. */
export function normalizeLoadedRooms(rooms, fixUrl) {
  const out = {}
  const applyFixUrl = typeof fixUrl === 'function' ? fixUrl : (url) => url
  for (const [roomId, room] of Object.entries(rooms || {})) {
    if (!room) continue
    const next = { ...room }
    if (next.roomScan?.pointCloud?.url?.startsWith('/')) {
      next.roomScan = {
        ...next.roomScan,
        pointCloud: {
          ...next.roomScan.pointCloud,
          url: applyFixUrl(next.roomScan.pointCloud.url),
        },
      }
    }
    for (const surface of Object.values(next.surfaces || {})) {
      if (surface.warpedImageUrl?.startsWith('/')) {
        surface.warpedImageUrl = applyFixUrl(surface.warpedImageUrl)
      }
    }
    out[roomId] = next
  }
  return out
}
