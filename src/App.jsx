import { useState, useCallback, useEffect, useRef } from 'react'
import Wall from './components/Wall'
import Sidebar from './components/Sidebar'
import AddPieceModal from './components/AddPieceModal'
import PaintModal from './components/PaintModal'
import EraseModal from './components/EraseModal'
import WallSetup from './components/WallSetup'
import WallManager from './components/WallManager'
import Room3DViewer from './components/Room3DViewer'
import RoomSetupWizard from './components/RoomSetupWizard'
import RoomManager from './components/RoomManager'
import SpaceBuilder from './components/SpaceBuilder'
import SpacesManager from './components/SpacesManager'
import AuthModal, { UserBadge } from './components/AuthModal'
import Tutorial, { TUTORIAL_STEP_COUNT, TUTORIAL_LOCK_STEP, TUTORIAL_GRID_STEP } from './components/Tutorial'
import * as api from './utils/api'
import { DEFAULT_SNAP } from './utils/units'
import { buildPhotoColors } from './utils/photoMesh'
import { normalizeLoadedRooms, toRoomScanMeta, toRoomsSnapshot } from './utils/roomScanPersistence'
import './App.css'

const TUTORIAL_KEY = 'gwp-tutorial-done'
const TIPS_KEY     = 'gwp-tips-enabled'

/** Normalize a layout entry — handles both old array format and new { pieces, paintLayerIds } */
function normalizeLayout(data) {
  if (!data) return { pieces: [], paintLayerIds: [] }
  if (Array.isArray(data)) return { pieces: data, paintLayerIds: [] }
  return { pieces: data.pieces || [], paintLayerIds: data.paintLayerIds || [] }
}

/* ── Only tiny UI preference stays in localStorage ─────── */
const ACTIVE_WALL_KEY    = 'gwp-active-wall'
const LOCAL_SNAPSHOT_KEY = 'gwp-local-snapshot'
// Saved at logout so the auto-save effect can't overwrite it with empty state
const LOGIN_RESTORE_KEY  = 'gwp-login-restore'
// Minimal { wallId, layoutName } — written whenever user is on a named layout,
// never touched by logout or auto-save, used to land on right layout after login
const LAST_ACTIVE_KEY    = 'gwp-last-active'

const genId = () => Math.random().toString(36).slice(2, 10)

