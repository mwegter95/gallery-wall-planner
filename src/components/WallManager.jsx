import { useState } from 'react'

const DEFAULT_W = 120
const DEFAULT_H = 96

export default function WallManager({
  walls,
  wallImages = {},
  allLayouts = {},
  activeWallId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onSetupWall,
  onClose,
}) {
  const [newName,   setNewName]   = useState('')
  const [newWidth,  setNewWidth]  = useState(DEFAULT_W)
  const [newHeight, setNewHeight] = useState(DEFAULT_H)
  const [nameError, setNameError] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [editName,  setEditName]  = useState('')

  const wallList = Object.values(walls).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))

  /* ── Create ─────────────────────────────────────────── */
  const handleCreate = () => {
    const name = newName.trim()
    if (!name) { setNameError('Enter a wall name'); return }
    const w = Math.max(10, Math.min(999, Number(newWidth)  || DEFAULT_W))
    const h = Math.max(10, Math.min(999, Number(newHeight) || DEFAULT_H))
    onCreate({ name, width: w, height: h })
    setNewName('')
    setNewWidth(DEFAULT_W)
    setNewHeight(DEFAULT_H)
    setNameError('')
  }

  /* ── Rename ─────────────────────────────────────────── */
  const commitRename = (id) => {
    const name = editName.trim()
    if (name) onRename(id, name)
    setEditingId(null)
    setEditName('')
  }

  return (
    <div className="wm-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="wm-modal">
        <div className="wm-header">
          <h2>My Walls</h2>
          <button className="icon-btn wm-close" onClick={onClose} aria-label="Close">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>

        {/* ── Wall list ──────────────────────────────── */}
        <div className="wm-list">
          {wallList.length === 0 && (
            <p className="wm-empty">No walls yet. Create one below.</p>
          )}

          {wallList.map((wall) => {
            const isActive = wall.id === activeWallId
            const layoutCount = Object.keys(allLayouts[wall.id] || {}).length

            return (
              <div key={wall.id} className={`wm-wall-row ${isActive ? 'wm-wall-row--active' : ''}`}>
                {/* Thumbnail */}
                <div className="wm-thumb">
                  {wallImages[wall.id]
                    ? <img src={wallImages[wall.id]} alt={wall.name} />
                    : <span className="wm-thumb-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="4" width="16" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/><circle cx="7" cy="8.5" r="1.5" stroke="currentColor" strokeWidth="1.25"/><path d="M2 13l4-3 3 3 3-3 4 3" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/></svg></span>
                  }
                </div>

                {/* Info / inline name editor */}
                <div className="wm-wall-info">
                  {editingId === wall.id ? (
                    <input
                      className="wm-name-input"
                      value={editName}
                      autoFocus
                      onChange={e => setEditName(e.target.value)}
                      onBlur={() => commitRename(wall.id)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') commitRename(wall.id)
                        if (e.key === 'Escape') { setEditingId(null); setEditName('') }
                      }}
                    />
                  ) : (
                    <span
                      className="wm-wall-name"
                      title="Click to rename"
                      onClick={() => { setEditingId(wall.id); setEditName(wall.name) }}
                    >
                      {wall.name}
                      {isActive && <span className="wm-active-badge">active</span>}
                    </span>
                  )}
                  <span className="wm-wall-dims">{wall.width}" × {wall.height}"</span>
                  <span className="wm-layout-count">
                    {layoutCount === 0 ? 'No saved layouts' : `${layoutCount} layout${layoutCount !== 1 ? 's' : ''}`}
                  </span>
                  {!wallImages[wall.id] && (
                    <span className="wm-no-photo">No photo yet</span>
                  )}
                </div>

                {/* Actions */}
                <div className="wm-wall-actions">
                  {!isActive && (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => { onSelect(wall.id); onClose() }}
                    >
                      Open
                    </button>
                  )}
                  <button
                    className="btn btn-ghost btn-sm"
                    title="Upload / recalibrate wall photo"
                    onClick={() => { onSetupWall(wall.id); onClose() }}
                  >
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg" className="btn-icon"><rect x="1" y="4" width="11" height="7" rx="1" stroke="currentColor" strokeWidth="1.25"/><path d="M4.5 4V3a1.5 1.5 0 013 0v1" stroke="currentColor" strokeWidth="1.25"/><circle cx="6.5" cy="7.5" r="1.5" stroke="currentColor" strokeWidth="1.25"/></svg>
                    {wallImages[wall.id] ? 'Recalibrate' : 'Set Photo'}
                  </button>
                  {wallList.length > 1 && (
                    <button
                      className="icon-btn wm-delete-btn"
                      title="Delete wall"
                      onClick={() => {
                        if (window.confirm(`Delete wall "${wall.name}" and all its layouts?`))
                          onDelete(wall.id)
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 3.5h9M5 3.5V2.5h3v1M5.5 5.5v4M7.5 5.5v4M3 3.5l.5 7h6l.5-7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* ── Create new wall ────────────────────────── */}
        <div className="wm-create">
          <h3 className="wm-create-title">New Wall</h3>
          <div className="wm-create-row">
            <input
              className="text-input wm-create-name"
              placeholder="Wall name…"
              value={newName}
              onChange={e => { setNewName(e.target.value); setNameError('') }}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
            />
            <div className="wm-dims-row">
              <label className="wm-dim-label">
                W"
                <input
                  type="number"
                  className="text-input num-input"
                  value={newWidth}
                  min={10} max={999}
                  onChange={e => setNewWidth(e.target.value)}
                />
              </label>
              <span className="wm-dim-sep">×</span>
              <label className="wm-dim-label">
                H"
                <input
                  type="number"
                  className="text-input num-input"
                  value={newHeight}
                  min={10} max={999}
                  onChange={e => setNewHeight(e.target.value)}
                />
              </label>
            </div>
            <button className="btn btn-primary" onClick={handleCreate}>+ Create</button>
          </div>
          {nameError && <span className="field-error">{nameError}</span>}
        </div>

        <div className="wm-footer">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
