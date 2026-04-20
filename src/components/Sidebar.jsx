import { useState, useRef, useEffect } from 'react'

export default function Sidebar({
  pieces, selectedId, onSelect, onDelete, onEdit, onBringForward, onSendBackward,
  snapToGrid, onSnapToggle, gridSize, onGridSizeChange,
  layouts, wallName, currentLayout, onSaveLayout, saveFlash = false, onLoadLayout, onDeleteLayout,
  onAddPiece, onClearAll,
  library = {}, onAddFromLibrary, onDeleteFromLibrary,
  isOpen = false, onRequestClose,
  forceSection = null,
}) {
  const [layoutName, setLayoutName] = useState('')
  const [saveError, setSaveError]   = useState('')
  const [section, setSection]       = useState('pieces') // 'pieces' | 'layouts' | 'library' | 'settings'

  // Allow external callers (e.g. tutorial) to force-switch the active tab
  useEffect(() => {
    if (forceSection) setSection(forceSection)
  }, [forceSection])

  const handleSave = () => {
    const name = layoutName.trim()
    if (!name) { setSaveError('Enter a layout name'); return }
    onSaveLayout(name)
    setLayoutName('')
    setSaveError('')
  }

  const selectedPiece = pieces.find(p => p.id === selectedId)

  return (
    <aside className={`sidebar${isOpen ? ' sidebar--open' : ''}`}>
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
          onClick={() => setSection('layouts')}
        >Layouts</button>
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
          >✕</button>
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
                  <span className="piece-row-dims">{piece.width}" × {piece.height}"</span>
                </div>
                <div className="piece-row-actions">
                  <button
                    className="icon-btn"
                    title="Edit"
                    onClick={(e) => { e.stopPropagation(); onEdit(piece) }}
                  >✏️</button>
                  <button
                    className="icon-btn"
                    title="Delete"
                    onClick={(e) => { e.stopPropagation(); onDelete(piece.id) }}
                  >🗑️</button>
                </div>
              </div>
            ))}
          </div>

          {/* Selected piece quick controls */}
          {selectedPiece && (
            <div className="selected-controls">
              <div className="selected-title">Selected: <strong>{selectedPiece.name}</strong></div>
              <div className="selected-dims">
                {selectedPiece.width}" × {selectedPiece.height}" at ({selectedPiece.x.toFixed(1)}", {selectedPiece.y.toFixed(1)}")
              </div>
              <div className="btn-row">
                <button className="btn btn-ghost btn-sm" onClick={() => onBringForward(selectedId)}>▲ Forward</button>
                <button className="btn btn-ghost btn-sm" onClick={() => onSendBackward(selectedId)}>▼ Back</button>
                <button className="btn btn-ghost btn-sm" onClick={() => onEdit(selectedPiece)}>✏️ Edit</button>
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
              🗑 Clear all
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
                      <span className="lib-dims">{piece.width}" × {piece.height}"</span>
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
                      >🗑️</button>
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
            <div className="layouts-wall-label">🏠 {wallName}</div>
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
                    💾 Overwrite
                  </button>
                )
              }
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
                    onClick={() => onLoadLayout(name)}
                  >Load</button>
                  <button
                    className="icon-btn"
                    onClick={() => {
                      if (window.confirm(`Delete layout "${name}"?`)) onDeleteLayout(name)
                    }}
                  >🗑️</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── SETTINGS tab ───────────────────────────── */}
      {section === 'settings' && (
        <div className="sidebar-section">
          <div className="sidebar-header">
            <span className="section-title">Settings</span>
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
                    value={gridSize}
                    min={1}
                    max={24}
                    onChange={e => onGridSizeChange(Number(e.target.value))}
                  />
                  <span className="unit">inches</span>
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
