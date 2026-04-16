import { useState, useCallback } from 'react'
import Wall from './components/Wall'
import Sidebar from './components/Sidebar'
import AddPieceModal from './components/AddPieceModal'
import WallSetup from './components/WallSetup'
import './App.css'

const WALL_IMG_KEY    = 'gwp-wall-image'   // localStorage key for corrected wall

const WALL_WIDTH = 128   // inches
const WALL_HEIGHT = 95   // inches

const genId = () => Math.random().toString(36).slice(2, 10)

const PALETTE = [
  '#8B7D6B', '#6B8E9F', '#9E8B6A', '#7B9E87',
  '#A08080', '#8B9E7B', '#7B8B9E', '#C4A882',
  '#9E9B7B', '#8B7B9E', '#7B9B8B', '#B5977A',
]

const loadLayouts = () => {
  try { return JSON.parse(localStorage.getItem('gwp-layouts') || '{}') }
  catch { return {} }
}

export default function App() {
  const [pieces, setPieces]               = useState([])
  const [selectedId, setSelectedId]       = useState(null)
  const [showAddModal, setShowAddModal]   = useState(false)
  const [editingPiece, setEditingPiece]   = useState(null)
  const [snapToGrid, setSnapToGrid]       = useState(false)
  const [gridSize, setGridSize]           = useState(4)
  const [layouts, setLayouts]             = useState(loadLayouts)
  const [currentLayout, setCurrentLayout] = useState('')
  const [colorIdx, setColorIdx]           = useState(0)
  const [showSetup, setShowSetup]         = useState(false)
  // Corrected wall image: load from localStorage if available
  const [wallImage, setWallImage]         = useState(() =>
    localStorage.getItem(WALL_IMG_KEY) || null
  )

  /* ── Piece operations ─────────────────────────────── */
  const addPiece = useCallback((data) => {
    const piece = {
      id: genId(),
      x: 8, y: 8,
      color: PALETTE[colorIdx % PALETTE.length],
      ...data,
    }
    setPieces(p => [...p, piece])
    setColorIdx(i => i + 1)
    setSelectedId(piece.id)
  }, [colorIdx])

  const updatePiece = useCallback((id, updates) =>
    setPieces(p => p.map(pc => pc.id === id ? { ...pc, ...updates } : pc)),
  [])

  const deletePiece = useCallback((id) => {
    setPieces(p => p.filter(pc => pc.id !== id))
    setSelectedId(s => s === id ? null : s)
  }, [])

  const bringForward = useCallback((id) => {
    setPieces(p => {
      const idx = p.findIndex(pc => pc.id === id)
      if (idx >= p.length - 1) return p
      const next = [...p]
      ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
      return next
    })
  }, [])

  const sendBackward = useCallback((id) => {
    setPieces(p => {
      const idx = p.findIndex(pc => pc.id === id)
      if (idx <= 0) return p
      const next = [...p]
      ;[next[idx], next[idx - 1]] = [next[idx - 1], next[idx]]
      return next
    })
  }, [])

  /* ── Snap helper ──────────────────────────────────── */
  const snap = useCallback((v) =>
    snapToGrid ? Math.round(v / gridSize) * gridSize : v,
  [snapToGrid, gridSize])

  /* ── Move / resize callbacks ──────────────────────── */
  const handleMove = useCallback((id, x, y) => {
    updatePiece(id, { x: snap(x), y: snap(y) })
  }, [updatePiece, snap])

  const handleResize = useCallback((id, w, h, x, y) => {
    updatePiece(id, {
      width:  Math.max(2, snap(w)),
      height: Math.max(2, snap(h)),
      x: snap(x),
      y: snap(y),
    })
  }, [updatePiece, snap])

  /* ── Layout operations ────────────────────────────── */
  const saveLayout = useCallback((name) => {
    const next = { ...layouts, [name]: pieces }
    setLayouts(next)
    localStorage.setItem('gwp-layouts', JSON.stringify(next))
    setCurrentLayout(name)
  }, [layouts, pieces])

  const loadLayout = useCallback((name) => {
    if (layouts[name]) {
      setPieces(layouts[name])
      setSelectedId(null)
      setCurrentLayout(name)
    }
  }, [layouts])

  const deleteLayout = useCallback((name) => {
    const next = { ...layouts }
    delete next[name]
    setLayouts(next)
    localStorage.setItem('gwp-layouts', JSON.stringify(next))
    if (currentLayout === name) setCurrentLayout('')
  }, [layouts, currentLayout])

  /* ── Wall calibration ────────────────────────────── */
  const handleWallCalibrated = useCallback((dataUrl) => {
    localStorage.setItem(WALL_IMG_KEY, dataUrl)
    setWallImage(dataUrl)
    setShowSetup(false)
  }, [])

  /* ── Modal helpers ────────────────────────────────── */
  const openEdit = useCallback((piece) => {
    setEditingPiece(piece)
    setShowAddModal(true)
  }, [])

  const closeModal = useCallback(() => {
    setEditingPiece(null)
    setShowAddModal(false)
  }, [])

  const handleModalSubmit = useCallback((data) => {
    if (editingPiece) {
      updatePiece(editingPiece.id, data)
    } else {
      addPiece(data)
    }
    closeModal()
  }, [editingPiece, updatePiece, addPiece, closeModal])

  /* ── Keyboard: delete selected ────────────────────── */
  const handleKeyDown = useCallback((e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') &&
        selectedId &&
        !['INPUT','TEXTAREA'].includes(e.target.tagName)) {
      deletePiece(selectedId)
    }
    if (e.key === 'Escape') setSelectedId(null)
  }, [selectedId, deletePiece])

  return (
    <div className="app" onKeyDown={handleKeyDown} tabIndex={-1}>
      <header className="app-header">
        <div className="header-brand">
          <span className="brand-icon">🖼️</span>
          <span className="brand-name">Gallery Wall Planner</span>
          <span className="wall-badge">{WALL_WIDTH}" × {WALL_HEIGHT}"</span>
        </div>
        <div className="header-actions">
          {currentLayout && (
            <span className="layout-chip">📐 {currentLayout}</span>
          )}
          <button
            className={`btn btn-ghost btn-sm ${!wallImage ? 'btn-calibrate-pulse' : ''}`}
            onClick={() => setShowSetup(true)}
            title={wallImage ? 'Re-calibrate wall perspective' : 'Calibrate wall perspective'}
          >
            {wallImage ? '⚙ Recalibrate' : '📐 Calibrate Wall'}
          </button>
          <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            + Add Piece
          </button>
        </div>
      </header>

      <div className="app-body">
        <Sidebar
          pieces={pieces}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onDelete={deletePiece}
          onEdit={openEdit}
          onBringForward={bringForward}
          onSendBackward={sendBackward}
          snapToGrid={snapToGrid}
          onSnapToggle={() => setSnapToGrid(s => !s)}
          gridSize={gridSize}
          onGridSizeChange={setGridSize}
          layouts={layouts}
          currentLayout={currentLayout}
          onSaveLayout={saveLayout}
          onLoadLayout={loadLayout}
          onDeleteLayout={deleteLayout}
          onAddPiece={() => setShowAddModal(true)}
          onClearAll={() => { setPieces([]); setSelectedId(null) }}
        />

        <Wall
          pieces={pieces}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onMove={handleMove}
          onResize={handleResize}
          onDeselect={() => setSelectedId(null)}
          snapToGrid={snapToGrid}
          gridSize={gridSize}
          wallWidth={WALL_WIDTH}
          wallHeight={WALL_HEIGHT}
          wallImage={wallImage}
          onCalibrate={() => setShowSetup(true)}
        />
      </div>

      {showSetup && (
        <WallSetup
          onApply={handleWallCalibrated}
          onClose={() => setShowSetup(false)}
          existingDataUrl={wallImage}
        />
      )}

      {showAddModal && (
        <AddPieceModal
          piece={editingPiece}
          onSubmit={handleModalSubmit}
          onClose={closeModal}
        />
      )}
    </div>
  )
}
