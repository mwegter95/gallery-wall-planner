/**
 * RoomManager — Modal for creating, listing, and selecting 3D rooms.
 */
import { useState } from 'react'
import { inToCmInt, cmToIn } from '../utils/units'
import { FACES, FACE_META } from '../utils/room3d'

const DEFAULT_W = 144  // 12 ft
const DEFAULT_H = 96   // 8 ft
const DEFAULT_D = 144  // 12 ft

export default function RoomManager({
  rooms = {},
  activeRoomId,
  onSelect,
  onView3D,
  onSetupRoom,
  onEditRoom,
  onDelete,
  onClose,
  unitSystem = 'imperial',
}) {
  const [newName, setNewName]   = useState('')
  const [nameErr, setNameErr]   = useState('')
  const [confirmDel, setConfirmDel] = useState(null)

  const roomList = Object.values(rooms).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

  const unit = unitSystem === 'metric' ? 'cm' : '"'

  const fmtDim = (in_) =>
    unitSystem === 'metric' ? `${inToCmInt(in_)} cm` : `${in_}"`

  // Count how many surfaces in a room have photos
  const photoCount = (room) =>
    FACES.filter(f => room.surfaces?.[f]?.warpedImageUrl).length

  const handleCreate = () => {
    const name = newName.trim()
    if (!name) { setNameErr('Enter a room name'); return }
    setNameErr('')
    setNewName('')
    onSetupRoom({ name })
  }

  return (
    <div className="rm-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="rm-modal">
        {/* Header */}
        <div className="rm-header">
          <h2>My 3D Rooms</h2>
          <button className="icon-btn rm-close" onClick={onClose} aria-label="Close">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Room list */}
        <div className="rm-list">
          {roomList.length === 0 && (
            <div className="rm-empty">
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                <rect x="4" y="8" width="40" height="32" rx="3" stroke="currentColor" strokeWidth="1.5" opacity="0.3"/>
                <path d="M4 8l20 14L44 8" stroke="currentColor" strokeWidth="1.5" opacity="0.3"/>
              </svg>
              <p>No 3D rooms yet.</p>
              <p className="rm-empty-sub">Create one below to start your room tour.</p>
            </div>
          )}

          {roomList.map(room => {
            const isActive = room.id === activeRoomId
            const nPhoto   = photoCount(room)
            // Use first available warped image as thumbnail
            const thumb    = FACES.map(f => room.surfaces?.[f]?.warpedImageUrl).find(Boolean)

            return (
              <div key={room.id} className={`rm-room-row ${isActive ? 'rm-room-row--active' : ''}`}>
                {/* Thumbnail */}
                <div className="rm-thumb">
                  {thumb
                    ? <img src={thumb} alt="" className="rm-thumb-img" />
                    : (
                      <div className="rm-thumb-placeholder">
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                          <path d="M2 14l4-4 3 3 4-5 5 6" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" opacity="0.5"/>
                        </svg>
                      </div>
                    )
                  }
                </div>

                {/* Info */}
                <div className="rm-room-info">
                  <span className="rm-room-name">{room.name}</span>
                  <span className="rm-room-dims">
                    {fmtDim(room.roomWidth)} × {fmtDim(room.roomDepth)} × {fmtDim(room.roomHeight)}
                  </span>
                  <span className="rm-room-surfaces">
                    {nPhoto}/{FACES.length} surfaces photographed
                  </span>
                </div>

                {/* Actions */}
                <div className="rm-room-actions">
                  {nPhoto > 0 && (
                    <button
                      className="btn btn-sm btn-primary rm-view-btn"
                      onClick={() => { onSelect(room.id); onView3D(room.id) }}
                      title="Open 3D room tour"
                    >
                      <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                        <rect x="1" y="3" width="11" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
                        <circle cx="6.5" cy="7" r="2" stroke="currentColor" strokeWidth="1.2"/>
                      </svg>
                      Tour
                    </button>
                  )}
                  <button
                    className="btn btn-sm btn-outline"
                    onClick={() => { onSelect(room.id); onEditRoom(room.id) }}
                    title="Add or re-crop surface photos"
                  >
                    Edit
                  </button>
                  {confirmDel === room.id ? (
                    <>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => { onDelete(room.id); setConfirmDel(null) }}
                      >Confirm Delete</button>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => setConfirmDel(null)}
                      >Cancel</button>
                    </>
                  ) : (
                    <button
                      className="btn btn-sm btn-ghost rm-delete-btn"
                      onClick={() => setConfirmDel(room.id)}
                      title="Delete room"
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M1 3h10M4 3V2h4v1M5 5v4M7 5v4M2 3l1 8h6l1-8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Create new room */}
        <div className="rm-create">
          <h3 className="rm-create-title">New Room</h3>
          <div className="rm-create-row">
            <input
              className="rm-name-input"
              placeholder="Room name (e.g. Living Room)"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
            />
            <button className="btn btn-primary" onClick={handleCreate}>
              + Create
            </button>
          </div>
          {nameErr && <p className="rm-name-error">{nameErr}</p>}
        </div>
      </div>
    </div>
  )
}
