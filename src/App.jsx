import { useState, useCallback } from 'react'
import Wall from './components/Wall'
import Sidebar from './components/Sidebar'
import AddPieceModal from './components/AddPieceModal'
import WallSetup from './components/WallSetup'
import WallManager from './components/WallManager'
import './App.css'

/* ── Storage keys ─────────────────────────────────────── */
const WALLS_KEY       = 'gwp-walls'         // { [id]: { id, name, image, width, height, createdAt } }
const ACTIVE_WALL_KEY = 'gwp-active-wall'   // string wallId
const LAYOUTS_KEY     = 'gwp-layouts'       // { [wallId]: { [layoutName]: pieces[] } }

const genId = () => Math.random().toString(36).slice(2, 10)

const PALETTE = [
  '#8B7D6B', '#6B8E9F', '#9E8B6A', '#7B9E87',
  '#A08080', '#8B9E7B', '#7B8B9E', '#C4A882',
  '#9E9B7B', '#8B7B9E', '#7B9B8B', '#B5977A',
]

/* ── Load / migrate walls ─────────────────────────────── */
function loadWalls() {
  try {
    const saved = JSON.parse(localStorage.getItem(WALLS_KEY) || 'null')
    if (saved && Object.keys(saved).length) return saved
  } catch {}
  // Migrate from old single-wall storage
  const id = genId()
  const legacyImage = localStorage.getItem('gwp-wall-image') || null
  return {
    [id]: { id, name: 'My Wall', image: legacyImage, width: 128, height: 95, createdAt: Date.now() }
  }
}

function loadActiveWallId(walls) {
  const saved = localStorage.getItem(ACTIVE_WALL_KEY)
  if (saved && walls[saved]) return saved
  return Object.keys(walls)[0]
}

/* ── Load / migrate layouts ───────────────────────────── */
function loadAllLayouts(walls) {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUTS_KEY) || 'null')
    if (!raw) return {}
    // Detect old flat format: values are arrays (of pieces), not objects
    const isFlat = Object.values(raw).some(v => Array.isArray(v))
    if (isFlat) {
      // Migrate: put all flat layouts under the first wall
      const firstId = Object.keys(walls)[0]
      return { [firstId]: raw }
    }
    return raw
  } catch { return {} }
}

