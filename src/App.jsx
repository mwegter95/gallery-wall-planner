import { useState, useCallback, useEffect, useRef } from 'react'
import Wall from './components/Wall'
import Sidebar from './components/Sidebar'
import AddPieceModal from './components/AddPieceModal'
import WallSetup from './components/WallSetup'
import WallManager from './components/WallManager'
import AuthModal, { UserBadge } from './components/AuthModal'
import * as api from './utils/api'
import './App.css'

/* ── Only tiny UI preference stays in localStorage ─────── */
const ACTIVE_WALL_KEY    = 'gwp-active-wall'
const LOCAL_SNAPSHOT_KEY = 'gwp-local-snapshot'

const genId = () => Math.random().toString(36).slice(2, 10)

const PALETTE = [
  '#8B7D6B', '#6B8E9F', '#9E8B6A', '#7B9E87',
  '#A08080', '#8B9E7B', '#7B8B9E', '#C4A882',
  '#9E9B7B', '#8B7B9E', '#7B9B8B', '#B5977A',
]

export default function App() {
  /* ── Core state ──────────────────────────────────────── */
  const [isLoading,      setIsLoading]      = useState(true)
  const [walls,          setWalls]          = useState({})
  const [activeWallId,   setActiveWallId]   = useState(null)
  const [allLayouts,     setAllLayouts]     = useState({})
  const [pieces,         setPieces]         = useState([])
  const [selectedId,     setSelectedId]     = useState(null)
  const [showAddModal,   setShowAddModal]   = useState(false)
  const [editingPiece,   setEditingPiece]   = useState(null)
  const [snapToGrid,     setSnapToGrid]     = useState(false)
  const [gridSize,       setGridSize]       = useState(4)
  const [currentLayout,  setCurrentLayout]  = useState('')
  const [colorIdx,       setColorIdx]       = useState(0)
  const [showSetup,      setShowSetup]      = useState(false)
  const [setupWallId,    setSetupWallId]    = useState(null)
  const [showWallMgr,    setShowWallMgr]    = useState(false)
  const [authUser,       setAuthUser]       = useState(() => api.getJwtUser())
  const [showAuth,       setShowAuth]       = useState(() => {
    // Auto-open auth modal when arriving via password-reset link
    return Boolean(new URLSearchParams(window.location.search).get('reset_token'))
  })
  const [resetToken,     setResetToken]     = useState(() =>
    new URLSearchParams(window.location.search).get('reset_token') || null
  )
  const [saveMenuOpen,   setSaveMenuOpen]   = useState(false)
  const [saveAsName,     setSaveAsName]     = useState('')
  const [saveAsError,    setSaveAsError]    = useState('')
  const [isSaving,       setIsSaving]       = useState(false)
  const [library,        setLibrary]        = useState({})
  const [sidebarOpen,    setSidebarOpen]    = useState(false)
  const [historyStack,   setHistoryStack]   = useState([])   // undo history (array of piece snapshots)
  const saveMenuRef    = useRef(null)
  const hasLoadedRef   = useRef(false)   // becomes true after first successful backend load
  const piecesRef      = useRef(pieces)  // always-current pieces for stable pushHistory callback
  const calibWallIdRef = useRef(null)    // ref-based tracking of which wall is being calibrated

  /* Keep piecesRef in sync */
  useEffect(() => { piecesRef.current = pieces }, [pieces])

  /* ── Load all state from backend (called on boot and after auth change) ─── */
  const loadAppState = useCallback(async () => {
    setIsLoading(true)
    try {
      const fetchedData = await api.loadState()
      const { walls: savedWalls = {}, layouts: savedLayouts = {}, library: savedLibrary = {} } =
        fetchedData
      const wallsObj   = savedWalls   || {}
      const layoutsObj = savedLayouts || {}
      setWalls(wallsObj)
      setAllLayouts(layoutsObj)

      // ── Auto-migrate existing pieces into library (runs once if library is empty) ──
      let libObj = { ...savedLibrary }
      if (Object.keys(libObj).length === 0) {
        const seen = new Set()
        for (const wallLayouts of Object.values(layoutsObj)) {
          for (const layoutPieces of Object.values(wallLayouts)) {
            for (const piece of layoutPieces) {
              const key = piece.image || `${piece.name}_${piece.width}_${piece.height}`
              if (seen.has(key)) continue
              seen.add(key)
              const libId = genId()
              const libPiece = {
                id: libId, name: piece.name,
                width: piece.width, height: piece.height,
                color: piece.color, image: piece.image || null,
                transparent: piece.transparent || false,
                addedAt: Date.now(),
              }
              libObj[libId] = libPiece
              api.putLibraryPiece(libPiece).catch(console.error)
            }
          }
        }
      }
      setLibrary(libObj)

      const savedActive = localStorage.getItem(ACTIVE_WALL_KEY)
      const ids = Object.keys(wallsObj)
      let activeId = (savedActive && wallsObj[savedActive]) ? savedActive : ids[0] || null
      if (!activeId) {
        setWalls({})
        setActiveWallId(null)
        setShowWallMgr(true)
      } else {
        setActiveWallId(activeId)
      }

      // Return raw fetched data so callers (e.g. handleAuthSuccess) can compare
      return { walls: wallsObj, layouts: layoutsObj, library: libObj }
    } catch (err) {
      console.error('Failed to load state from backend:', err)

      // ── Offline fallback: restore from localStorage snapshot ──────────────
      const snap = (() => {
        try { return JSON.parse(localStorage.getItem(LOCAL_SNAPSHOT_KEY) || 'null') } catch { return null }
      })()
      if (snap && (Object.keys(snap.walls || {}).length > 0 || (snap.activePieces || []).length > 0)) {
        const wallsObj   = snap.walls      || {}
        const layoutsObj = snap.allLayouts || {}
        const libObj     = snap.library    || {}
        // Apply fixUrl to all image paths so relative /uploads/... URLs become absolute
        for (const w of Object.values(wallsObj)) {
          if (w.imageUrl) w.imageUrl = api.fixUrl(w.imageUrl)
        }
        for (const p of Object.values(libObj)) {
          if (p.image) p.image = api.fixUrl(p.image)
        }
        for (const wl of Object.values(layoutsObj)) {
          for (const pieces of Object.values(wl)) {
            for (const p of pieces) { if (p.image) p.image = api.fixUrl(p.image) }
          }
        }
        setWalls(wallsObj)
        setAllLayouts(layoutsObj)
        setLibrary(libObj)
        // Restore unsaved canvas pieces so work survives refresh while offline
        if (snap.activePieces?.length > 0) {
          const fixedPieces = snap.activePieces.map(p =>
            p.image ? { ...p, image: api.fixUrl(p.image) } : p
          )
          setPieces(fixedPieces)
          setCurrentLayout(snap.currentLayout || '')
        }
        const savedActive = snap.activeWallId || localStorage.getItem(ACTIVE_WALL_KEY)
        const ids = Object.keys(wallsObj)
        const activeId = (savedActive && wallsObj[savedActive]) ? savedActive : ids[0] || null
        if (!activeId) {
          setShowWallMgr(true)
        } else {
          setActiveWallId(activeId)
        }
        // hasLoadedRef set in finally
      } else {
        setWalls({})
        setActiveWallId(null)
        setShowWallMgr(true)
      }
      return null  // null signals the backend was unreachable
    } finally {
      // Always mark as loaded — MUST be unconditional so the auto-save
      // snapshot effect can fire even on first offline session (no prior snap).
      hasLoadedRef.current = true
      setIsLoading(false)
    }
  }, [])

  /* ── Boot ──────────────────────────────────────────────── */
  useEffect(() => { loadAppState() }, [loadAppState])

  /* ── Auto-save snapshot to localStorage on every state change ─────────── */
  // This powers: (a) offline fallback on next load, (b) merge-to-backend on login
  // We also save `pieces` + `activeWallId` + `currentLayout` so unsaved canvas work
  // (pieces placed but not yet in a named layout) survives a refresh while offline.
  useEffect(() => {
    if (!hasLoadedRef.current) return   // skip during initial load
    if (Object.keys(walls).length === 0 && pieces.length === 0) return // nothing worth saving
    try {
      localStorage.setItem(LOCAL_SNAPSHOT_KEY, JSON.stringify({
        walls, allLayouts, library,
        activePieces: pieces, activeWallId, currentLayout,
      }))
    } catch { /* storage full - ignore */ }
  }, [walls, allLayouts, library, pieces, activeWallId, currentLayout])

  /* ── Close save menu on outside click ────────────────── */
  useEffect(() => {
    if (!saveMenuOpen) return
    const handler = (e) => {
      if (saveMenuRef.current && !saveMenuRef.current.contains(e.target)) {
        setSaveMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [saveMenuOpen])

  /* ── Derived ──────────────────────────────────────── */
  const activeWall      = walls[activeWallId] || Object.values(walls)[0] || null
  const wallLayouts     = allLayouts[activeWallId] || {}
  const activeWallImage = activeWall?.imageUrl || null

  /* Build wallImages map (wallId => imageUrl) for WallManager thumbnails */
  const wallImages = Object.fromEntries(
    Object.values(walls)
      .filter(w => w.imageUrl)
      .map(w => [w.id, w.imageUrl])
  )

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
    const wall = { id, name, width, height, createdAt: Date.now() }
    setWalls(prev => ({ ...prev, [id]: wall }))
    api.putWall(wall).catch(console.error)
    handleSelectWall(id)
  }, [handleSelectWall])

  const handleDeleteWall = useCallback(async (id) => {
    const wallLayoutsData = allLayouts[id] || {}
    const deletePieceImgPromises = Object.values(wallLayoutsData)
      .flat()
      .filter(p => p.image?.startsWith('/uploads/'))
      .map(p => api.deletePieceImage(p.id).catch(() => {}))
    await Promise.all(deletePieceImgPromises)

    api.deleteWall(id).catch(console.error)

    setWalls(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    setAllLayouts(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    if (activeWallId === id) {
      const remaining = Object.keys(walls).filter(k => k !== id)
      const newId = remaining[0]
      if (newId) handleSelectWall(newId)
    }
  }, [walls, allLayouts, activeWallId, handleSelectWall])

  const handleRenameWall = useCallback((id, name) => {
    setWalls(prev => {
      const updated = { ...prev[id], name }
      api.putWall(updated).catch(console.error)
      return { ...prev, [id]: updated }
    })
  }, [])

  /* ── Wall calibration ─────────────────────────────── */
  const handleWallCalibrated = useCallback(async (dataUrl, _corners, dims) => {
    // Use ref first (most reliable), then fall back to state values
    let id = calibWallIdRef.current || setupWallId || activeWallId
    if (!id) {
      // Last resort: auto-create a wall so the calibration isn't lost
      id = genId()
      const wall = {
        id,
        name: 'My Wall',
        width:  dims?.width  || 128,
        height: dims?.height || 95,
        createdAt: Date.now(),
      }
      setWalls(prev => ({ ...prev, [id]: wall }))
      setActiveWallId(id)
      localStorage.setItem(ACTIVE_WALL_KEY, id)
      api.putWall(wall).catch(console.error)
    }

    // If the user edited the wall dimensions inside WallSetup, save them now
    if (dims && (dims.width || dims.height)) {
      setWalls(prev => {
        const existing = prev[id] || { id }
        const updated = {
          ...existing,
          ...(dims.width  ? { width:  dims.width  } : {}),
          ...(dims.height ? { height: dims.height } : {}),
        }
        api.putWall(updated).catch(console.error)
        return { ...prev, [id]: updated }
      })
    }
    try {
      const { url } = await api.uploadWallImage(id, dataUrl)
      setWalls(prev => {
        const existing = prev[id] || { id }
        const updated = { ...existing, imageUrl: url }
        api.putWall(updated).catch(console.error)
        return { ...prev, [id]: updated }
      })
    } catch (err) {
      console.error('Wall image upload failed:', err)
      setWalls(prev => {
        const existing = prev[id] || { id }
        return { ...prev, [id]: { ...existing, imageUrl: dataUrl } }
      })
    }
    // Close setup and ensure the wall view is shown (not WallManager)
    setShowSetup(false)
    setSetupWallId(null)
    setShowWallMgr(false)
    calibWallIdRef.current = null
  }, [setupWallId, activeWallId])

  /* ── Auth callbacks ───────────────────────────────────── */
  const handleAuthSuccess = useCallback(async (user) => {
    setAuthUser(user)
    setShowAuth(false)
    setResetToken(null)
    const url = new URL(window.location.href)
    url.searchParams.delete('reset_token')
    window.history.replaceState({}, '', url.toString())

    // Read local snapshot BEFORE loading from backend
    const localSnap = (() => {
      try { return JSON.parse(localStorage.getItem(LOCAL_SNAPSHOT_KEY) || 'null') } catch { return null }
    })()

    // ── Step 1: Fetch server's current state so we know what already exists.
    //    Only push local items whose IDs are NOT on the server — this prevents
    //    stale local snapshots from overwriting richer server data (e.g. after
    //    a bulk migration that populated images/transparency the local snap lacks).
    let serverState = null
    try { serverState = await api.loadState() } catch { /* offline — skip merge */ }

    if (localSnap && serverState) {
      const pushOps = []
      const serverWalls   = serverState.walls   || {}
      const serverLayouts = serverState.layouts || {}
      const serverLib     = serverState.library || {}

      for (const wall of Object.values(localSnap.walls || {})) {
        if (serverWalls[wall.id]) continue  // server already has this wall — don't overwrite
        const wallToSync = { ...wall }
        if (wallToSync.imageUrl?.startsWith('data:')) delete wallToSync.imageUrl
        pushOps.push(api.putWall(wallToSync))
      }
      for (const [wallId, wLayouts] of Object.entries(localSnap.allLayouts || {})) {
        const serverWallLayouts = serverLayouts[wallId] || {}
        for (const [name, pcs] of Object.entries(wLayouts || {})) {
          if (serverWallLayouts[name]) continue  // layout already on server — skip
          pushOps.push(api.putLayout(wallId, name, pcs))
        }
      }
      for (const piece of Object.values(localSnap.library || {})) {
        if (serverLib[piece.id]) continue  // library piece already on server — skip
        pushOps.push(api.putLibraryPiece(piece))
      }

      if (pushOps.length > 0) {
        const results = await Promise.allSettled(pushOps)
        const failures = results.filter(r => r.status === 'rejected')
        if (failures.length) console.warn('Some sync writes failed:', failures)
      }
    } else if (localSnap && !serverState) {
      // Offline or server unreachable — push everything as before so work isn't lost
      const pushOps = []
      for (const wall of Object.values(localSnap.walls || {})) {
        const wallToSync = { ...wall }
        if (wallToSync.imageUrl?.startsWith('data:')) delete wallToSync.imageUrl
        pushOps.push(api.putWall(wallToSync))
      }
      for (const [wallId, wLayouts] of Object.entries(localSnap.allLayouts || {})) {
        for (const [name, pcs] of Object.entries(wLayouts || {})) {
          pushOps.push(api.putLayout(wallId, name, pcs))
        }
      }
      for (const piece of Object.values(localSnap.library || {})) {
        pushOps.push(api.putLibraryPiece(piece))
      }
      if (pushOps.length > 0) await Promise.allSettled(pushOps)
    }

    // ── Step 2: Reload full state from backend (now includes all synced data) ──
    await loadAppState()

    // ── Step 3: Restore unsaved canvas pieces (pieces placed but not yet in a
    //    named layout). loadAppState doesn't touch pieces state, but we want the
    //    user's in-progress work to still be on the canvas after login. ──────────
    //    Apply fixUrl so any relative /uploads/... paths become absolute.
    if (localSnap?.activePieces?.length > 0) {
      const fixedPieces = localSnap.activePieces.map(p =>
        p.image ? { ...p, image: api.fixUrl(p.image) } : p
      )
      setPieces(fixedPieces)
      setCurrentLayout(localSnap.currentLayout || '')
    }
  }, [loadAppState])

  const handleLogout = useCallback(() => {
    api.authLogout()
    setAuthUser(null)
    setPieces([])
    setCurrentLayout('')
    // Re-fetch state now that JWT is cleared (returns to device data)
    loadAppState()
  }, [loadAppState])

  const openSetup = useCallback((wallId = null) => {
    const id = wallId || activeWallId
    if (!id) {
      // No wall exists yet — show the wall manager instead
      setShowWallMgr(true)
      return
    }
    calibWallIdRef.current = id
    setSetupWallId(id)
    setShowSetup(true)
  }, [activeWallId])

  /* ── Undo history ─────────────────────────────────── */
  // Stable callback — uses piecesRef so it never goes stale between renders
  const pushHistory = useCallback(() => {
    setHistoryStack(prev => {
      const snapshot = piecesRef.current.map(p => ({ ...p }))
      const next = [...prev, snapshot]
      return next.length > 100 ? next.slice(-100) : next
    })
  }, [])

  const handleUndo = useCallback(() => {
    setHistoryStack(prev => {
      if (prev.length === 0) return prev
      const snapshot = prev[prev.length - 1]
      setPieces(snapshot)
      setSelectedId(null)
      return prev.slice(0, -1)
    })
  }, [])

  /* ── Piece operations ─────────────────────────────── */
  const addPiece = useCallback((data) => {
    pushHistory()
    const piece = {
      id: genId(),
      x: 8, y: 8,
      color: PALETTE[colorIdx % PALETTE.length],
      ...data,
    }
    setPieces(p => [...p, piece])
    setColorIdx(i => i + 1)
    setSelectedId(piece.id)
  }, [colorIdx, pushHistory])

  const updatePiece = useCallback((id, updates) =>
    setPieces(p => p.map(pc => pc.id === id ? { ...pc, ...updates } : pc)),
  [])

  const deletePiece = useCallback((id) => {
    pushHistory()
    setPieces(p => {
      const piece = p.find(pc => pc.id === id)
      if (piece?.image?.startsWith('/uploads/')) {
        api.deletePieceImage(id).catch(() => {})
      }
      return p.filter(pc => pc.id !== id)
    })
    setSelectedId(s => s === id ? null : s)
  }, [pushHistory])

  const handleLockToggle = useCallback((id) => {
    pushHistory()
    setPieces(prev => prev.map(p => p.id === id ? { ...p, locked: !p.locked } : p))
  }, [pushHistory])

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

  /* ── Library operations ───────────────────────────── */
  const saveToLibrary = useCallback(async (pieceData) => {
    const libId = genId()
    let imageUrl = pieceData.image || null
    if (imageUrl?.startsWith('data:')) {
      try {
        const { url } = await api.uploadLibraryImage(libId, imageUrl)
        imageUrl = url
      } catch (err) {
        console.error('Library image upload failed:', err)
      }
    }
    const libPiece = {
      id: libId,
      name: pieceData.name,
      width: pieceData.width,
      height: pieceData.height,
      color: pieceData.color,
      image: imageUrl,
      transparent: pieceData.transparent || false,
      addedAt: Date.now(),
    }
    setLibrary(prev => ({ ...prev, [libId]: libPiece }))
    api.putLibraryPiece(libPiece).catch(console.error)
  }, [])

  const deleteFromLibrary = useCallback((libId) => {
    setLibrary(prev => { const n = { ...prev }; delete n[libId]; return n })
    api.deleteLibraryPiece(libId).catch(console.error)
  }, [])

  const addPieceFromLibrary = useCallback((libPiece) => {
    addPiece({
      name: libPiece.name,
      width: libPiece.width,
      height: libPiece.height,
      color: libPiece.color,
      image: libPiece.image,
      transparent: libPiece.transparent || false,
    })
  }, [addPiece])

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
  const saveLayout = useCallback(async (name) => {
    if (!activeWallId) return
    setIsSaving(true)
    try {
      // Upload any piece images that are still data: URLs
      const uploadedPieces = await Promise.all(
        pieces.map(async (piece) => {
          if (piece.image?.startsWith('data:')) {
            try {
              const { url } = await api.uploadPieceImage(piece.id, piece.image)
              return { ...piece, image: url }
            } catch (err) {
              console.error(`Failed to upload image for piece ${piece.id}:`, err)
              return piece
            }
          }
          return piece
        })
      )
      setPieces(uploadedPieces)
      // ── Optimistic local update FIRST so snapshot captures the layout even if backend is down ──
      setAllLayouts(prev => {
        const wallPrev = prev[activeWallId] || {}
        return { ...prev, [activeWallId]: { ...wallPrev, [name]: uploadedPieces } }
      })
      setCurrentLayout(name)
      setSaveMenuOpen(false)
      setSaveAsName('')
      // Then attempt to persist to backend (fire-and-forget when offline)
      api.putLayout(activeWallId, name, uploadedPieces).catch(err => {
        console.warn('Save layout to backend failed (will sync on next login):', err)
      })
    } catch (err) {
      console.error('Save layout failed:', err)
    } finally {
      setIsSaving(false)
    }
  }, [activeWallId, pieces])

  const saveAsNewLayout = useCallback(() => {
    const name = saveAsName.trim()
    if (!name) { setSaveAsError('Enter a name'); return }
    setSaveAsError('')
    saveLayout(name)
  }, [saveAsName, saveLayout])

  const loadLayout = useCallback((name) => {
    const savedPieces = wallLayouts[name]
    if (!savedPieces) return
    setPieces(savedPieces)
    setSelectedId(null)
    setCurrentLayout(name)
  }, [wallLayouts])

  const deleteLayout = useCallback((name) => {
    const layoutPieces = wallLayouts[name] || []
    layoutPieces
      .filter(p => p.image?.startsWith('/uploads/'))
      .forEach(p => api.deletePieceImage(p.id).catch(() => {}))
    api.deleteLayout(activeWallId, name).catch(console.error)
    setAllLayouts(prev => {
      const wallPrev = { ...(prev[activeWallId] || {}) }
      delete wallPrev[name]
      return { ...prev, [activeWallId]: wallPrev }
    })
    if (currentLayout === name) setCurrentLayout('')
  }, [activeWallId, currentLayout, wallLayouts])

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
      saveToLibrary(data)
    }
    closeModal()
  }, [editingPiece, updatePiece, addPiece, saveToLibrary, closeModal])

  /* ── Keyboard: delete selected ────────────────────── */
  const handleKeyDown = useCallback((e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') &&
        selectedId &&
        !['INPUT','TEXTAREA'].includes(e.target.tagName)) {
      deletePiece(selectedId)
    }
    if (e.key === 'Escape') { setSelectedId(null); setSaveMenuOpen(false) }
  }, [selectedId, deletePiece])

  /* ── Loading screen ───────────────────────────────── */
  if (isLoading) {
    return (
      <div className="app-loading">
        <span className="app-loading-icon">🖼️</span>
        <span>Loading Gallery Wall Planner…</span>
      </div>
    )
  }

  /* ── Render ───────────────────────────────────────── */
  const calibWall = walls[setupWallId] || activeWall

  return (
    <div className="app" onKeyDown={handleKeyDown} tabIndex={-1}>
      <header className="app-header">
        <div className="header-brand">
          <button
            className="hamburger-btn"
            onClick={() => setSidebarOpen(v => !v)}
            aria-label="Toggle sidebar"
          >☰</button>
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
          {/* Save Layout — always visible — shows popover */}
          <div className="header-save-wrap" ref={saveMenuRef}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                if (pieces.length === 0 || isSaving) return
                setSaveMenuOpen(v => !v)
                setSaveAsError('')
              }}
              disabled={pieces.length === 0 || isSaving}
              title="Save current layout"
            >
              {isSaving ? '⏳' : '💾'}<span className="btn-label">{isSaving ? ' Saving…' : ` ${currentLayout ? currentLayout : 'Save Layout'}`}</span>
            </button>
            {saveMenuOpen && (
              <div className="header-save-menu">
                {currentLayout && (
                  <button
                    className="header-save-menu-item header-save-menu-overwrite"
                    onClick={() => saveLayout(currentLayout)}
                  >
                    ↩ Overwrite "{currentLayout}"
                  </button>
                )}
                <div className="header-save-menu-divider" />
                <div className="header-save-menu-row">
                  <input
                    className="text-input header-save-input"
                    placeholder="New layout name…"
                    value={saveAsName}
                    autoFocus
                    onChange={e => { setSaveAsName(e.target.value); setSaveAsError('') }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') saveAsNewLayout()
                      if (e.key === 'Escape') setSaveMenuOpen(false)
                    }}
                  />
                  <button className="btn btn-primary btn-sm" onClick={saveAsNewLayout}>Save</button>
                </div>
                {saveAsError && <span className="field-error">{saveAsError}</span>}
              </div>
            )}
          </div>

          <button
            className={`btn btn-ghost btn-sm ${!activeWallImage ? 'btn-calibrate-pulse' : ''}`}
            onClick={() => openSetup()}
            title={activeWallImage ? 'Re-calibrate wall perspective' : 'Calibrate wall perspective'}
          >
            {activeWallImage ? '⚙' : '📐'}<span className="btn-label"> {activeWallImage ? 'Recalibrate' : 'Calibrate Wall'}</span>
          </button>
          <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            +<span className="btn-label"> Add Piece</span>
          </button>
          <UserBadge
            user={authUser}
            onLoginClick={() => setShowAuth(true)}
            onLogout={handleLogout}
          />
        </div>
      </header>

      <div className="app-body">
        {sidebarOpen && (
          <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
        )}
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
          library={library}
          onAddFromLibrary={addPieceFromLibrary}
          onDeleteFromLibrary={deleteFromLibrary}
          isOpen={sidebarOpen}
          onRequestClose={() => setSidebarOpen(false)}
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
          wallImage={activeWallImage}
          onCalibrate={() => activeWallId ? openSetup() : setShowWallMgr(true)}
          onUndo={handleUndo}
          canUndo={historyStack.length > 0}
          onLockToggle={handleLockToggle}
          onMoveStart={pushHistory}
          onResizeStart={pushHistory}
        />
      </div>

      {showSetup && (
        <WallSetup
          onApply={handleWallCalibrated}
          onClose={() => { setShowSetup(false); setSetupWallId(null); calibWallIdRef.current = null }}
          wallName={calibWall?.name || 'Wall'}
          wallWidth={calibWall?.width || 128}
          wallHeight={calibWall?.height || 95}
          existingImageUrl={calibWall?.imageUrl || null}
        />
      )}

      {showWallMgr && (
        <WallManager
          walls={walls}
          wallImages={wallImages}
          allLayouts={allLayouts}
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

      {showAuth && (
        <AuthModal
          onSuccess={handleAuthSuccess}
          onClose={() => { setShowAuth(false); setResetToken(null) }}
          resetToken={resetToken}
        />
      )}
    </div>
  )
}