/** Kick off parallel image fetches so CSS backgroundImage paints them all at once */
function preloadPieceImages(pieces) {
  // Fire all image requests in parallel so they arrive together
  // rather than painting top-to-bottom as the DOM is traversed.
  const seen = new Set()
  pieces.forEach(p => {
    if (p.image && !seen.has(p.image)) {
      seen.add(p.image)
      new Image().src = p.image
    }
  })
}

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
  const [showAddModal,     setShowAddModal]     = useState(false)
  const [showPaintModal,   setShowPaintModal]   = useState(false)
  const [showEraseWall,    setShowEraseWall]    = useState(false)
  const [editingLayerId,   setEditingLayerId]   = useState(null)   // which layer is open in PaintModal
  // wallPaintLayers: { [wallId]: { [layerId]: { id, name, color, maskDataUrl, visible, createdAt } } }
  const [wallPaintLayers,  setWallPaintLayers]  = useState({})
  const [editingPiece,   setEditingPiece]   = useState(null)
  const [unitSystem,     setUnitSystem]     = useState(() =>
    localStorage.getItem('gwp-unit-system') || 'imperial'
  )
  const [snapToGrid,     setSnapToGrid]     = useState(false)
  const [gridSize,       setGridSize]       = useState(() => DEFAULT_SNAP[localStorage.getItem('gwp-unit-system') || 'imperial'])
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
  const [saveFlash,      setSaveFlash]      = useState(false)
  const [library,        setLibrary]        = useState({})
  const [sidebarOpen,    setSidebarOpen]    = useState(false)
  const [sidebarForceSection, setSidebarForceSection] = useState(null)
  const [historyStack,   setHistoryStack]   = useState([])   // undo history (array of piece snapshots)
  const [tutorialStep,   setTutorialStep]   = useState(() =>
    localStorage.getItem(TUTORIAL_KEY) === 'true' ? null : 0
  )
  const [tipsEnabled,    setTipsEnabled]    = useState(() =>
    localStorage.getItem(TIPS_KEY) !== 'false'    // default: true
  )

  /* ── 3D Rooms state ─────────────────────────────────── */
  const [rooms,           setRooms]           = useState({})
  const [activeRoomId,    setActiveRoomId]    = useState(null)
  const [showRoomMgr,     setShowRoomMgr]     = useState(false)
  const [showRoomView,    setShowRoomView]    = useState(false)
  const [showRoomWizard,  setShowRoomWizard]  = useState(false)
  const [editingRoomId,   setEditingRoomId]   = useState(null)
  const [newRoomName,     setNewRoomName]     = useState('')
  /* ── Space Builder state ───────────────────────── */
  const [showSpaceBuilder, setShowSpaceBuilder] = useState(false)
  const [showSpaceMgr,     setShowSpaceMgr]     = useState(false)
  const [editingSpaceId,   setEditingSpaceId]   = useState(null)
  const saveFlashTimer   = useRef(null)
  const saveMenuRef    = useRef(null)
  const hasLoadedRef   = useRef(false)   // becomes true after first successful backend load
  const piecesRef      = useRef(pieces)  // always-current pieces for stable pushHistory callback
  const calibWallIdRef = useRef(null)    // ref-based tracking of which wall is being calibrated

  /* Keep piecesRef in sync */
  useEffect(() => { piecesRef.current = pieces }, [pieces])

  /* ── Load all state from backend (called on boot and after auth change) ─── */
  const loadAppState = useCallback(async ({ restoreSession = true } = {}) => {
    setIsLoading(true)
    try {
      const fetchedData = await api.loadState()
      const { walls: savedWalls = {}, layouts: savedLayouts = {}, library: savedLibrary = {}, paintLayers: savedPaintLayers = {}, rooms: savedRooms = {} } =
        fetchedData
      const wallsObj   = savedWalls   || {}
      const layoutsObj = savedLayouts || {}
      setWalls(wallsObj)
      setAllLayouts(layoutsObj)
      if (savedPaintLayers && Object.keys(savedPaintLayers).length > 0) {
        setWallPaintLayers(savedPaintLayers)
      }
      const roomsObj = normalizeLoadedRooms(savedRooms || {}, api.fixUrl)
      setRooms(roomsObj)

      // ── Auto-migrate existing pieces into library (runs once if library is empty) ──
      let libObj = { ...savedLibrary }
      if (Object.keys(libObj).length === 0) {
        const seen = new Set()
        for (const wallLayouts of Object.values(layoutsObj)) {
          for (const layoutData of Object.values(wallLayouts)) {
            for (const piece of normalizeLayout(layoutData).pieces) {
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
        // Never auto-open WallManager on load — the tutorial guides new users,
        // and returning users can open it manually via the wall name badge.
      } else {
        setActiveWallId(activeId)
        // Restore active pieces from session snapshot (survives refresh when online)
        if (restoreSession) {
          const sessionSnap = (() => {
            try { return JSON.parse(localStorage.getItem(LOCAL_SNAPSHOT_KEY) || 'null') } catch { return null }
          })()
          if (sessionSnap?.activePieces?.length > 0) {
            // If snapshot is for a wall that exists, switch to it (handles multi-wall case)
            const snapWall = sessionSnap.activeWallId
            if (snapWall && wallsObj[snapWall] && snapWall !== activeId) {
              setActiveWallId(snapWall)
              localStorage.setItem(ACTIVE_WALL_KEY, snapWall)
            }
            const fixedPieces = sessionSnap.activePieces.map(p =>
              p.image ? { ...p, image: api.fixUrl(p.image) } : p
            )
            preloadPieceImages(fixedPieces)
            setPieces(fixedPieces)
            setCurrentLayout(sessionSnap.currentLayout || '')
          } else if (sessionSnap?.currentLayout) {
            // No unsaved pieces — load the last named layout they were viewing from server data
            const snapWall = sessionSnap.activeWallId
            const wallId = (snapWall && wallsObj[snapWall]) ? snapWall : activeId
            const { pieces: layoutPieces } = normalizeLayout(layoutsObj[wallId]?.[sessionSnap.currentLayout])
            if (layoutPieces?.length > 0) {
              if (wallId !== activeId) {
                setActiveWallId(wallId)
                localStorage.setItem(ACTIVE_WALL_KEY, wallId)
              }
              preloadPieceImages(layoutPieces)
              setPieces(layoutPieces)
              setCurrentLayout(sessionSnap.currentLayout)
            }
          }
        }
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
        setRooms(normalizeLoadedRooms(snap.rooms || {}, api.fixUrl))
        // Restore unsaved canvas pieces so work survives refresh while offline
        if (snap.activePieces?.length > 0) {
          const fixedPieces = snap.activePieces.map(p =>
            p.image ? { ...p, image: api.fixUrl(p.image) } : p
          )
          preloadPieceImages(fixedPieces)
          setPieces(fixedPieces)
          setCurrentLayout(snap.currentLayout || '')
        }
        const savedActive = snap.activeWallId || localStorage.getItem(ACTIVE_WALL_KEY)
        const ids = Object.keys(wallsObj)
        const activeId = (savedActive && wallsObj[savedActive]) ? savedActive : ids[0] || null
        if (activeId) {
          setActiveWallId(activeId)
        }
        // No wall → stay on empty canvas, tutorial or header badge guides the user
        // hasLoadedRef set in finally
      } else {
        setWalls({})
        setRooms({})
        setActiveWallId(null)
        // No auto-open — new users see the tutorial, returning users use the header badge
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
        rooms: toRoomsSnapshot(rooms),
        activePieces: pieces, activeWallId, currentLayout,
      }))
    } catch { /* storage full - ignore */ }
  }, [walls, allLayouts, library, rooms, pieces, activeWallId, currentLayout])

  /* ── Track last named layout — survives logout/login ──── */
  useEffect(() => {
    if (!activeWallId || !currentLayout) return
    try {
      localStorage.setItem(LAST_ACTIVE_KEY, JSON.stringify({ wallId: activeWallId, layoutName: currentLayout }))
    } catch {}
  }, [activeWallId, currentLayout])

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
  // Effective image = last erase result (if any) on top of original photo.
  // Legacy walls may have a single inpaintDataUrl instead of the array — treat it as history[0].
  const activeWallEraseHistory = activeWall
    ? (activeWall.eraseHistory?.length > 0
        ? activeWall.eraseHistory
        : activeWall.inpaintDataUrl
          ? [{ id: 'legacy', createdAt: 0, dataUrl: activeWall.inpaintDataUrl }]
          : [])
    : []
  // Last *visible* erase in the history stack is the effective image
  const lastVisibleErase = [...activeWallEraseHistory].reverse().find(e => e.visible !== false)
  const activeWallEffectiveImage = lastVisibleErase?.dataUrl || activeWall?.imageUrl || null

  /* Paint layers for active wall */
  const activePaintLayers = Object.values(wallPaintLayers[activeWallId] || {})
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))

  /* Build wallImages map (wallId => imageUrl) for WallManager thumbnails */
  const wallImages = Object.fromEntries(
    Object.values(walls)
      .filter(w => w.imageUrl)
      .map(w => [w.id, w.imageUrl])
  )

  const hasUnsavedChanges = pieces.length > 0 && (() => {
    if (!currentLayout) return true
    const { pieces: saved } = normalizeLayout(wallLayouts[currentLayout])
    if (!saved || saved.length !== pieces.length) return true
    const map = Object.fromEntries(saved.map(p => [p.id, p]))
    return pieces.some(p => {
      const s = map[p.id]
      return !s || s.x !== p.x || s.y !== p.y || s.width !== p.width || s.height !== p.height
    })
  })()

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
      .flatMap(layoutData => normalizeLayout(layoutData).pieces)
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

  /* ── 3D Room handlers ─────────────────────────────── */

  /**
   * Save a room (new or updated).
   * Uploads any surface images that are still data: URLs, then persists room metadata.
   */
  const handleSaveRoom = useCallback(async (draft) => {
    // Build an updated copy, uploading per-surface data URLs as needed
    const uploadedSurfaces = { ...draft.surfaces }
    await Promise.all(
      Object.entries(draft.surfaces || {}).map(async ([faceId, surface]) => {
        if (surface.warpedImageUrl?.startsWith('data:')) {
          try {
            const { url } = await api.uploadSurfaceImage(draft.id, faceId, surface.warpedImageUrl)
            uploadedSurfaces[faceId] = { ...surface, warpedImageUrl: url }
          } catch (err) {
            console.error(`Surface image upload failed (${faceId}):`, err)
            // Keep the data URL locally so the viewer still renders
          }
        }
      })
    )
    const finalRoom = { ...draft, surfaces: uploadedSurfaces }
    // Strip any remaining large data URLs before sending to server
    const toSave = {
      ...finalRoom,
      surfaces: Object.fromEntries(
        Object.entries(finalRoom.surfaces || {}).map(([fid, s]) => [
          fid,
          { ...s, warpedImageUrl: s.warpedImageUrl?.startsWith('data:') ? null : s.warpedImageUrl },
        ])
      ),
    }
    await api.putRoom(toSave)
    setRooms(prev => ({ ...prev, [finalRoom.id]: finalRoom }))
    setActiveRoomId(finalRoom.id)
    setShowRoomWizard(false)
    setEditingRoomId(null)
  }, [])

  const handleDeleteRoom = useCallback(async (roomId) => {
    await api.deleteRoom(roomId).catch(console.error)
    setRooms(prev => { const next = { ...prev }; delete next[roomId]; return next })
    if (activeRoomId === roomId) {
      setActiveRoomId(null)
      setShowRoomView(false)
    }
  }, [activeRoomId])

  /** Open 3D room tour */
  const handleViewRoom = useCallback((roomId) => {
    setActiveRoomId(roomId)
    setShowRoomView(true)
    setShowRoomMgr(false)
  }, [])

  /** User clicked a face inside the 3D viewer — open setup wizard for that room */
  const handleEditRoomFace = useCallback((_faceId) => {
    // Just open the wizard; FacePickerStep lets them choose which face to re-crop
    setShowRoomView(false)
    setShowRoomWizard(true)
  }, [])

  /* ── Space Builder save ──────────────────────────────── */
  const handleSaveSpace = useCallback(async (space, onProgress) => {
    const report = (pct) => { try { onProgress?.(pct) } catch {} }

    const rawSnapshots = space.roomScan?.snapshots || []
    const usableSnapshots = rawSnapshots.filter(s =>
      (s?.dataUrl || s?.jpegB64) &&
      Array.isArray(s?.transform) && s.transform.length === 16 &&
      Array.isArray(s?.intrinsics) && s.intrinsics.length === 6
    )

    // Optional pre-save retexture: bake photo colours directly into the point
    // cloud so reloading a saved room still looks photorealistic without
    // carrying large snapshot image payloads in room JSON.
    const livePc = space.roomScan?.pointCloud
    if (livePc?._buffer && usableSnapshots.length) {
      try {
        report(4)
        const baked = await buildPhotoColors(livePc._buffer, usableSnapshots)
        if (baked) {
          const raw = livePc._buffer._data
          for (let i = 0, p = 0; i < livePc._buffer.pointCount; i++, p += 6) {
            raw[p + 3] = baked[i * 3]
            raw[p + 4] = baked[i * 3 + 1]
            raw[p + 5] = baked[i * 3 + 2]
          }
        }
      } catch (err) {
        console.warn('[handleSaveSpace] photo retexture bake failed:', err)
      }
    }

    // Strip the binary point-cloud payload before putRoom so the JSON is tiny.
    // The blob is uploaded separately below with real XHR progress.
    const pc = space.roomScan?.pointCloud
    const hasBinary = pc && (pc._buffer || pc.data)  // in-memory scan OR legacy base64
    const previousUrl = pc?.url || null
    let pointCloudUrl = previousUrl

    const initialRoomMeta = space.roomScan
      ? {
          ...toRoomScanMeta(space.roomScan),
          pointCloud: {
            pointCount: pc?.pointCount ?? space.roomScan.pointCloud?.pointCount ?? 0,
            url: pointCloudUrl,
          },
        }
      : null

    report(5)
    // Ensure the room exists before binary upload (required for fresh room IDs).
    await api.putRoom(initialRoomMeta ? { ...space, roomScan: initialRoomMeta } : space)
    setRooms(prev => ({ ...prev, [space.id]: { ...space, roomScan: initialRoomMeta } }))
    report(12)

    // ── Upload binary point cloud separately (12% → 68%) ──────────────────────
    if (hasBinary) {
      try {
        let arrayBuffer
        if (pc._buffer) {
          // Live scan: buffer already decoded in memory — zero copy
          const arr = pc._buffer.toFloat32Array()
          arrayBuffer = arr.buffer.slice(0, arr.byteLength)
        } else {
          // Legacy base64 path: decode to binary
          const raw = atob(pc.data)
          const bytes = new Uint8Array(raw.length)
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
          arrayBuffer = bytes.buffer
        }
        let uploadError = null
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const { url } = await api.uploadPointCloud(space.id, arrayBuffer, (frac) => {
              // Keep progress moving even before first server bytes arrive.
              const floor = 12 + (attempt - 1) * 2
              report(Math.max(floor, 12 + Math.round(frac * 56)))   // 12% → 68%
            })
            pointCloudUrl = url || pointCloudUrl
            uploadError = null
            break
          } catch (err) {
            uploadError = err
            console.warn(`[handleSaveSpace] point cloud upload attempt ${attempt}/3 failed`, err)
          }
        }
        if (uploadError) throw uploadError
      } catch (err) {
        console.error('[handleSaveSpace] point cloud upload failed', err)
        if (!pointCloudUrl) {
          throw new Error('Point cloud upload failed; room was not saved to avoid missing scan data on reload.')
        }
      }
    }

    const roomMeta = space.roomScan
      ? {
          ...toRoomScanMeta(space.roomScan),
          pointCloud: {
            pointCount: pc?.pointCount ?? space.roomScan.pointCloud?.pointCount ?? 0,
            url: pointCloudUrl,
          },
        }
      : null

    // Patch final point-cloud URL (or keep previous URL when upload fails but prior URL exists).
    const spaceForMeta = roomMeta ? { ...space, roomScan: roomMeta } : space
    await api.putRoom(spaceForMeta)
    setRooms(prev => ({ ...prev, [space.id]: { ...space, roomScan: roomMeta } }))

    report(68)

    // ── Upload all warped surface images first, then save walls with URLs ──
    // We capture existing walls once so the imageUrl lookup is stable.
    const existingWalls = {}
    setWalls(prev => { Object.assign(existingWalls, prev); return prev })

    // Upload warped images and new inpaint results sequentially so progress is trackable
    const imageUrls   = {}
    const inpaintUrls = {}
    const surfaces = space.surfaces
    const uploadStep = 24 / Math.max(1, surfaces.length)  // 68% → 92%
    for (let si = 0; si < surfaces.length; si++) {
      const surface = surfaces[si]
      if (surface.warpedDataUrl) {
        try {
          const { url } = await api.uploadWallImage(surface.id, surface.warpedDataUrl)
          imageUrls[surface.id] = url
        } catch (err) {
          console.error('[handleSaveSpace] image upload failed for', surface.id, err)
        }
      }
      if (surface.inpaintDataUrl) {
        const existing     = existingWalls[surface.id]
        const lastEraseUrl = existing?.eraseHistory?.at(-1)?.dataUrl ?? existing?.inpaintDataUrl
        if (surface.inpaintDataUrl !== lastEraseUrl) {
          try {
            const { url } = await api.uploadWallInpaint(surface.id, surface.inpaintDataUrl)
            inpaintUrls[surface.id] = url
          } catch {
            inpaintUrls[surface.id] = surface.inpaintDataUrl
          }
        }
      }
      report(68 + Math.round(uploadStep * (si + 1)))
    }

    // Now build wall objects — all URLs are resolved
    report(92)
    const wallUpdates = {}
    for (const surface of surfaces) {
      const wallId   = surface.id
      const existing = existingWalls[wallId]

      let eraseHistory = existing?.eraseHistory || []
      if (inpaintUrls[wallId]) {
        eraseHistory = [...eraseHistory, { id: genId(), createdAt: Date.now(), dataUrl: inpaintUrls[wallId] }]
      }

      const wall = {
        id:        wallId,
        name:      surface.name,
        width:     surface.widthIn,
        height:    surface.heightIn,
        roomId:    space.id,
        createdAt: existing?.createdAt || Date.now(),
        imageUrl:  imageUrls[wallId] ?? existing?.imageUrl ?? null,
        ...(eraseHistory.length ? { eraseHistory } : {}),
      }
      wallUpdates[wallId] = wall
      api.putWall(wall).catch(console.error)
    }

    setWalls(prev => ({ ...prev, ...wallUpdates }))
    report(100)
  }, [])

  const handleDeleteSpace = useCallback(async (spaceId) => {
    await api.deleteRoom(spaceId).catch(console.error)
    setRooms(prev => { const next = { ...prev }; delete next[spaceId]; return next })
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
        width:  dims?.width  || 120,
        height: dims?.height || 96,
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

    // Read working-state snapshot — prefer the logout-time copy (saved before the
    // auto-save effect can overwrite it with empty pieces) over the live snapshot.
    const localSnap = (() => {
      try {
        const loginRestore = localStorage.getItem(LOGIN_RESTORE_KEY)
        if (loginRestore) {
          localStorage.removeItem(LOGIN_RESTORE_KEY)   // one-shot: clear after reading
          return JSON.parse(loginRestore)
        }
        return JSON.parse(localStorage.getItem(LOCAL_SNAPSHOT_KEY) || 'null')
      } catch { return null }
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
        for (const [name, layoutData] of Object.entries(wLayouts || {})) {
          if (serverWallLayouts[name]) continue  // layout already on server — skip
          const { pieces: pcs, paintLayerIds: plIds } = normalizeLayout(layoutData)
          pushOps.push(api.putLayout(wallId, name, pcs, plIds))
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
        for (const [name, layoutData] of Object.entries(wLayouts || {})) {
          const { pieces: pcs, paintLayerIds: plIds } = normalizeLayout(layoutData)
          pushOps.push(api.putLayout(wallId, name, pcs, plIds))
        }
      }
      for (const piece of Object.values(localSnap.library || {})) {
        pushOps.push(api.putLibraryPiece(piece))
      }
      if (pushOps.length > 0) await Promise.allSettled(pushOps)
    }

    // ── Step 2: Reload full state from backend (now includes all synced data) ──
    const freshData = await loadAppState()

    // ── Step 3: Land the user on their last layout ──────────────────────────
    // Primary: LAST_ACTIVE_KEY holds { wallId, layoutName } and is written
    // every time the user is on a named layout — never touched by logout or
    // auto-save, so it's always reliable.
    // Secondary: if localSnap has unsaved pieces beyond the saved layout,
    // restore those on top of the layout load (captures in-progress edits).
    const lastActive = (() => {
      try { return JSON.parse(localStorage.getItem(LAST_ACTIVE_KEY) || 'null') } catch { return null }
    })()

    if (lastActive?.wallId && lastActive?.layoutName && freshData) {
      const wallId = freshData.walls?.[lastActive.wallId]
        ? lastActive.wallId
        : Object.keys(freshData.walls || {})[0]
      const { pieces: layoutPieces, paintLayerIds } = normalizeLayout(freshData.layouts?.[wallId]?.[lastActive.layoutName])
      if (layoutPieces?.length > 0) {
        setActiveWallId(wallId)
        localStorage.setItem(ACTIVE_WALL_KEY, wallId)

        // Restore paint layer visibility for this layout
        setWallPaintLayers(prev => {
          const wallLayers = prev[wallId] || {}
          const updated = Object.fromEntries(
            Object.entries(wallLayers).map(([id, layer]) =>
              [id, { ...layer, visible: paintLayerIds.includes(id) }]
            )
          )
          return { ...prev, [wallId]: updated }
        })

        // If the user also had unsaved edits on top of that layout, restore those
        const unsavedPieces = localSnap?.activePieces
        if (unsavedPieces?.length > 0 && localSnap?.currentLayout === lastActive.layoutName) {
          const fixedPieces = unsavedPieces.map(p =>
            p.image ? { ...p, image: api.fixUrl(p.image) } : p
          )
          preloadPieceImages(fixedPieces)
          setPieces(fixedPieces)
        } else {
          preloadPieceImages(layoutPieces)
          setPieces(layoutPieces)
        }
        setCurrentLayout(lastActive.layoutName)
      }
    } else if (localSnap?.activePieces?.length > 0) {
      // Fallback: no LAST_ACTIVE_KEY yet, but we have a snapshot with pieces
      const fixedPieces = localSnap.activePieces.map(p =>
        p.image ? { ...p, image: api.fixUrl(p.image) } : p
      )
      const snapWall = localSnap.activeWallId
      if (snapWall && freshData?.walls?.[snapWall]) {
        setActiveWallId(snapWall)
        localStorage.setItem(ACTIVE_WALL_KEY, snapWall)
      }
      preloadPieceImages(fixedPieces)
      setPieces(fixedPieces)
      setCurrentLayout(localSnap.currentLayout || '')
    }
  }, [loadAppState])

  const handleLogout = useCallback(() => {
    // Capture current working state SYNCHRONOUSLY before state changes trigger
    // the auto-save effect (which would overwrite the snapshot with empty pieces).
    const currentSnap = localStorage.getItem(LOCAL_SNAPSHOT_KEY)
    if (currentSnap) {
      try { localStorage.setItem(LOGIN_RESTORE_KEY, currentSnap) } catch {}
    }
    api.authLogout()
    setAuthUser(null)
    setPieces([])
    setCurrentLayout('')
    // Re-fetch state now that JWT is cleared (returns to device data)
    loadAppState({ restoreSession: false })
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

  /* ── Tutorial / Tips ──────────────────────────────────── */
  const handleTutorialNext = useCallback(() => {
    setTutorialStep(prev => {
      if (prev === null) return null
      // Close sidebar when leaving the grid/snap step (it was force-opened for that step)
      if (prev === TUTORIAL_GRID_STEP) setSidebarOpen(false)
      const next = prev + 1
      if (next >= TUTORIAL_STEP_COUNT) {
        localStorage.setItem(TUTORIAL_KEY, 'true')
        return null
      }
      return next
    })
  }, [])

  const handleTutorialBack = useCallback(() => {
    setTutorialStep(prev => {
      if (prev === null || prev <= 0) return prev
      // Close sidebar when leaving the grid/snap step in either direction
      if (prev === TUTORIAL_GRID_STEP) setSidebarOpen(false)
      return prev - 1
    })
  }, [])

  const handleTutorialSkip = useCallback(() => {
    localStorage.setItem(TUTORIAL_KEY, 'true')
    setTutorialStep(null)
  }, [])

  const handleStartTutorial = useCallback(() => {
    localStorage.removeItem(TUTORIAL_KEY)
    setTutorialStep(0)
    setShowWallMgr(false)   // close any open modal so it doesn't block step 0
    setShowSetup(false)
    setShowAuth(false)
  }, [])

  const handleToggleTips = useCallback(() => {
    setTipsEnabled(prev => {
      const next = !prev
      localStorage.setItem(TIPS_KEY, String(next))
      return next
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

  /* ── Paint layer operations ──────────────────────────── */
  const savePaintLayer = useCallback((layerData) => {
    if (!activeWallId) return
    setWallPaintLayers(prev => ({
      ...prev,
      [activeWallId]: { ...(prev[activeWallId] || {}), [layerData.id]: layerData },
    }))
    api.putPaintLayer(activeWallId, layerData).catch(console.error)
  }, [activeWallId])

  const deletePaintLayer = useCallback((layerId) => {
    if (!activeWallId) return
    setWallPaintLayers(prev => {
      const wl = { ...(prev[activeWallId] || {}) }; delete wl[layerId]
      return { ...prev, [activeWallId]: wl }
    })
    api.deletePaintLayer(activeWallId, layerId).catch(console.error)
  }, [activeWallId])

  const togglePaintLayer = useCallback((layerId) => {
    if (!activeWallId) return
    setWallPaintLayers(prev => {
      const layer = (prev[activeWallId] || {})[layerId]; if (!layer) return prev
      const updated = { ...layer, visible: !layer.visible }
      api.putPaintLayer(activeWallId, updated).catch(console.error)
      return { ...prev, [activeWallId]: { ...(prev[activeWallId] || {}), [layerId]: updated } }
    })
  }, [activeWallId])

  const renamePaintLayer = useCallback((layerId, name) => {
    if (!activeWallId) return
    setWallPaintLayers(prev => {
      const layer = (prev[activeWallId] || {})[layerId]; if (!layer) return prev
      const updated = { ...layer, name }
      api.putPaintLayer(activeWallId, updated).catch(console.error)
      return { ...prev, [activeWallId]: { ...(prev[activeWallId] || {}), [layerId]: updated } }
    })
  }, [activeWallId])

  // ── Wall erase (content-aware fill) ──────────────────────────────────────
  const handleWallEraseApply = useCallback(async (dataUrl) => {
    if (!activeWallId) return
    const eraseEntry = { id: genId(), createdAt: Date.now(), dataUrl }
    // Try to upload so the URL persists across sessions
    try {
      const { url } = await api.uploadWallInpaint(activeWallId, dataUrl)
      eraseEntry.dataUrl = url
    } catch {
      // Keep inline data URL on upload failure (local dev)
    }
    setWalls(prev => {
      const wall     = prev[activeWallId] || {}
      const history  = [...(wall.eraseHistory || []), eraseEntry]
      const updated  = { ...wall, eraseHistory: history }
      api.putWall(updated).catch(console.error)
      return { ...prev, [activeWallId]: updated }
    })
  }, [activeWallId])

  const handleRemoveErase = useCallback((wallId, eraseId) => {
    setWalls(prev => {
      const wall    = prev[wallId] || {}
      const history = (wall.eraseHistory || []).filter(e => e.id !== eraseId)
      const updated = { ...wall, eraseHistory: history }
      api.putWall(updated).catch(console.error)
      return { ...prev, [wallId]: updated }
    })
  }, [])

  const handleToggleEraseVisible = useCallback((wallId, eraseId) => {
    setWalls(prev => {
      const wall    = prev[wallId] || {}
      const history = (wall.eraseHistory || []).map(e =>
        e.id === eraseId ? { ...e, visible: e.visible === false ? true : false } : e
      )
      const updated = { ...wall, eraseHistory: history }
      api.putWall(updated).catch(console.error)
      return { ...prev, [wallId]: updated }
    })
  }, [])

  const handlePaintApply = useCallback((color, maskDataUrl) => {
    if (!activeWallId) return
    const id = editingLayerId || genId()
    const existing = (wallPaintLayers[activeWallId] || {})[id]
    const layer = {
      id,
      name: existing?.name || `Paint ${Object.keys(wallPaintLayers[activeWallId] || {}).length + 1}`,
      color,
      maskDataUrl,
      visible: true,
      createdAt: existing?.createdAt || Date.now(),
    }
    savePaintLayer(layer)
    setShowPaintModal(false)
    setEditingLayerId(null)
  }, [activeWallId, editingLayerId, wallPaintLayers, savePaintLayer])

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
      // Capture which paint layers are currently visible
      const visiblePaintLayerIds = activePaintLayers.filter(l => l.visible).map(l => l.id)
      const layoutData = { pieces: uploadedPieces, paintLayerIds: visiblePaintLayerIds }
      // ── Optimistic local update FIRST so snapshot captures the layout even if backend is down ──
      setAllLayouts(prev => {
        const wallPrev = prev[activeWallId] || {}
        return { ...prev, [activeWallId]: { ...wallPrev, [name]: layoutData } }
      })
      setCurrentLayout(name)
      setSaveMenuOpen(false)
      setSaveAsName('')
      // Then attempt to persist to backend (fire-and-forget when offline)
      api.putLayout(activeWallId, name, uploadedPieces, visiblePaintLayerIds).catch(err => {
        console.warn('Save layout to backend failed (will sync on next login):', err)
      })
    } catch (err) {
      console.error('Save layout failed:', err)
    } finally {
      setIsSaving(false)
      setSaveFlash(true)
      if (saveFlashTimer.current) clearTimeout(saveFlashTimer.current)
      saveFlashTimer.current = setTimeout(() => setSaveFlash(false), 2200)
    }
  }, [activeWallId, pieces])

  const saveAsNewLayout = useCallback(() => {
    const name = saveAsName.trim()
    if (!name) { setSaveAsError('Enter a name'); return }
    setSaveAsError('')
    saveLayout(name)
  }, [saveAsName, saveLayout])

  const loadLayout = useCallback((name) => {
    const layoutData = wallLayouts[name]
    if (!layoutData) return
    const { pieces: savedPieces, paintLayerIds } = normalizeLayout(layoutData)
    preloadPieceImages(savedPieces)
    setPieces(savedPieces)
    setSelectedId(null)
    setCurrentLayout(name)
    // Restore paint layer visibility for this layout
    setWallPaintLayers(prev => {
      const wallLayers = prev[activeWallId] || {}
      const updated = Object.fromEntries(
        Object.entries(wallLayers).map(([id, layer]) =>
          [id, { ...layer, visible: paintLayerIds.includes(id) }]
        )
      )
      return { ...prev, [activeWallId]: updated }
    })
  }, [wallLayouts, activeWallId])

  const discardChanges = useCallback(() => {
    pushHistory()
    if (currentLayout && wallLayouts[currentLayout]) {
      const { pieces: saved } = normalizeLayout(wallLayouts[currentLayout])
      setPieces(saved.map(p => ({ ...p })))
    } else {
      setPieces([])
      setCurrentLayout('')
    }
    setSelectedId(null)
  }, [currentLayout, wallLayouts, pushHistory])

  const deleteLayout = useCallback((name) => {
    const { pieces: layoutPieces } = normalizeLayout(wallLayouts[name])
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
        <span className="app-loading-icon">
          <svg width="36" height="36" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="32" height="32" rx="4" fill="#1A1510"/>
            <rect x="4" y="4" width="24" height="24" rx="1" stroke="#F5F0E8" strokeWidth="1.5" fill="none" opacity="0.25"/>
            <rect x="8" y="8" width="16" height="16" rx="1" stroke="#C4875A" strokeWidth="1.5" fill="none"/>
            <rect x="12" y="12" width="8" height="8" rx="0.5" fill="#C4875A"/>
          </svg>
        </span>
        <span>Loading Stage…</span>
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
            data-tutorial="sidebar-toggle"
            onClick={() => setSidebarOpen(v => !v)}
            aria-label="Toggle sidebar"
          >☰</button>
          {/* Stage mark — three nested rectangles */}
          <span className="brand-icon">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect width="32" height="32" rx="4" fill="#1A1510"/>
              <rect x="4" y="4" width="24" height="24" rx="1" stroke="#F5F0E8" strokeWidth="1.5" fill="none" opacity="0.25"/>
              <rect x="8" y="8" width="16" height="16" rx="1" stroke="#C4875A" strokeWidth="1.5" fill="none"/>
              <rect x="12" y="12" width="8" height="8" rx="0.5" fill="#C4875A"/>
            </svg>
          </span>
          <span className="brand-name">Stage</span>
          <span className="header-sep" />
          <button
            className="wall-badge wall-badge--btn"
            data-tutorial="header-wall-badge"
            onClick={() => setShowWallMgr(true)}
            title="Switch or manage walls"
          >
            {activeWall?.name || 'My Wall'}
            <span className="wall-badge-dims">
              {unitSystem === 'metric'
                ? `${Math.round((activeWall?.width || 0) * 2.54)} × ${Math.round((activeWall?.height || 0) * 2.54)} cm`
                : `${activeWall?.width}" × ${activeWall?.height}"`}
            </span>
          </button>
          {/* [ROOMS — 3D Room Tour feature not yet implemented; button hidden until ready]
          <button
            className="room-3d-btn"
            onClick={() => setShowRoomMgr(true)}
            title="3D Room Tour"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M7 1L13 4.5V9.5L7 13L1 9.5V4.5L7 1Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/>
              <path d="M7 1v12M1 4.5l6 3.5 6-3.5" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" opacity="0.6"/>
            </svg>
            <span className="btn-label"> Rooms</span>
            {Object.keys(rooms).filter(id => rooms[id].roomType !== 'space').length > 0 && (
              <span className="room-count-badge">{Object.keys(rooms).filter(id => rooms[id].roomType !== 'space').length}</span>
            )}
          </button>
          */}
          <button
            className="space-builder-btn"
            onClick={() => {
              const savedSpaces = Object.values(rooms).filter(r => r.roomType === 'space')
              if (savedSpaces.length > 0) {
                setShowSpaceMgr(true)
              } else {
                setEditingSpaceId(null)
                setShowSpaceBuilder(true)
              }
            }}
            title="Interactive Space Builder"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.25"/>
              <rect x="7" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.25"/>
              <rect x="1" y="7" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.25"/>
              <rect x="7" y="7" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.25"/>
            </svg>
            <span className="btn-label"> Build</span>
            {Object.values(rooms).filter(r => r.roomType === 'space').length > 0 && (
              <span className="room-count-badge">{Object.values(rooms).filter(r => r.roomType === 'space').length}</span>
            )}
          </button>
        </div>
        <div className="header-actions">
          {/* Save Layout — always visible — shows popover */}
          <div className="header-save-wrap" ref={saveMenuRef} data-tutorial="header-save">
            <button
              className={`btn btn-ghost btn-sm${saveFlash ? ' btn--saved' : ''}`}
              onClick={() => {
                if (pieces.length === 0 || isSaving || saveFlash) return
                setSaveMenuOpen(v => !v)
                setSaveAsError('')
              }}
              disabled={pieces.length === 0 || isSaving}
              title="Save current layout"
            >
              {isSaving ? (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" className="btn-icon spin"><circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3"/></svg>
              ) : saveFlash ? (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" className="btn-icon"><path d="M2.5 7L5.5 10L11.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" className="btn-icon">
                  <path d="M1.5,1.5 H9 L12.5,5 V12.5 H1.5 Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/>
                  <rect x="3.5" y="1.5" width="4" height="3" rx="0.5" stroke="currentColor" strokeWidth="1"/>
                  <rect x="2.5" y="8" width="9" height="3.5" rx="0.5" stroke="currentColor" strokeWidth="1"/>
                </svg>
              )}
              <span className="btn-label">
                {isSaving ? ' Saving…' : saveFlash ? ' Saved!' : ' Save Layout'}
              </span>
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

          {/* Paint Wall button — only shown when a wall photo exists */}
          {activeWallImage && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => { setEditingLayerId(null); setShowPaintModal(true) }}
              title="Add a new paint layer"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" className="btn-icon">
                <path d="M2 12c1-1 2-2.5 4-3.5L10.5 4 10 3.5 5.5 8C4 9 3 10 2 12z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" fill="currentColor" fillOpacity="0.15"/>
                <circle cx="10.5" cy="3.5" r="1.5" stroke="currentColor" strokeWidth="1.25"/>
                {activePaintLayers.some(l => l.visible) && <circle cx="12" cy="12" r="1.5" fill="currentColor"/>}
              </svg>
              <span className="btn-label"> Paint Wall</span>
            </button>
          )}

          {/* Erase Object button — only shown when a wall photo exists */}
          {activeWallImage && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setShowEraseWall(true)}
              title="Erase an object from the wall photo using content-aware fill"
            >
              <svg width="14" height="14" viewBox="32 7 33 33" xmlns="http://www.w3.org/2000/svg" className="btn-icon">
                {/* Tiny corner of pencil body — lightest fill */}
                <polyline fill="currentColor" fillOpacity="0.2" stroke="none" points="18.0381,41.8761 36.8684,23.0457 48.1813,34.3586 29.5108,53.0291"/>
                {/* Eraser cap — most prominent */}
                <polyline fill="currentColor" fillOpacity="0.55" stroke="none" points="42.9209,16.9933 50.4228,9.4913 61.7357,20.8042 54.2975,28.2424"/>
                {/* Ferrule band — mid opacity */}
                <polyline fill="currentColor" fillOpacity="0.35" stroke="none" points="35.6498,24.2643 43.3318,16.5823 54.6447,27.8952 47.0278,35.512"/>
                {/* Outline */}
                <polygon fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeMiterlimit="10" strokeWidth="2" points="18.6304,56.8203 27.8278,53.2939 53.8207,27.301 43.9212,17.4015 17.9281,43.3946 14.3904,52.6032"/>
                <polyline fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeMiterlimit="10" strokeWidth="2" points="47.3354,13.9873 50.8388,10.4839 60.7383,20.3834 57.2645,23.8572"/>
                <line x1="36.9099" x2="46.4225" y1="25.0073" y2="34.5199" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeMiterlimit="10" strokeWidth="2"/>
                {activeWallEraseHistory.length > 0 && <circle cx="65" cy="7" r="3.5" fill="currentColor"/>}
              </svg>
              <span className="btn-label"> Erase Object</span>
            </button>
          )}

          <button
            className={`btn btn-ghost btn-sm ${!activeWallImage ? 'btn-calibrate-pulse' : ''}`}
            data-tutorial="header-calibrate"
            onClick={() => openSetup()}
            title={activeWallImage ? 'Re-calibrate wall perspective' : 'Calibrate wall perspective'}
          >
            {activeWallImage ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" className="btn-icon"><circle cx="7" cy="7" r="2" stroke="currentColor" strokeWidth="1.5"/><path d="M7 1v2M7 11v2M1 7h2M11 7h2M2.93 2.93l1.41 1.41M9.66 9.66l1.41 1.41M2.93 11.07l1.41-1.41M9.66 4.34l1.41-1.41" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" className="btn-icon"><rect x="1" y="4" width="12" height="7" rx="1" stroke="currentColor" strokeWidth="1.5"/><path d="M4 4V3a1 1 0 011-1h4a1 1 0 011 1v1" stroke="currentColor" strokeWidth="1.5"/><path d="M4.5 7.5h5M4.5 9.5h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            )}<span className="btn-label"> {activeWallImage ? 'Recalibrate' : 'Calibrate Wall'}</span>
          </button>
          <button className="btn btn-primary" data-tutorial="header-add-piece" onClick={() => setShowAddModal(true)}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg" className="btn-icon"><path d="M6.5 1.5v10M1.5 6.5h10" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"/></svg>
            <span className="btn-label"> Add Piece</span>
          </button>
          <div data-tutorial="header-login">
            <UserBadge
              user={authUser}
              onLoginClick={() => setShowAuth(true)}
              onLogout={handleLogout}
            />
          </div>
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
          unitSystem={unitSystem}
          onUnitSystemChange={(u) => {
            setUnitSystem(u)
            localStorage.setItem('gwp-unit-system', u)
            setGridSize(DEFAULT_SNAP[u])
          }}
          snapToGrid={snapToGrid}
          onSnapToggle={() => setSnapToGrid(s => !s)}
          gridSize={gridSize}
          onGridSizeChange={setGridSize}
          layouts={wallLayouts}
          wallName={activeWall?.name}
          currentLayout={currentLayout}
          onSaveLayout={saveLayout}
          saveFlash={saveFlash}
          onLoadLayout={loadLayout}
          onDeleteLayout={deleteLayout}
          onAddPiece={() => setShowAddModal(true)}
          onClearAll={() => { setPieces([]); setSelectedId(null) }}
          paintLayers={activePaintLayers}
          onTogglePaintLayer={togglePaintLayer}
          onDeletePaintLayer={deletePaintLayer}
          onRenamePaintLayer={renamePaintLayer}
          onEditPaintLayer={(layerId) => { setEditingLayerId(layerId); setShowPaintModal(true) }}
          onNewPaintLayer={() => { if (!activeWallImage) return; setEditingLayerId(null); setShowPaintModal(true) }}
          hasWallImage={Boolean(activeWallImage)}
          eraseHistory={activeWallEraseHistory}
          onRemoveErase={(eraseId) => handleRemoveErase(activeWallId, eraseId)}
          onToggleEraseVisible={(eraseId) => handleToggleEraseVisible(activeWallId, eraseId)}
          onOpenErase={() => { if (activeWallEffectiveImage) setShowEraseWall(true) }}
          library={library}
          onAddFromLibrary={addPieceFromLibrary}
          onDeleteFromLibrary={deleteFromLibrary}
          isOpen={sidebarOpen}
          onRequestClose={() => setSidebarOpen(false)}
          forceSection={sidebarForceSection}
          hasUnsavedChanges={hasUnsavedChanges}
          onDiscardChanges={discardChanges}
        />

        <Wall
          pieces={pieces}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onMove={handleMove}
          onResize={handleResize}
          onDeselect={() => setSelectedId(null)}
          unitSystem={unitSystem}
          snapToGrid={snapToGrid}
          gridSize={gridSize}
          wallWidth={activeWall?.width || 120}
          wallHeight={activeWall?.height || 96}
          wallImage={activeWallEffectiveImage}
          paintLayers={activePaintLayers.filter(l => l.visible)}
          onCalibrate={openSetup}
          onUndo={handleUndo}
          canUndo={historyStack.length > 0}
          onLockToggle={handleLockToggle}
          onMoveStart={pushHistory}
          onResizeStart={pushHistory}
          onStartTutorial={handleStartTutorial}
          tipsEnabled={tipsEnabled}
          onToggleTips={handleToggleTips}
          tutorialActive={tutorialStep !== null}
          tutorialShowLock={tutorialStep === TUTORIAL_LOCK_STEP}
        />
      </div>

      {showSetup && (
        <WallSetup
          onApply={handleWallCalibrated}
          onClose={() => { setShowSetup(false); setSetupWallId(null); calibWallIdRef.current = null }}
          wallName={calibWall?.name || 'Wall'}
          wallWidth={calibWall?.width || 120}
          wallHeight={calibWall?.height || 96}
          existingImageUrl={calibWall?.imageUrl || null}
          unitSystem={unitSystem}
        />
      )}

      {showWallMgr && (
        <WallManager
          walls={walls}
          wallImages={wallImages}
          allLayouts={allLayouts}
          rooms={rooms}
          activeWallId={activeWallId}
          onSelect={handleSelectWall}
          onCreate={handleCreateWall}
          onDelete={handleDeleteWall}
          onRename={handleRenameWall}
          onSetupWall={(id) => openSetup(id)}
          onClose={() => setShowWallMgr(false)}
          unitSystem={unitSystem}
          onUnitSystemChange={(u) => {
            setUnitSystem(u)
            localStorage.setItem('gwp-unit-system', u)
            setGridSize(DEFAULT_SNAP[u])
          }}
        />
      )}

      {showAddModal && (
        <AddPieceModal
          piece={editingPiece}
          onSubmit={handleModalSubmit}
          onClose={closeModal}
          unitSystem={unitSystem}
        />
      )}

      {showPaintModal && (
        <PaintModal
          wallImage={activeWallImage}
          initialColor={(wallPaintLayers[activeWallId]?.[editingLayerId])?.color || '#C4875A'}
          initialMask={(wallPaintLayers[activeWallId]?.[editingLayerId])?.maskDataUrl || null}
          existingLayers={activePaintLayers.filter(l => l.id !== editingLayerId && l.maskDataUrl)}
          onApply={handlePaintApply}
          onClose={() => { setShowPaintModal(false); setEditingLayerId(null) }}
        />
      )}

      {showEraseWall && activeWallEffectiveImage && (
        <EraseModal
          imageUrl={activeWallEffectiveImage}
          title={`Erase — ${activeWall?.name || 'Wall'}`}
          onApply={handleWallEraseApply}
          onClose={() => setShowEraseWall(false)}
        />
      )}

      {showAuth && (
        <AuthModal
          onSuccess={handleAuthSuccess}
          onClose={() => { setShowAuth(false); setResetToken(null) }}
          resetToken={resetToken}
        />
      )}

      {/* ── 3D Room modals ─────────────────────────────────────────────── */}
      {showRoomMgr && (
        <RoomManager
          rooms={rooms}
          activeRoomId={activeRoomId}
          onSelect={setActiveRoomId}
          onView3D={handleViewRoom}
          onSetupRoom={({ name }) => {
            setNewRoomName(name)
            setEditingRoomId(null)
            setShowRoomWizard(true)
            setShowRoomMgr(false)
          }}
          onEditRoom={(roomId) => {
            setEditingRoomId(roomId)
            setShowRoomWizard(true)
            setShowRoomMgr(false)
          }}
          onDelete={handleDeleteRoom}
          onClose={() => setShowRoomMgr(false)}
          unitSystem={unitSystem}
        />
      )}

      {showRoomWizard && (
        <RoomSetupWizard
          key={editingRoomId || 'new-room'}
          existingRoom={editingRoomId ? rooms[editingRoomId] : null}
          initialRoomName={editingRoomId ? undefined : newRoomName}
          onSave={handleSaveRoom}
          onClose={() => {
            setShowRoomWizard(false)
            setEditingRoomId(null)
            // If we were editing from 3D viewer, re-open it
            if (activeRoomId && rooms[activeRoomId]) setShowRoomView(true)
          }}
          unitSystem={unitSystem}
        />
      )}

      {showRoomView && activeRoomId && rooms[activeRoomId] && (
        <div className="room-viewer-overlay">
          <Room3DViewer
            room={rooms[activeRoomId]}
            onEditFace={handleEditRoomFace}
            onClose={() => setShowRoomView(false)}
          />
        </div>
      )}

      {showSpaceMgr && (
        <SpacesManager
          spaces={rooms}
          onEdit={(id) => {
            setEditingSpaceId(id)
            setShowSpaceBuilder(true)
            setShowSpaceMgr(false)
          }}
          onDelete={handleDeleteSpace}
          onNew={() => {
            setEditingSpaceId(null)
            setShowSpaceBuilder(true)
            setShowSpaceMgr(false)
          }}
          onClose={() => setShowSpaceMgr(false)}
        />
      )}

      {showSpaceBuilder && (
        <SpaceBuilder
          key={editingSpaceId || 'new-space'}
          existingSpace={editingSpaceId ? rooms[editingSpaceId] : null}
          library={library}
          allLayouts={allLayouts}
          walls={walls}
          rooms={rooms}
          onSave={handleSaveSpace}
          onClose={() => { setShowSpaceBuilder(false); setEditingSpaceId(null) }}
        />
      )}

      {/* Tutorial + Tips overlay — renders above everything else */}
      <Tutorial
        tutorialStep={tutorialStep}
        onNext={handleTutorialNext}
        onBack={handleTutorialBack}
        onSkip={handleTutorialSkip}
        tipsEnabled={tipsEnabled}
        showAddModal={showAddModal}
        pieces={pieces}
        walls={walls}
        activeWallId={activeWallId}
        activeWallImage={activeWallImage}
        currentLayout={currentLayout}
        wallLayouts={wallLayouts}
        onSidebarSection={(sec) => {
          setSidebarOpen(true)
          setSidebarForceSection(sec)
          // Clear force after a tick so user can freely switch tabs afterwards
          setTimeout(() => setSidebarForceSection(null), 600)
        }}
      />
    </div>
  )
}
