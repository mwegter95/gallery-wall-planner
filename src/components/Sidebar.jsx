import { useState, useEffect, useRef, useCallback } from 'react'
import { fmtDimPair, displayGridSize, inputGridSize } from '../utils/units'

export default function Sidebar({
  pieces, selectedId, onSelect, onDelete, onEdit, onBringForward, onSendBackward,
  snapToGrid, onSnapToggle, gridSize, onGridSizeChange,
  unitSystem = 'imperial', onUnitSystemChange,
  layouts, wallName, currentLayout, onSaveLayout, saveFlash = false, onLoadLayout, onDeleteLayout,
  onAddPiece, onClearAll,
  library = {}, onAddFromLibrary, onDeleteFromLibrary,
  isOpen = false, onRequestClose,
  forceSection = null,
  hasUnsavedChanges = false, onDiscardChanges,
  paintLayers = [], onTogglePaintLayer, onDeletePaintLayer, onRenamePaintLayer,
  onEditPaintLayer, onNewPaintLayer, hasWallImage = false,
  eraseHistory = [], onRemoveErase, onOpenErase, onToggleEraseVisible,
}) {
  const [layoutName,     setLayoutName]     = useState('')
  const [saveError,      setSaveError]      = useState('')
  const [section,        setSection]        = useState('pieces') // 'pieces' | 'layouts' | 'library' | 'paint' | 'erase' | 'settings'
  const [renamingLayer,  setRenamingLayer]  = useState(null)   // layerId being renamed
  const [renameValue,    setRenameValue]    = useState('')
  const [confirmEraseId, setConfirmEraseId] = useState(null)   // entry.id pending delete confirm

  // Preserve scroll position across re-renders triggered by parent state changes
  // (e.g. loading a layout updates pieces, which re-renders Sidebar and can reset scroll)
  const asideRef        = useRef(null)
  const savedScrollRef  = useRef(0)

  const handleLoadLayout = useCallback((name) => {
    // Snapshot the current scroll position of the sidebar container
    if (asideRef.current) savedScrollRef.current = asideRef.current.scrollTop
    onLoadLayout(name)
    // Restore after React has flushed its DOM updates
    requestAnimationFrame(() => {
      if (asideRef.current) asideRef.current.scrollTop = savedScrollRef.current
    })
  }, [onLoadLayout])

  // Allow external callers (e.g. tutorial) to force-switch the active tab
  useEffect(() => {
    if (forceSection) setSection(forceSection)
  }, [forceSection])

  // Preload all library thumbnail images so the Library tab paints instantly
  useEffect(() => {
    Object.values(library).forEach(p => { if (p.image) { new Image().src = p.image } })
  }, [library])

  const handleSave = () => {
    const name = layoutName.trim()
    if (!name) { setSaveError('Enter a layout name'); return }
    onSaveLayout(name)
    setLayoutName('')
    setSaveError('')
  }

  const selectedPiece = pieces.find(p => p.id === selectedId)

  return (
    <aside ref={asideRef} className={`sidebar${isOpen ? ' sidebar--open' : ''}`}>
      {/* Top tabs */}
      <div className="sidebar-tabs" data-tutorial="sidebar-tabs">
        <button
          className={`tab-btn ${section === 'pieces' ? 'active' : ''}`}
          onClick={() => setSection('pieces')}
        >Pieces</button>
        <button
          className={`tab-btn ${section === 'library' ? 'active' : ''}`}
          onClick={() => setSection('library')}
        >Library{Object.keys(library).length > 0 && <span className="count-badge">{Object.keys(library).length}</span>}</button>
        <button
          className={`tab-btn ${section === 'layouts' ? 'active' : ''}`}
          data-tutorial="layouts-tab"
          onClick={() => setSection('layouts')}
        >Layouts</button>
        <button
          className={`tab-btn ${section === 'paint' ? 'active' : ''}`}
          onClick={() => setSection('paint')}
        >
          Paint
          {paintLayers.some(l => l.visible) && <span className="paint-active-dot" />}
        </button>
        <button
          className={`tab-btn ${section === 'erase' ? 'active' : ''}`}
          onClick={() => setSection('erase')}
        >
          Erase
          {eraseHistory.length > 0 && <span className="count-badge">{eraseHistory.length}</span>}
        </button>
        <button
          className={`tab-btn ${section === 'settings' ? 'active' : ''}`}
          data-tutorial="settings-tab"
          onClick={() => setSection('settings')}
        >Settings</button>
        {onRequestClose && (
          <button
            className="tab-btn sidebar-close-btn"
            onClick={onRequestClose}
            aria-label="Close sidebar"
            title="Close"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        )}
      </div>

      {/* ── PIECES tab ─────────────────────────────── */}
      {section === 'pieces' && (
        <div className="sidebar-section">
          <div className="sidebar-header">
            <span className="section-title">Pieces <span className="count-badge">{pieces.length}</span></span>
            <button className="btn btn-primary btn-sm" onClick={onAddPiece}>+ Add</button>
          </div>

          {pieces.length === 0 && (
            <div className="empty-state">
              <p>No pieces yet.</p>
              <p>Add your first gallery piece to get started.</p>
            </div>
          )}

          <div className="piece-list">
            {[...pieces].reverse().map(piece => (
              <div
                key={piece.id}
                className={`piece-row ${piece.id === selectedId ? 'active' : ''}`}
                onClick={() => onSelect(piece.id)}
              >
                <div
                  className="piece-swatch"
                  style={{
                    backgroundColor: piece.color,
                    backgroundImage: piece.image ? `url(${piece.image})` : undefined,
                    backgroundSize: 'cover',
                  }}
                />
                <div className="piece-info">
                  <span className="piece-row-name">{piece.name}</span>
                  <span className="piece-row-dims">{fmtDimPair(piece.width, piece.height, unitSystem)}</span>
                </div>
                <div className="piece-row-actions">
                  <button
                    className="icon-btn"
                    title="Edit"
                    onClick={(e) => { e.stopPropagation(); onEdit(piece) }}
                  ><svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 2.5l1.5 1.5-7 7H2v-1.5l7-7z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/><path d="M8 3.5l1.5 1.5" stroke="currentColor" strokeWidth="1.25"/></svg></button>
                  <button
                    className="icon-btn"
                    title="Delete"
                    onClick={(e) => { e.stopPropagation(); onDelete(piece.id) }}
                  ><svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 3.5h9M5 3.5V2.5h3v1M5.5 5.5v4M7.5 5.5v4M3 3.5l.5 7h6l.5-7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
                </div>
              </div>
            ))}
          </div>

          {/* Selected piece quick controls */}
          {selectedPiece && (
            <div className="selected-controls">
              <div className="selected-title">Selected: <strong>{selectedPiece.name}</strong></div>
              <div className="selected-dims">
                {fmtDimPair(selectedPiece.width, selectedPiece.height, unitSystem)}
              </div>
              <div className="btn-row">
                <button className="btn btn-ghost btn-sm" onClick={() => onBringForward(selectedId)}>▲ Forward</button>
                <button className="btn btn-ghost btn-sm" onClick={() => onSendBackward(selectedId)}>▼ Back</button>
                <button className="btn btn-ghost btn-sm" onClick={() => onEdit(selectedPiece)}>
                  <svg width="12" height="12" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg" className="btn-icon"><path d="M9 2.5l1.5 1.5-7 7H2v-1.5l7-7z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/><path d="M8 3.5l1.5 1.5" stroke="currentColor" strokeWidth="1.25"/></svg>
                  {' '}Edit
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => onDelete(selectedId)}>Delete</button>
              </div>
            </div>
          )}

          {pieces.length > 0 && (
            <button
              className="btn btn-ghost btn-sm clear-btn"
              onClick={() => {
                if (window.confirm('Clear all pieces from the wall?')) onClearAll()
              }}
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg" className="btn-icon"><path d="M2 3.5h9M5 3.5V2.5h3v1M5.5 5.5v4M7.5 5.5v4M3 3.5l.5 7h6l.5-7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Clear all
            </button>
          )}
        </div>
      )}

      {/* ── LIBRARY tab ─────────────────────────── */}
      {section === 'library' && (
        <div className="sidebar-section">
          <div className="sidebar-header">
            <span className="section-title">Piece Library <span className="count-badge">{Object.keys(library).length}</span></span>
          </div>
          <p className="lib-hint">All pieces are saved here automatically. Click "+ Add" to place one on the current wall.</p>

          {Object.keys(library).length === 0 ? (
            <div className="empty-state">
              <p>Library is empty.</p>
              <p>Add a piece to the wall and it will appear here.</p>
            </div>
          ) : (
            <div className="lib-grid">
              {Object.values(library)
                .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
                .map(piece => (
                  <div key={piece.id} className="lib-card">
                    <div
                      className="lib-thumb"
                      style={{
                        backgroundColor: piece.color,
                        backgroundImage: piece.image ? `url(${piece.image})` : undefined,
                        backgroundSize: piece.transparent ? 'contain' : 'cover',
                        backgroundRepeat: 'no-repeat',
                        backgroundPosition: 'center',
                      }}
                    />
                    <div className="lib-info">
                      <span className="lib-name" title={piece.name}>{piece.name}</span>
                      <span className="lib-dims">{fmtDimPair(piece.width, piece.height, unitSystem)}</span>
                    </div>
                    <div className="lib-actions">
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => { onAddFromLibrary(piece); onRequestClose?.() }}
                        title="Place on current wall"
                      >+ Add</button>
                      <button
                        className="icon-btn"
                        onClick={() => {
                          if (window.confirm(`Remove "${piece.name}" from library?`)) onDeleteFromLibrary(piece.id)
                        }}
                        title="Remove from library"
                      ><svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 3.5h9M5 3.5V2.5h3v1M5.5 5.5v4M7.5 5.5v4M3 3.5l.5 7h6l.5-7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
                    </div>
                  </div>
                ))
              }
            </div>
          )}
        </div>
      )}

      {/* ── LAYOUTS tab ─────────────────────────── */}
      {section === 'layouts' && (
        <div className="sidebar-section">
          <div className="sidebar-header">
            <span className="section-title">Saved Layouts</span>
          </div>
          {wallName && (
            <div className="layouts-wall-label">{wallName}</div>
          )}

          {/* Overwrite current layout */}
          {currentLayout && (
            <div className="layout-current-banner">
              <span className="layout-current-name">✓ {currentLayout}</span>
              {saveFlash
                ? <span className="layout-saved-flash">✓ Saved!</span>
                : (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => onSaveLayout(currentLayout)}
                    title="Save current arrangement into this layout"
                  >
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" className="btn-icon"><path d="M1.5,1.5 H9 L12.5,5 V12.5 H1.5 Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/><rect x="3.5" y="1.5" width="4" height="3" rx="0.5" stroke="currentColor" strokeWidth="1"/><rect x="2.5" y="8" width="9" height="3.5" rx="0.5" stroke="currentColor" strokeWidth="1"/></svg>
                    Overwrite
                  </button>
                )
              }
            </div>
          )}

          {hasUnsavedChanges && (
            <div className="layout-discard-row">
              <span className="layout-discard-label">
                {currentLayout ? 'Unsaved changes' : 'Unsaved canvas'}
              </span>
              <button
                className="btn btn-ghost btn-sm layout-discard-btn"
                onClick={onDiscardChanges}
                title={currentLayout ? `Revert to last saved "${currentLayout}"` : 'Clear unsaved pieces from canvas'}
              >
                ↺ Discard
              </button>
            </div>
          )}

          {/* Save as new */}
          <div className="layout-save-as">
            <span className="layout-save-as-label">Save as new…</span>
          <div className="layout-save">
            <input
              className="text-input"
              placeholder="Layout name…"
              value={layoutName}
              onChange={e => { setLayoutName(e.target.value); setSaveError('') }}
              onKeyDown={e => e.key === 'Enter' && handleSave()}
            />
            {saveFlash
              ? <span className="layout-saved-flash">✓ Saved!</span>
              : <button className="btn btn-primary btn-sm" onClick={handleSave}>Save</button>
            }
            {saveError && <span className="field-error">{saveError}</span>}
          </div>
          </div>

          {Object.keys(layouts).length === 0 && (
            <div className="empty-state">
              <p>No saved layouts.</p>
              <p>Arrange your wall and save it with a name.</p>
            </div>
          )}

          <div className="layout-list">
            {Object.keys(layouts).map(name => (
              <div
                key={name}
                className={`layout-row ${currentLayout === name ? 'active' : ''}`}
              >
                <div className="layout-info">
                  <span className="layout-name">{name}</span>
                  <span className="layout-meta">{layouts[name].length} pieces</span>
                </div>
                <div className="layout-actions">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => handleLoadLayout(name)}
                  >Load</button>
                  <button
                    className="icon-btn"
                    title="Delete layout"
                    onClick={() => {
                      if (window.confirm(`Delete layout "${name}"?`)) onDeleteLayout(name)
                    }}
                  ><svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 3.5h9M5 3.5V2.5h3v1M5.5 5.5v4M7.5 5.5v4M3 3.5l.5 7h6l.5-7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── PAINT tab ──────────────────────────────── */}
      {section === 'paint' && (
        <div className="sidebar-section">
          <div className="sidebar-header">
            <span className="section-title">Paint Layers <span className="count-badge">{paintLayers.length}</span></span>
            <button
              className="btn btn-primary btn-sm"
              onClick={onNewPaintLayer}
              disabled={!hasWallImage}
              title={hasWallImage ? 'Add a new paint layer' : 'Calibrate your wall first'}
            >+ New</button>
          </div>

          {!hasWallImage && (
            <div className="empty-state">
              <p>Calibrate your wall first to enable paint layers.</p>
            </div>
          )}

          {hasWallImage && paintLayers.length === 0 && (
            <div className="empty-state">
              <p>No paint layers yet.</p>
              <p>Click <strong>+ New</strong> to try a wall color.</p>
            </div>
          )}

          <div className="paint-layer-list">
            {paintLayers.map(layer => (
              <div key={layer.id} className={`paint-layer-row ${layer.visible ? 'active' : ''}`}>
                {/* Color swatch */}
                <div
                  className="paint-layer-swatch"
                  style={{ background: layer.color }}
                  onClick={() => onTogglePaintLayer?.(layer.id)}
                  title={layer.visible ? 'Click to hide' : 'Click to show'}
                />

                {/* Name / inline rename */}
                <div className="paint-layer-info">
                  {renamingLayer === layer.id ? (
                    <input
                      autoFocus
                      className="text-input paint-layer-rename"
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onBlur={() => {
                        if (renameValue.trim()) onRenamePaintLayer?.(layer.id, renameValue.trim())
                        setRenamingLayer(null)
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          if (renameValue.trim()) onRenamePaintLayer?.(layer.id, renameValue.trim())
                          setRenamingLayer(null)
                        }
                        if (e.key === 'Escape') setRenamingLayer(null)
                      }}
                    />
                  ) : (
                    <span
                      className="paint-layer-name"
                      onDoubleClick={() => { setRenamingLayer(layer.id); setRenameValue(layer.name) }}
                      title="Double-click to rename"
                    >{layer.name}</span>
                  )}
                  <span className="paint-layer-hex">{layer.color}</span>
                </div>

                {/* Visibility toggle */}
                <button
                  className={`icon-btn ${layer.visible ? 'active' : ''}`}
                  title={layer.visible ? 'Hide layer' : 'Show layer'}
                  onClick={() => onTogglePaintLayer?.(layer.id)}
                >
                  {layer.visible ? (
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 6.5C2.5 3.5 4 2 6.5 2S10.5 3.5 12 6.5C10.5 9.5 9 11 6.5 11S2.5 9.5 1 6.5z" stroke="currentColor" strokeWidth="1.25"/><circle cx="6.5" cy="6.5" r="1.5" stroke="currentColor" strokeWidth="1.25"/></svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 2l9 9M5 3.5A5.5 5.5 0 0112 6.5c-.5 1-1.2 2-2 2.7M1 6.5c.5-1 1.2-2 2-2.7M7.5 9.8A4.5 4.5 0 011 6.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/></svg>
                  )}
                </button>

                {/* Edit */}
                <button
                  className="icon-btn"
                  title="Edit this paint layer"
                  onClick={() => onEditPaintLayer?.(layer.id)}
                >
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 2.5l1.5 1.5-7 7H2v-1.5l7-7z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/><path d="M8 3.5l1.5 1.5" stroke="currentColor" strokeWidth="1.25"/></svg>
                </button>

                {/* Delete */}
                <button
                  className="icon-btn"
                  title="Delete layer"
                  onClick={() => {
                    if (window.confirm(`Delete layer "${layer.name}"?`)) onDeletePaintLayer?.(layer.id)
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 3.5h9M5 3.5V2.5h3v1M5.5 5.5v4M7.5 5.5v4M3 3.5l.5 7h6l.5-7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── ERASE tab ──────────────────────────────── */}
      {section === 'erase' && (
        <div className="sidebar-section">
          <div className="sidebar-header">
            <span className="section-title">Erase History</span>
            <button
              className="add-piece-btn"
              onClick={onOpenErase}
              disabled={!hasWallImage}
              title={hasWallImage ? 'Erase an object from this wall' : 'Add a photo to this wall first'}
            >
              + New Erase
            </button>
          </div>

          {eraseHistory.length === 0 ? (
            <div className="paint-empty-state">
              <p>No erases yet.</p>
              <p style={{ marginTop: 6, fontSize: 11 }}>
                Use <strong>Erase Object</strong> in the header to remove objects from the wall photo using content-aware fill. Each erase is saved here and can be hidden or removed.
              </p>
            </div>
          ) : (
            <div className="paint-layer-list">
              {eraseHistory.map((entry, idx) => {
                const isActive = idx === eraseHistory.length - 1 && entry.visible !== false
                return (
                  <div key={entry.id} className={`paint-layer-row${entry.visible === false ? ' erase-row--hidden' : ''}`}>
                    {/* Thumbnail */}
                    <div className="erase-hist-thumb">
                      <img
                        src={entry.dataUrl}
                        alt={`Erase ${idx + 1}`}
                        style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 3,
                          opacity: entry.visible === false ? 0.35 : 1 }}
                      />
                    </div>
                    <div className="paint-layer-meta">
                      <span className="paint-layer-name">
                        Erase {idx + 1}
                        {isActive && (
                          <span className="erase-active-badge">ACTIVE</span>
                        )}
                      </span>
                      <span className="paint-layer-date">
                        {entry.createdAt
                          ? new Date(entry.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                          : 'Imported'}
                      </span>
                    </div>
                    {/* Visibility toggle */}
                    <button
                      className="icon-btn"
                      title={entry.visible === false ? 'Show this erase' : 'Hide this erase'}
                      onClick={() => onToggleEraseVisible?.(entry.id)}
                    >
                      {entry.visible === false ? (
                        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M1 1l11 11M5.3 3.7A4.5 4.5 0 0 1 6.5 3.5c3 0 5 3 5 3s-.8 1.3-2.1 2.2M3.5 4.8C2.2 5.7 1.5 6.5 1.5 6.5s2 3 5 3c.8 0 1.5-.2 2.2-.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M1.5 6.5s2-3 5-3 5 3 5 3-2 3-5 3-5-3-5-3z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><circle cx="6.5" cy="6.5" r="1.5" stroke="currentColor" strokeWidth="1.2"/></svg>
                      )}
                    </button>
                    {/* Delete */}
                    <button
                      className="icon-btn icon-btn--danger"
                      title="Remove this erase"
                      onClick={() => setConfirmEraseId(entry.id)}
                    >
                      <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                        <path d="M2 3.5h9M5 3.5V2.5h3v1M5.5 5.5v4M7.5 5.5v4M3 3.5l.5 7h6l.5-7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {/* Custom confirm modal */}
          {confirmEraseId && (
            <div className="erase-confirm-backdrop" onClick={() => setConfirmEraseId(null)}>
              <div className="erase-confirm-modal" onClick={e => e.stopPropagation()}>
                <div className="erase-confirm-icon">
                  <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                    <circle cx="14" cy="14" r="13" stroke="#f87171" strokeWidth="1.5"/>
                    <path d="M14 8v7M14 18v1.5" stroke="#f87171" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </div>
                <div className="erase-confirm-title">Remove this erase?</div>
                <div className="erase-confirm-body">
                  The wall will revert to the state before this erase was applied. This cannot be undone.
                </div>
                <div className="erase-confirm-actions">
                  <button className="erase-confirm-btn erase-confirm-btn--cancel" onClick={() => setConfirmEraseId(null)}>
                    Cancel
                  </button>
                  <button className="erase-confirm-btn erase-confirm-btn--delete" onClick={() => {
                    onRemoveErase?.(confirmEraseId)
                    setConfirmEraseId(null)
                  }}>
                    Remove Erase
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── SETTINGS tab ───────────────────────────── */}
      {section === 'settings' && (
        <div className="sidebar-section">
          <div className="sidebar-header">
            <span className="section-title">Settings</span>
          </div>

          <div className="setting-group">
            <div className="setting-row">
              <label className="setting-label">Measurement Units</label>
              <div className="unit-seg">
                <button
                  className={`unit-seg-btn ${unitSystem === 'imperial' ? 'active' : ''}`}
                  onClick={() => onUnitSystemChange?.('imperial')}
                  title="Inches / feet"
                >in</button>
                <button
                  className={`unit-seg-btn ${unitSystem === 'metric' ? 'active' : ''}`}
                  onClick={() => onUnitSystemChange?.('metric')}
                  title="Centimetres / metres"
                >cm</button>
              </div>
            </div>
          </div>

          <div className="setting-group" data-tutorial="snap-setting">
            <div className="setting-row">
              <label className="setting-label">Snap to Grid</label>
              <button
                className={`toggle-btn ${snapToGrid ? 'on' : ''}`}
                onClick={onSnapToggle}
              >
                {snapToGrid ? 'ON' : 'OFF'}
              </button>
            </div>
            {snapToGrid && (
              <div className="setting-row">
                <label className="setting-label">Grid Size</label>
                <div className="number-input-row">
                  <input
                    type="number"
                    className="text-input num-input"
                    value={displayGridSize(gridSize, unitSystem)}
                    min={unitSystem === 'metric' ? 2 : 1}
                    max={unitSystem === 'metric' ? 60 : 24}
                    onChange={e => onGridSizeChange(inputGridSize(Number(e.target.value), unitSystem))}
                  />
                  <span className="unit">{unitSystem === 'metric' ? 'cm' : 'inches'}</span>
                </div>
              </div>
            )}
          </div>

          <div className="setting-group">
            <div className="setting-label bold">Keyboard Shortcuts</div>
            <div className="shortcut-list">
              <div className="shortcut"><kbd>Delete</kbd><span>Remove selected piece</span></div>
              <div className="shortcut"><kbd>Esc</kbd><span>Deselect</span></div>
            </div>
          </div>

          <div className="setting-group">
            <div className="setting-label bold">Tips</div>
            <ul className="tips-list">
              <li>Drag pieces freely on the wall</li>
              <li>Upload a photo for each piece</li>
              <li>Save layouts to compare arrangements</li>
            </ul>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="sidebar-footer">
        Piece library: {Object.keys(library).length} saved
      </div>
    </aside>
  )
}
