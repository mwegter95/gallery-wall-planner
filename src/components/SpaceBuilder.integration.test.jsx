import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const canvasSpy = vi.fn(() => <div data-testid="space-canvas" />)

vi.mock('./SpaceBuilderCanvas', () => ({
  default: (props) => {
    canvasSpy(props)
    return <div data-testid="space-canvas" />
  },
}))

vi.mock('./EraseModal', () => ({ default: () => null }))
vi.mock('./LidarScanner', () => ({ default: () => null }))
vi.mock('./WallSetup', () => ({ default: () => null }))

import SpaceBuilder from './SpaceBuilder'

function makeRoom(id, name, buffer, capturedAt = 1000) {
  return {
    id,
    name,
    surfaces: [],
    photos: [],
    roomScan: {
      capturedAt,
      planes: [],
      snapshots: [],
      pointCloud: { pointCount: 10, _buffer: buffer },
    },
  }
}

describe('SpaceBuilder integration', () => {
  beforeEach(() => {
    canvasSpy.mockClear()
  })

  it('loads selected room and preserves point cloud buffer reference', async () => {
    const buf1 = { id: 'buf-1' }
    const buf2 = { id: 'buf-2' }

    const roomA = makeRoom('r1', 'Room 1', buf1, 1000)
    const roomB = makeRoom('r2', 'Room 2', buf2, 2000)

    render(
      <SpaceBuilder
        existingSpace={roomA}
        rooms={{ r1: roomA, r2: roomB }}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        library={{}}
        allLayouts={{}}
        walls={{}}
      />
    )

    const select = screen.getByTitle('Switch room')
    fireEvent.change(select, { target: { value: 'r2' } })

    await waitFor(() => {
      const last = canvasSpy.mock.calls.at(-1)?.[0]
      expect(last?.roomScan?.pointCloud?._buffer).toBe(buf2)
    })
  })

  it('save overwrite flow invokes onSave with progress callback', async () => {
    const room = makeRoom('r1', 'Room 1', { id: 'buf-1' }, 1000)
    const onSave = vi.fn(async (_space, onProgress) => {
      onProgress?.(25)
      onProgress?.(75)
    })

    render(
      <SpaceBuilder
        existingSpace={room}
        rooms={{ r1: room }}
        onSave={onSave}
        onClose={vi.fn()}
        library={{}}
        allLayouts={{}}
        walls={{}}
      />
    )

    fireEvent.click(screen.getAllByTitle('Save room')[0])
    fireEvent.click(screen.getByText(/Overwrite/))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const [savedSpace, progressFn] = onSave.mock.calls[0]
    expect(savedSpace.id).toBe('r1')
    expect(typeof progressFn).toBe('function')
  })
})
