import { useState, useEffect, useRef } from 'react'
import { inToCmInt, cmToIn, fmtDimPair } from '../utils/units'

const DEFAULT_W = 120
const DEFAULT_H = 96

export default function WallManager({
  walls,
  wallImages = {},
  allLayouts = {},
  rooms = {},
  activeWallId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onSetupWall,
  onClose,
  unitSystem = 'imperial',
  onUnitSystemChange,
}) {
  const [tab,       setTab]       = useState('walls') // 'walls' | 'rooms'
  const [newName,   setNewName]   = useState('')
  const [newWidth,  setNewWidth]  = useState(unitSystem === 'metric' ? inToCmInt(DEFAULT_W) : DEFAULT_W)
  const [newHeight, setNewHeight] = useState(unitSystem === 'metric' ? inToCmInt(DEFAULT_H) : DEFAULT_H)
  const [nameError, setNameError] = useState('')

  // Keep a ref of the last inch values so we can re-convert correctly on unit change
  const inchesRef = useRef({ w: DEFAULT_W, h: DEFAULT_H })

  useEffect(() => {
    if (unitSystem === 'metric') {
      setNewWidth(inToCmInt(inchesRef.current.w))
      setNewHeight(inToCmInt(inchesRef.current.h))
    } else {
      setNewWidth(inchesRef.current.w)
      setNewHeight(inchesRef.current.h)
    }
  }, [unitSystem])

  const handleWidthChange = (val) => {
    setNewWidth(val)
    const n = Number(val)
    if (!isNaN(n) && n > 0) inchesRef.current.w = unitSystem === 'metric' ? Math.round(cmToIn(n)) : n
  }

  const handleHeightChange = (val) => {
    setNewHeight(val)
    const n = Number(val)
    if (!isNaN(n) && n > 0) inchesRef.current.h = unitSystem === 'metric' ? Math.round(cmToIn(n)) : n
  }
  const [editingId, setEditingId] = useState(null)
  const [editName,  setEditName]  = useState('')

  const wallList = Object.values(walls).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))

  /* ── Create ─────────────────────────────────────────── */
  const handleCreate = () => {
    const name = newName.trim()
    if (!name) { setNameError('Enter a wall name'); return }
    const rawW = Math.max(10, Math.min(9999, Number(newWidth)  || DEFAULT_W))
    const rawH = Math.max(10, Math.min(9999, Number(newHeight) || DEFAULT_H))
    const w = unitSystem === 'metric' ? Math.round(cmToIn(rawW)) : rawW
    const h = unitSystem === 'metric' ? Math.round(cmToIn(rawH)) : rawH
    onCreate({ name, width: w, height: h })
    setNewName('')
    setNewWidth(unitSystem === 'metric' ? inToCmInt(DEFAULT_W) : DEFAULT_W)
    setNewHeight(unitSystem === 'metric' ? inToCmInt(DEFAULT_H) : DEFAULT_H)
    inchesRef.current = { w: DEFAULT_W, h: DEFAULT_H }
    setNameError('')
  }

  /* ── Rename ─────────────────────────────────────────── */
  const commitRename = (id) => {
    const name = editName.trim()
    if (name) onRename(id, name)
    setEditingId(null)
    setEditName('')
  }

  // Group room-linked walls by roomId
  const roomIds = [...new Set(
    Object.values(walls).filter(w => w.roomId).map(w => w.roomId)
  )]
  const standaloneWalls = wallList.filter(w => !w.roomId)

  return (
    <div className="wm-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="wm-modal">
        <div className="wm-header">
          <h2>My Walls</h2>
          <button className="icon-btn wm-close" onClick={onClose} aria-label="Close">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>

        {/* ── Tabs ──────────────────────────────────── */}
        <div className="wm-tabs">
          <button className={`wm-tab ${tab === 'walls' ? 'wm-tab--active' : ''}`} onClick={() => setTab('walls')}>
            All Walls
          </button>
          <button className={`wm-tab ${tab === 'rooms' ? 'wm-tab--active' : ''}`} onClick={() => setTab('rooms')}>
            Rooms
            {roomIds.length > 0 && <span className="wm-tab-badge">{roomIds.length}</span>}
          </button>
        </div>

        {/* ── Rooms tab ─────────────────────────────── */}
        {tab === 'rooms' && (
          <div className="wm-list">
            {roomIds.length === 0 && (
              <p className="wm-empty">No rooms yet. Build a space in the Space Builder to create one.</p>
            )}
            {roomIds.map(roomId => {
              const room = rooms[roomId]
              const roomWalls = wallList.filter(w => w.roomId === roomId)
              return (
                <div key={roomId} className="wm-room-section">
                  <div className="wm-room-header">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M1 12V5l6-4 6 4v7H9V8.5H5V12H1Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/>
                    </svg>
                    <span className="wm-room-name">{room?.name || 'Unnamed Room'}</span>
                    <span className="wm-room-count">{roomWalls.length} wall{roomWalls.length !== 1 ? 's' : ''}</span>
                  </div>
                  {roomWalls.map(wall => {
                    const isActive = wall.id === activeWallId
                    const layoutCount = Object.keys(allLayouts[wall.id] || {}).length
                    return (
                      <div key={wall.id} className={`wm-wall-row wm-wall-row--indented ${isActive ? 'wm-wall-row--active' : ''}`}>
                        <div className="wm-thumb">
                          {wallImages[wall.id]
                            ? <img src={wallImages[wall.id]} alt={wall.name} />
                            : <span className="wm-thumb-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="2" y="4" width="16" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/><circle cx="7" cy="8.5" r="1.5" stroke="currentColor" strokeWidth="1.25"/><path d="M2 13l4-3 3 3 3-3 4 3" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/></svg></span>
                          }
                        </div>
                        <div className="wm-wall-info">
                          <span className="wm-wall-name">
                            {wall.name}
                            {isActive && <span className="wm-active-badge">active</span>}
                          </span>
                          <span className="wm-wall-dims">{fmtDimPair(wall.width, wall.height, unitSystem)}</span>
                          <span className="wm-layout-count">
                            {layoutCount === 0 ? 'No saved layouts' : `${layoutCount} layout${layoutCount !== 1 ? 's' : ''}`}
                          </span>
                        </div>
                        <div className="wm-wall-actions">
                          {!isActive && (
                            <button className="btn btn-primary btn-sm" onClick={() => { onSelect(wall.id); onClose() }}>
                              Open
                            </button>
                          )}
                          <button className="btn btn-ghost btn-sm" title="Upload / recalibrate wall photo" onClick={() => { onSetupWall(wall.id); onClose() }}>
                            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" className="btn-icon"><rect x="1" y="4" width="11" height="7" rx="1" stroke="currentColor" strokeWidth="1.25"/><path d="M4.5 4V3a1.5 1.5 0 013 0v1" stroke="currentColor" strokeWidth="1.25"/><circle cx="6.5" cy="7.5" r="1.5" stroke="currentColor" strokeWidth="1.25"/></svg>
                            Recalibrate
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })}
            {standaloneWalls.length > 0 && roomIds.length > 0 && (
              <div className="wm-room-section">
                <div className="wm-room-header">
                  <span className="wm-room-name" style={{ color: 'var(--text-secondary)' }}>Standalone Walls</span>
                </div>
                {standaloneWalls.map(wall => {
                  const isActive = wall.id === activeWallId
                  return (
                    <div key={wall.id} className={`wm-wall-row wm-wall-row--indented ${isActive ? 'wm-wall-row--active' : ''}`}>
                      <div className="wm-thumb">
                        {wallImages[wall.id] ? <img src={wallImages[wall.id]} alt={wall.name} /> : <span className="wm-thumb-icon">🖼</span>}
                      </div>
                      <div className="wm-wall-info">
                        <span className="wm-wall-name">{wall.name}{isActive && <span className="wm-active-badge">active</span>}</span>
                        <span className="wm-wall-dims">{fmtDimPair(wall.width, wall.height, unitSystem)}</span>
                      </div>
                      <div className="wm-wall-actions">
                        {!isActive && <button className="btn btn-primary btn-sm" onClick={() => { onSelect(wall.id); onClose() }}>Open</button>}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ── All Walls tab ──────────────────────────── */}
        {tab === 'walls' && <div className="wm-list">
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
                  <span className="wm-wall-dims">{fmtDimPair(wall.width, wall.height, unitSystem)}</span>
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
        </div>}

        {/* ── Create new wall ────────────────────────── */}
        <div className="wm-create">
          <div className="wm-create-header">
            <h3 className="wm-create-title">New Wall</h3>
            {onUnitSystemChange && (
              <div className="unit-seg">
                <button
                  className={`unit-seg-btn ${unitSystem === 'imperial' ? 'active' : ''}`}
                  onClick={() => onUnitSystemChange('imperial')}
                  title="Inches"
                >in</button>
                <button
                  className={`unit-seg-btn ${unitSystem === 'metric' ? 'active' : ''}`}
                  onClick={() => onUnitSystemChange('metric')}
                  title="Centimetres"
                >cm</button>
              </div>
            )}
          </div>
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
                W{unitSystem === 'metric' ? 'cm' : '"'}
                <input
                  type="number"
                  className="text-input num-input"
                  value={newWidth}
                  min={10} max={unitSystem === 'metric' ? 2000 : 999}
                  onChange={e => handleWidthChange(e.target.value)}
                />
              </label>
              <span className="wm-dim-sep">×</span>
              <label className="wm-dim-label">
                H{unitSystem === 'metric' ? 'cm' : '"'}
                <input
                  type="number"
                  className="text-input num-input"
                  value={newHeight}
                  min={10} max={unitSystem === 'metric' ? 2000 : 999}
                  onChange={e => handleHeightChange(e.target.value)}
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
