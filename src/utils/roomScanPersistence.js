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

/** Build a localStorage-safe rooms map (drops live binary payloads but keeps scan URLs/snapshots). */
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

/** Normalize loaded rooms by fixing relative URLs and filtering invalid snapshots. */
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
    if (Array.isArray(next.roomScan?.snapshots)) {
      next.roomScan.snapshots = next.roomScan.snapshots.filter(s =>
        (s?.dataUrl || s?.jpegB64) &&
        Array.isArray(s?.transform) && s.transform.length === 16 &&
        Array.isArray(s?.intrinsics) && s.intrinsics.length === 6,
      )
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
