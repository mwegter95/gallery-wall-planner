import { describe, expect, it } from 'vitest'
import { cloneRoomForEditing, normalizeLoadedRooms, toRoomScanMeta, toRoomsSnapshot } from './roomScanPersistence'

describe('roomScanPersistence', () => {
  it('preserves live PointCloudBuffer reference during clone', () => {
    const liveBuffer = { pointCount: 123, _data: new Float32Array([1, 2, 3]) }
    const room = {
      id: 'room-1',
      roomScan: {
        capturedAt: 123,
        pointCloud: { pointCount: 123, _buffer: liveBuffer },
      },
    }

    const cloned = cloneRoomForEditing(room)
    expect(cloned).not.toBe(room)
    expect(cloned.roomScan.pointCloud._buffer).toBe(liveBuffer)
  })

  it('builds compact metadata roomScan payload', () => {
    const roomScan = {
      capturedAt: 123,
      pointCloud: {
        pointCount: 42,
        _buffer: { foo: 'bar' },
        data: 'abc',
        url: '/uploads/walls/pc.bin',
      },
      snapshots: [{
        dataUrl: 'data:image/jpeg;base64,abc',
        transform: new Array(16).fill(0),
        intrinsics: [10, 10, 5, 5, 100, 100],
      }],
    }

    const meta = toRoomScanMeta(roomScan)
    expect(meta.pointCloud).toEqual({ pointCount: 42, url: '/uploads/walls/pc.bin' })
    expect(meta.snapshots).toHaveLength(1)
  })

  it('serializes rooms for local snapshot without live point cloud payload', () => {
    const rooms = {
      'room-1': {
        id: 'room-1',
        roomScan: {
          pointCloud: { pointCount: 12, _buffer: { some: 'live' }, data: 'legacy', url: '/uploads/walls/pc.bin' },
          snapshots: [{
            dataUrl: 'data:image/jpeg;base64,abc',
            transform: new Array(16).fill(0),
            intrinsics: [10, 10, 5, 5, 100, 100],
          }],
        },
      },
    }

    const snapshot = toRoomsSnapshot(rooms)
    expect(snapshot['room-1'].roomScan.pointCloud).toEqual({ pointCount: 12, url: '/uploads/walls/pc.bin' })
    expect(snapshot['room-1'].roomScan.snapshots).toHaveLength(1)
  })

  it('normalizes loaded rooms by fixing relative URLs and filtering invalid snapshots', () => {
    const rooms = {
      'room-1': {
        id: 'room-1',
        roomScan: {
          pointCloud: { pointCount: 12, url: '/uploads/walls/pc.bin' },
          snapshots: [
            {
              dataUrl: 'data:image/jpeg;base64,abc',
              transform: new Array(16).fill(0),
              intrinsics: [10, 10, 5, 5, 100, 100],
            },
            {
              dataUrl: 'data:image/jpeg;base64,bad',
              transform: [1, 2, 3],
              intrinsics: [10, 10, 5, 5, 100, 100],
            },
          ],
        },
        surfaces: {
          a: { warpedImageUrl: '/uploads/walls/a.png' },
        },
      },
    }

    const fixed = normalizeLoadedRooms(rooms, (url) => `https://cdn.example.com${url}`)
    expect(fixed['room-1'].roomScan.pointCloud.url).toBe('https://cdn.example.com/uploads/walls/pc.bin')
    expect(fixed['room-1'].roomScan.snapshots).toHaveLength(1)
    expect(fixed['room-1'].surfaces.a.warpedImageUrl).toBe('https://cdn.example.com/uploads/walls/a.png')
  })
})
