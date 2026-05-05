/**
 * SpacesManager — Modal for listing, editing, and deleting saved spaces.
 * Reuses rm-* CSS classes from RoomManager for visual consistency.
 */
import { useState } from 'react'

export default function SpacesManager({ spaces = {}, onEdit, onDelete, onNew, onClose }) {
  const [confirmDel, setConfirmDel] = useState(null)

  const spaceList = Object.values(spaces)
    .filter(r => r.roomType === 'space')
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))

  return (
    <div className="rm-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="rm-modal">

        {/* Header */}
        <div className="rm-header">
          <h2>My Spaces</h2>
          <button className="icon-btn rm-close" onClick={onClose} aria-label="Close">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* New Space */}
        <div style={{ padding: '0 16px 12px' }}>
          <button className="btn btn-primary" style={{ width: '100%' }} onClick={onNew}>
            + New Space
          </button>
        </div>

        {/* Space list */}
        <div className="rm-list">
          {spaceList.length === 0 && (
            <div className="rm-empty">
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                <rect x="6" y="6" width="15" height="15" rx="2" stroke="currentColor" strokeWidth="1.5" opacity="0.35"/>
                <rect x="27" y="6" width="15" height="15" rx="2" stroke="currentColor" strokeWidth="1.5" opacity="0.35"/>
                <rect x="6" y="27" width="15" height="15" rx="2" stroke="currentColor" strokeWidth="1.5" opacity="0.35"/>
                <rect x="27" y="27" width="15" height="15" rx="2" stroke="currentColor" strokeWidth="1.5" opacity="0.35"/>
              </svg>
              <p>No saved spaces yet.</p>
              <p className="rm-empty-sub">Click "+ New Space" above to start building.</p>
            </div>
          )}

          {spaceList.map(space => {
            const thumb        = space.surfaces?.find(s => s.warpedDataUrl)?.warpedDataUrl
            const surfaceCount = space.surfaces?.length || 0

            return (
              <div key={space.id} className="rm-room-row">
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
                  <span className="rm-room-name">{space.name || 'Untitled Space'}</span>
                  <span className="rm-room-dims">
                    {surfaceCount} surface{surfaceCount !== 1 ? 's' : ''}
                  </span>
                </div>

                {/* Actions */}
                <div className="rm-room-actions">
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => onEdit(space.id)}
                  >
                    Edit
                  </button>

                  {confirmDel === space.id ? (
                    <>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => { onDelete(space.id); setConfirmDel(null) }}
                      >
                        Confirm
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => setConfirmDel(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => setConfirmDel(space.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