export default function App() {
  const [walls,          setWalls]          = useState(loadWalls)
  const [activeWallId,   setActiveWallId]   = useState(() => loadActiveWallId(loadWalls()))
  const [allLayouts,     setAllLayouts]     = useState(() => loadAllLayouts(loadWalls()))
  const [pieces,         setPieces]         = useState([])
  const [selectedId,     setSelectedId]     = useState(null)
  const [showAddModal,   setShowAddModal]   = useState(false)
  const [editingPiece,   setEditingPiece]   = useState(null)
  const [snapToGrid,     setSnapToGrid]     = useState(false)
  const [gridSize,       setGridSize]       = useState(4)
  const [currentLayout,  setCurrentLayout]  = useState('')
  const [colorIdx,       setColorIdx]       = useState(0)
  const [showSetup,      setShowSetup]      = useState(false)
  const [setupWallId,    setSetupWallId]    = useState(null)  // which wall to calibrate
  const [showWallMgr,    setShowWallMgr]    = useState(false)

  /* ── Derived ──────────────────────────────────────── */
  const activeWall   = walls[activeWallId] || Object.values(walls)[0]
  const wallLayouts  = allLayouts[activeWallId] || {}

  /* ── Persist helpers ──────────────────────────────── */
  const persistWalls = (next) => localStorage.setItem(WALLS_KEY, JSON.stringify(next))
  const persistLayouts = (next) => localStorage.setItem(LAYOUTS_KEY, JSON.stringify(next))

  /* ── Wall manager operations ──────────────────────── */
  const handleSelectWall = useCallback((id) => {
    setActiveWallId(id)
    localStorage.setItem(ACTIVE_WALL_KEY, id)
    setPieces([])
    setSelectedId(null)
    setCurrentLayout('')
  }, [])

  const handleCreateWall = useCallback(({ name, width, height }) => {
    const id = genId()
    const wall = { id, name, image: null, width, height, createdAt: Date.now() }
    setWalls(prev => {
      const next = { ...prev, [id]: wall }
      persistWalls(next)
      return next
    })
    handleSelectWall(id)
  }, [handleSelectWall])

  const handleDeleteWall = useCallback((id) => {
    setWalls(prev => {
      const next = { ...prev }
      delete next[id]
      persistWalls(next)
      return next
    })
    setAllLayouts(prev => {
      const next = { ...prev }
      delete next[id]
      persistLayouts(next)
      return next
    })
    if (activeWallId === id) {
      const remaining = Object.keys(walls).filter(k => k !== id)
      const newId = remaining[0]
      if (newId) handleSelectWall(newId)
    }
  }, [walls, activeWallId, handleSelectWall])

  const handleRenameWall = useCallback((id, name) => {
    setWalls(prev => {
      const next = { ...prev, [id]: { ...prev[id], name } }
      persistWalls(next)
      return next
    })
  }, [])

  /* ── Wall calibration ─────────────────────────────── */
  const handleWallCalibrated = useCallback((dataUrl) => {
    const id = setupWallId || activeWallId
    setWalls(prev => {
      const next = { ...prev, [id]: { ...prev[id], image: dataUrl } }
      persistWalls(next)
      return next
    })
    setShowSetup(false)
    setSetupWallId(null)
  }, [setupWallId, activeWallId])

  const openSetup = useCallback((wallId = null) => {
    setSetupWallId(wallId || activeWallId)
    setShowSetup(true)
  }, [activeWallId])

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

  /* ── Layout operations (scoped to active wall) ────── */
  const saveLayout = useCallback((name) => {
    setAllLayouts(prev => {
      const wallPrev = prev[activeWallId] || {}
      const next = { ...prev, [activeWallId]: { ...wallPrev, [name]: pieces } }
      persistLayouts(next)
      return next
    })
    setCurrentLayout(name)
  }, [activeWallId, pieces])

  const loadLayout = useCallback((name) => {
    const layout = wallLayouts[name]
    if (layout) {
      setPieces(layout)
      setSelectedId(null)
      setCurrentLayout(name)
    }
  }, [wallLayouts])

  const deleteLayout = useCallback((name) => {
    setAllLayouts(prev => {
      const wallPrev = { ...(prev[activeWallId] || {}) }
      delete wallPrev[name]
      const next = { ...prev, [activeWallId]: wallPrev }
      persistLayouts(next)
      return next
    })
    if (currentLayout === name) setCurrentLayout('')
  }, [activeWallId, currentLayout])

  /* ── Modal helpers ──────────────────────────────────── */
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

  /* ── Render ───────────────────────────────────────── */
  const calibWall = walls[setupWallId] || activeWall

  return (
    <div className="app" onKeyDown={handleKeyDown} tabIndex={-1}>
      <header className="app-header">
        <div className="header-brand">
          <span className="brand-icon">🖼️</span>
          <span className="brand-name">Gallery Wall Planner</span>
          <button
            className="wall-badge wall-badge--btn"
            onClick={() => setShowWallMgr(true)}
            title="Manage walls"
          >
            🏠 {activeWall?.name || 'My Wall'}
            <span className="wall-badge-dims">{activeWall?.width}" × {activeWall?.height}"</span>
          </button>
        </div>
        <div className="header-actions">
          {currentLayout && (
            <span className="layout-chip">📐 {currentLayout}</span>
          )}
          <button
            className={`btn btn-ghost btn-sm ${!activeWall?.image ? 'btn-calibrate-pulse' : ''}`}
            onClick={() => openSetup()}
            title={activeWall?.image ? 'Re-calibrate wall perspective' : 'Calibrate wall perspective'}
          >
            {activeWall?.image ? '⚙ Recalibrate' : '📐 Calibrate Wall'}
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
          layouts={wallLayouts}
          wallName={activeWall?.name}
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
          wallWidth={activeWall?.width || 128}
          wallHeight={activeWall?.height || 95}
          wallImage={activeWall?.image || null}
          onCalibrate={() => openSetup()}
        />
      </div>

      {showSetup && (
        <WallSetup
          onApply={handleWallCalibrated}
          onClose={() => { setShowSetup(false); setSetupWallId(null) }}
          wallName={calibWall?.name || 'Wall'}
        />
      )}

      {showWallMgr && (
        <WallManager
          walls={walls}
          activeWallId={activeWallId}
          onSelect={handleSelectWall}
          onCreate={handleCreateWall}
          onDelete={handleDeleteWall}
          onRename={handleRenameWall}
          onSetupWall={(id) => openSetup(id)}
          onClose={() => setShowWallMgr(false)}
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
