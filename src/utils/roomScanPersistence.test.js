import { describe, expect, it } from 'vitest'
import { cloneRoomForEditing, toRoomScanMeta } from './roomScanPersistence'

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
})
