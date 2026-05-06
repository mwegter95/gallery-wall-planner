/**
 * SpaceBuilder — Interactive freeform room/space builder.
 *
 * Layout:
 *   Left (65%):  SpaceBuilderCanvas — photos + surface warp handles
 *   Right (35%): Surface panel — name, W×H, connections, z-order, delete
 *   Header:      Space name, Add Photo, Stitch Seams, Erase Object, Save, Close
 */
import { useState, useCallback, useRef, useEffect } from 'react'
import SpaceBuilderCanvas from './SpaceBuilderCanvas'
import EraseModal from './EraseModal'
import {
  createSpace, createPhoto, createSurfaceDef, genId,
  warpSurface, createSurfaceLayout, createSurfacePiece, SURFACE_COLORS,
  getEffectiveSurfaceUrl,
} from '../utils/spaceAssembler'
import { warpPerspectiveAsync } from '../utils/homography'

const EDGES = ['left', 'right', 'top', 'bottom']

const MAX_HISTORY = 50
// Properties that count as "moveable" actions worth undo-ing
const HISTORY_KEYS = new Set(['pose3d', 'rotYDeg', 'widthIn', 'heightIn'])

export default function SpaceBuilder({ existingSpace, onSave, onClose, library = {}, allLayouts = {}, walls = {}, rooms = {} }) {
  const [space, setSpace]                 = useState(() => existingSpace
    ? JSON.parse(JSON.stringify(existingSpace))
    : createSpace()
  )
  const [activeSurfaceId, setActiveSurfaceId] = useState(null)
  const [isStitching,     setIsStitching]     = useState(false)
  const [stitchProgress,  setStitchProgress]  = useState(0)
  const [stitchStatus,    setStitchStatus]    = useState('')
  const [isSaving,        setIsSaving]        = useState(false)
  const [isDragOver,      setIsDragOver]      = useState(false)
  // Save Room popover
  const [showSaveMenu,    setShowSaveMenu]    = useState(false)
  const [saveAsName,      setSaveAsName]      = useState('')
  const saveMenuRef = useRef(null)
  // Room selector + unsaved-changes guard
  const [pendingRoomId,   setPendingRoomId]   = useState(null) // room to switch to (null = none pending)
  const [savedSnapshot,   setSavedSnapshot]   = useState(() =>
    existingSpace ? JSON.stringify(existingSpace.surfaces) : '[]'
  )
  // Layout management state (scoped to active surface)
  const [layoutNameInput, setLayoutNameInput] = useState('')
  const [showLibPicker,   setShowLibPicker]   = useState(false)
  // Wall-layout picker: which wall is expanded in the "Load from wall" section
  const [pickerWallId,    setPickerWallId]    = useState('')
  const [showEraseModal,  setShowEraseModal]  = useState(false)
  // Mobile panel overlay
  const [showMobilePanel, setShowMobilePanel] = useState(false)
  const [cropRequestId,   setCropRequestId]   = useState(null)
  // Undo / redo
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const historyRef   = useRef({ stack: [], index: -1, timer: null })
  const fileInputRef  = useRef(null)
  const warpQueueRef  = useRef(new Set())

  // Detect unsaved changes by comparing current surfaces to saved snapshot
  const hasUnsavedChanges = JSON.stringify(space.surfaces) !== savedSnapshot

  // Close save menu on outside click
  useEffect(() => {
    function onOutside(e) {
      if (saveMenuRef.current && !saveMenuRef.current.contains(e.target)) setShowSaveMenu(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [])

  const activeSurface = space.surfaces.find(s => s.id === activeSurfaceId)

  // ── History helpers ───────────────────────────────────────────────────────
  // Initialize history once with current surfaces snapshot
  useEffect(() => {
    const h = historyRef.current
    if (h.stack.length === 0) {
      h.stack = [JSON.parse(JSON.stringify(space.surfaces))]
      h.index = 0
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function recordHistory(surfaces) {
    const h = historyRef.current
    if (h.timer) clearTimeout(h.timer)
    h.timer = setTimeout(() => {
      h.timer = null
      // Truncate any forward (redo) history, push new snapshot, cap at MAX_HISTORY
      h.stack = [...h.stack.slice(0, h.index + 1), JSON.parse(JSON.stringify(surfaces))].slice(-MAX_HISTORY)
      h.index = h.stack.length - 1
      setCanUndo(h.index > 0)
      setCanRedo(false)
    }, 350)
  }

  function undo() {
    const h = historyRef.current
    // Flush any pending record so undo targets the most recent committed state
    if (h.timer) { clearTimeout(h.timer); h.timer = null }
    if (h.index <= 0) return
    h.index--
    const snapshot = h.stack[h.index]
    setSpace(prev => ({ ...prev, surfaces: JSON.parse(JSON.stringify(snapshot)) }))
    setCanUndo(h.index > 0)
    setCanRedo(true)
  }

  function redo() {
    const h = historyRef.current
    if (h.timer) { clearTimeout(h.timer); h.timer = null }
    if (h.index >= h.stack.length - 1) return
    h.index++
    const snapshot = h.stack[h.index]
    setSpace(prev => ({ ...prev, surfaces: JSON.parse(JSON.stringify(snapshot)) }))
    setCanUndo(true)
    setCanRedo(h.index < h.stack.length - 1)
  }

  // Keyboard shortcuts: Ctrl+Z = undo, Ctrl+Y / Ctrl+Shift+Z = redo
  useEffect(() => {
    function onKey(e) {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      else if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) { e.preventDefault(); redo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Space / photo mutations ───────────────────────────────────────────────
  const updateSurface = useCallback((surfaceId, update) => {
    setSpace(prev => {
      const newSurfaces = prev.surfaces.map(s => s.id === surfaceId ? { ...s, ...update } : s)
      // Only push to history for spatial/size changes (not warp results, layout changes, etc.)
      if (Object.keys(update).some(k => HISTORY_KEYS.has(k))) {
        recordHistory(newSurfaces)
      }
      return { ...prev, surfaces: newSurfaces }
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const updatePhoto = useCallback((photoId, update) => {
    setSpace(prev => ({
      ...prev,
      photos: prev.photos.map(p => p.id === photoId ? { ...p, ...update } : p),
    }))
  }, [])

  // Auto-warp any surface that has a photo but no warped image yet
  useEffect(() => {
    const toWarp = space.surfaces.filter(
      s => !s.warpedDataUrl && s.photoId && !warpQueueRef.current.has(s.id)
    )
    for (const surface of toWarp) {
      const photo = space.photos.find(p => p.id === surface.photoId)
      if (!photo) continue
      warpQueueRef.current.add(surface.id)
      warpSurface(surface, photo.dataUrl, photo.displayW, photo.displayH, warpPerspectiveAsync)
        .then(url => updateSurface(surface.id, { warpedDataUrl: url, stitchedDataUrl: null }))
        .catch(err => {
          warpQueueRef.current.delete(surface.id)
          console.error('[SpaceBuilder] Auto-warp failed:', err)
        })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space.surfaces, space.photos])

  const addPhotoFromFile = useCallback((file) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = e => {
      const dataUrl = e.target.result
      const img = new Image()
      img.onload = () => {
        const displayW = Math.min(680, img.naturalWidth)
        const displayH = Math.round(displayW * img.naturalHeight / img.naturalWidth)
        // Generate stable IDs outside the updater so React Strict Mode double-runs
        // don't cause mismatched surface IDs between the warp callback and state
        const photoId   = genId()
        const surfaceId = genId()
        setSpace(prev => {
          const photo   = createPhoto({ dataUrl, displayW, displayH, index: prev.photos.length })
          const surface = createSurfaceDef({ photoId: photo.id, index: prev.surfaces.length })
          return {
            ...prev,
            photos:   [...prev.photos,   { ...photo,   id: photoId }],
            surfaces: [...prev.surfaces, { ...surface, id: surfaceId, photoId }],
          }
        })
        setActiveSurfaceId(surfaceId)
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  }, [])

  const handleAddPhotoClick = () => fileInputRef.current?.click()

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files || [])
    files.forEach(f => addPhotoFromFile(f))
    e.target.value = ''
  }

  const handleDragOver = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    const hasImages = Array.from(e.dataTransfer.items || []).some(
      item => item.kind === 'file' && item.type.startsWith('image/')
    )
    if (hasImages) {
      e.dataTransfer.dropEffect = 'copy'
      setIsDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e) => {
    // Only clear when leaving the modal itself (not child elements)
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setIsDragOver(false)
    }
  }, [])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    const files = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith('image/'))
    files.forEach(f => addPhotoFromFile(f))
  }, [addPhotoFromFile])

  const addSurfaceOnPhoto = useCallback((photoId) => {
    setSpace(prev => {
      const surface = createSurfaceDef({ photoId, index: prev.surfaces.length })
      setActiveSurfaceId(surface.id)
      return { ...prev, surfaces: [...prev.surfaces, surface] }
    })
  }, [])

  const deleteSurface = useCallback((surfaceId) => {
    setSpace(prev => ({
      ...prev,
      // Remove the surface and clean up any connections pointing to it
      surfaces: prev.surfaces
        .filter(s => s.id !== surfaceId)
        .map(s => {
          const conns = { ...s.connections }
          for (const edge of EDGES) {
            if (conns[edge]?.surfaceId === surfaceId) conns[edge] = null
          }
          return { ...s, connections: conns }
        }),
    }))
    setActiveSurfaceId(id => id === surfaceId ? null : id)
  }, [])

  // ── Connection helpers ────────────────────────────────────────────────────
  const setConnection = useCallback((surfaceId, edge, value) => {
    updateSurface(surfaceId, {
      connections: { ...space.surfaces.find(s => s.id === surfaceId)?.connections, [edge]: value },
    })
  }, [space.surfaces, updateSurface])

  // ── Layout management (per surface) ──────────────────────────────────────
  const saveSurfaceLayout = useCallback((surfaceId, name) => {
    const surface = space.surfaces.find(s => s.id === surfaceId)
    if (!surface || !name.trim()) return
    // Preserve existing pieces if the layout already exists, otherwise start empty
    const existing = surface.layouts?.[name] || createSurfaceLayout(name)
    updateSurface(surfaceId, {
      layouts:      { ...surface.layouts, [name]: existing },
      activeLayout: name,
    })
    setLayoutNameInput('')
  }, [space.surfaces, updateSurface])

  const loadSurfaceLayout = useCallback((surfaceId, name) => {
    updateSurface(surfaceId, { activeLayout: name })
  }, [updateSurface])

  const deleteSurfaceLayout = useCallback((surfaceId, name) => {
    const surface = space.surfaces.find(s => s.id === surfaceId)
    if (!surface) return
    const next = { ...surface.layouts }
    delete next[name]
    updateSurface(surfaceId, {
      layouts:      next,
      activeLayout: surface.activeLayout === name ? '' : surface.activeLayout,
    })
  }, [space.surfaces, updateSurface])

  // Load a layout from the main app's allLayouts into this surface
  const loadWallLayout = useCallback((surfaceId, name, layoutData) => {
    const surface = space.surfaces.find(s => s.id === surfaceId)
    if (!surface) return
    const { pieces = [], paintLayerIds = [] } = layoutData
    updateSurface(surfaceId, {
      layouts:      { ...surface.layouts, [name]: { pieces, paintLayerIds } },
      activeLayout: name,
    })
  }, [space.surfaces, updateSurface])

  const addPieceToLayout = useCallback((surfaceId, libItem) => {
    const surface = space.surfaces.find(s => s.id === surfaceId)
    if (!surface) return
    const layoutName = surface.activeLayout || 'Default'
    const existing   = surface.layouts?.[layoutName] || { pieces: [], paintLayerIds: [] }
    const newPiece   = createSurfacePiece(libItem, surface)
    updateSurface(surfaceId, {
      layouts:      { ...surface.layouts, [layoutName]: { ...existing, pieces: [...existing.pieces, newPiece] } },
      activeLayout: layoutName,
    })
  }, [space.surfaces, updateSurface])

  const removePieceFromLayout = useCallback((surfaceId, pieceId) => {
    const surface = space.surfaces.find(s => s.id === surfaceId)
    if (!surface?.activeLayout) return
    const existing = surface.layouts?.[surface.activeLayout]
    if (!existing) return
    updateSurface(surfaceId, {
      layouts: {
        ...surface.layouts,
        [surface.activeLayout]: { ...existing, pieces: existing.pieces.filter(p => p.id !== pieceId) },
      },
    })
  }, [space.surfaces, updateSurface])

  // ── Stitch Seams ──────────────────────────────────────────────────────────
  const handleStitch = async () => {
    if (isStitching || space.surfaces.length < 2) return
    setIsStitching(true)
    setStitchProgress(0)
    try {
      const { stitchSeams } = await import('../utils/seamBlend')
      const results = await stitchSeams(
        space.surfaces,
        (pct, status) => { setStitchProgress(pct); if (status) setStitchStatus(status) },
      )
      if (results.size > 0) {
        setSpace(prev => ({
          ...prev,
          surfaces: prev.surfaces.map(s =>
            results.has(s.id) ? { ...s, stitchedDataUrl: results.get(s.id) } : s
          ),
        }))
      }
    } catch (err) {
      console.error('[SpaceBuilder] Stitch seams failed:', err)
    } finally {
      setIsStitching(false)
      setStitchProgress(0)
      setStitchStatus('')
    }
  }

  // ── Erase / content-aware fill ────────────────────────────────────────────
  function handleEraseApply(newDataUrl) {
    if (!activeSurfaceId) return
    // Store as inpaintDataUrl — a non-destructive layer on top of warpedDataUrl/stitchedDataUrl.
    // warpedDataUrl and stitchedDataUrl are preserved so seam-blending can be re-run later.
    // The inpaint result is the top-most base layer; pieces and paint composite above it.
    updateSurface(activeSurfaceId, { inpaintDataUrl: newDataUrl })
  }

  // ── Save ─────────────────────────────────────────────────────────────────
  const handleSave = async (overrideName) => {
    const nameToUse = (overrideName || space.name).trim()
    if (!nameToUse) return
    const spaceToSave = overrideName
      ? { ...space, id: genId(), name: overrideName }  // save-as-new: fresh id + new name
      : space
    setIsSaving(true)
    setShowSaveMenu(false)
    setSaveAsName('')
    try {
      await onSave(spaceToSave)
      setSavedSnapshot(JSON.stringify(spaceToSave.surfaces))
      // If saved as new, switch to that space
      if (overrideName) setSpace(spaceToSave)
    } finally {
      setIsSaving(false)
    }
  }

  // ── Load a different room ────────────────────────────────────────────────
  const doLoadRoom = (roomId) => {
    const room = rooms[roomId]
    if (!room) return
    setSpace(JSON.parse(JSON.stringify(room)))
    setSavedSnapshot(JSON.stringify(room.surfaces))
    setActiveSurfaceId(null)
    warpQueueRef.current = new Set()
    const h = historyRef.current
    h.stack = [JSON.parse(JSON.stringify(room.surfaces))]
    h.index = 0
    setCanUndo(false)
    setCanRedo(false)
    setPendingRoomId(null)
  }

  const handleRoomSelect = (roomId) => {
    if (roomId === space.id) return
    if (hasUnsavedChanges) {
      setPendingRoomId(roomId)   // show guard modal
    } else {
      doLoadRoom(roomId)
    }
  }

  // ── Surface panel content ─────────────────────────────────────────────────
  function renderSurfacePanel() {
    if (!activeSurface) {
      return (
        <div className="sb-panel-empty">
          <p>Select a surface on the canvas to edit it</p>
          <p className="sb-panel-empty-sub">or click <strong>+ Surface</strong> in a photo header</p>
        </div>
      )
    }

    const color = SURFACE_COLORS[activeSurface.colorIdx ?? 0]
    const otherSurfaces = space.surfaces.filter(s => s.id !== activeSurface.id)

    return (
      <div className="sb-surface-editor">
        {/* Color swatch + name */}
        <div className="sb-se-row sb-se-name-row">
          <div className="sb-se-color-dot" style={{ background: color }} />
          <input
            className="sb-se-name-input"
            value={activeSurface.name}
            onChange={e => updateSurface(activeSurface.id, { name: e.target.value })}
            placeholder="Surface name…"
          />
          <button
            className="sb-se-delete-btn"
            onClick={() => deleteSurface(activeSurface.id)}
            title="Delete surface"
          >✕</button>
        </div>

        {/* Dimensions */}
        <div className="sb-se-row sb-se-dims-row">
          <label className="sb-se-label">Width</label>
          <input
            className="sb-se-dim-input"
            type="number" min="1" max="9999"
            value={activeSurface.widthIn}
            onChange={e => updateSurface(activeSurface.id, { widthIn: Number(e.target.value) })}
          />
          <span className="sb-se-unit">″</span>
          <label className="sb-se-label sb-se-label--gap">Height</label>
          <input
            className="sb-se-dim-input"
            type="number" min="1" max="9999"
            value={activeSurface.heightIn}
            onChange={e => updateSurface(activeSurface.id, { heightIn: Number(e.target.value) })}
          />
          <span className="sb-se-unit">″</span>
        </div>

        {/* 3D rotation */}
        <div className="sb-se-row sb-se-rot-row">
          <label className="sb-se-label">Wall angle</label>
          <input
            type="range" min="-180" max="180" step="1"
            className="sb-se-rot-slider"
            value={activeSurface.rotYDeg ?? 0}
            onChange={e => updateSurface(activeSurface.id, { rotYDeg: Number(e.target.value) })}
          />
          <span className="sb-se-unit sb-se-rot-val">{activeSurface.rotYDeg ?? 0}°</span>
        </div>

        {/* Photo assignment */}
        <div className="sb-se-row">
          <label className="sb-se-label">Photo</label>
          <select
            className="sb-se-select"
            value={activeSurface.photoId || ''}
            onChange={e => updateSurface(activeSurface.id, { photoId: e.target.value || null })}
          >
            <option value="">— none —</option>
            {space.photos.map((p, i) => (
              <option key={p.id} value={p.id}>Photo {i + 1}</option>
            ))}
          </select>
        </div>

        {/* Perspective Warp button */}
        <button
          className="sb-se-rewarp-btn"
          onClick={() => {
            setCropRequestId(activeSurface.id + '_' + Date.now()) // new value each click
            setShowMobilePanel(false) // close panel so overlay is visible
          }}
          disabled={!activeSurface?.photoId}
          title="Open the perspective warp corner editor for this surface"
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M2 4L5 2h6v7l-2 2H3L1 9V4l1-1" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
            <path d="M4 5l1-1M9 5l-1-1M4 8l1 1M9 8l-1 1" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
          </svg>
          Perspective Warp
        </button>

        {/* ── Load Layout from Wall ────────────────────────────── */}
        {(() => {
          // Collect all walls that have at least one saved layout
          const wallsWithLayouts = Object.entries(allLayouts).filter(([, wl]) => Object.keys(wl).length > 0)
          if (wallsWithLayouts.length === 0) return null

          const pickerLayouts = pickerWallId ? (allLayouts[pickerWallId] || {}) : {}

          return (
            <div className="sb-wall-layouts">
              <div className="sb-se-section-title">Load Layout from Wall</div>
              {/* Step 1: pick a wall */}
              <select
                className="sb-se-select"
                value={pickerWallId}
                onChange={e => setPickerWallId(e.target.value)}
              >
                <option value="">— pick a wall —</option>
                {wallsWithLayouts.map(([wallId, wl]) => {
                  const wallName = walls[wallId]?.name || `Wall ${wallId.slice(0, 6)}`
                  return (
                    <option key={wallId} value={wallId}>
                      {wallName} ({Object.keys(wl).length} layout{Object.keys(wl).length !== 1 ? 's' : ''})
                    </option>
                  )
                })}
              </select>

              {/* Step 2: pick a layout from that wall */}
              {pickerWallId && Object.keys(pickerLayouts).length > 0 && (
                <div className="sb-layout-list" style={{ marginTop: 6 }}>
                  {Object.entries(pickerLayouts).map(([name, data]) => {
                    const pieces = Array.isArray(data) ? data : (data?.pieces || [])
                    const isActive = name === activeSurface.activeLayout
                    return (
                      <div key={name} className={`sb-layout-row${isActive ? ' sb-layout-row--active' : ''}`}>
                        <span className="sb-layout-row-name">{name}</span>
                        <span className="sb-layout-row-count">{pieces.length}p</span>
                        <div className="sb-layout-row-actions">
                          <button
                            className="btn btn-ghost btn-xs"
                            onClick={() => {
                              loadWallLayout(activeSurface.id, name, data)
                              setPickerWallId('')
                            }}
                          >{isActive ? '✓ Active' : 'Load'}</button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })()}

        {/* ── Surface-local Layouts ────────────────────────────── */}
        <div className="sb-se-section-title">Layouts</div>

        {/* Save / create layout */}
        <div className="sb-layout-save-row">
          <input
            className="sb-layout-name-input"
            placeholder="Layout name…"
            value={layoutNameInput}
            onChange={e => setLayoutNameInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && saveSurfaceLayout(activeSurface.id, layoutNameInput)}
          />
          <button
            className="btn btn-sm btn-primary"
            disabled={!layoutNameInput.trim()}
            onClick={() => saveSurfaceLayout(activeSurface.id, layoutNameInput)}
          >Save</button>
        </div>

        {/* Saved layouts list */}
        {Object.keys(activeSurface.layouts || {}).length > 0 && (
          <div className="sb-layout-list">
            {Object.keys(activeSurface.layouts).map(name => {
              const isActive = name === activeSurface.activeLayout
              const count    = activeSurface.layouts[name]?.pieces?.length || 0
              return (
                <div key={name} className={`sb-layout-row${isActive ? ' sb-layout-row--active' : ''}`}>
                  <span className="sb-layout-row-name">{name}</span>
                  <span className="sb-layout-row-count">{count} piece{count !== 1 ? 's' : ''}</span>
                  <div className="sb-layout-row-actions">
                    {!isActive && (
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => loadSurfaceLayout(activeSurface.id, name)}
                      >Load</button>
                    )}
                    <button
                      className="btn btn-ghost btn-xs sb-layout-del-btn"
                      onClick={() => deleteSurfaceLayout(activeSurface.id, name)}
                    >✕</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Art pieces in active layout */}
        {activeSurface.activeLayout && activeSurface.layouts?.[activeSurface.activeLayout] && (
          <div className="sb-pieces-section">
            <div className="sb-pieces-header">
              <span>Art in "{activeSurface.activeLayout}"</span>
              <button
                className="btn btn-sm btn-primary"
                onClick={() => setShowLibPicker(v => !v)}
              >+ Add piece</button>
            </div>

            {/* Library picker */}
            {showLibPicker && (
              <div className="sb-lib-picker">
                {Object.keys(library).length === 0 && (
                  <p className="sb-lib-empty">No library pieces yet. Add art from the main wall first.</p>
                )}
                <div className="sb-lib-grid">
                  {Object.values(library).map(item => (
                    <button
                      key={item.id}
                      className="sb-lib-item"
                      title={`${item.name} — ${item.width}″ × ${item.height}″`}
                      onClick={() => { addPieceToLayout(activeSurface.id, item); setShowLibPicker(false) }}
                    >
                      {item.image
                        ? <img src={item.image} alt={item.name} className="sb-lib-item-img" />
                        : <div className="sb-lib-item-color" style={{ background: item.color || '#555' }} />
                      }
                      <span className="sb-lib-item-name">{item.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Placed pieces */}
            {(activeSurface.layouts[activeSurface.activeLayout].pieces || []).length === 0 && !showLibPicker && (
              <p className="sb-pieces-empty">No pieces yet. Click "+ Add piece" to place art.</p>
            )}
            <div className="sb-pieces-list">
              {(activeSurface.layouts[activeSurface.activeLayout].pieces || []).map(piece => (
                <div key={piece.id} className="sb-piece-row">
                  <div className="sb-piece-thumb">
                    {piece.image
                      ? <img src={piece.image} alt="" className="sb-piece-thumb-img" />
                      : <div className="sb-piece-thumb-color" style={{ background: piece.color || '#555' }} />
                    }
                  </div>
                  <div className="sb-piece-info">
                    <span className="sb-piece-name">{piece.name}</span>
                    <span className="sb-piece-dims">{piece.width}″ × {piece.height}″</span>
                  </div>
                  <button
                    className="sb-piece-del-btn"
                    title="Remove from layout"
                    onClick={() => removePieceFromLayout(activeSurface.id, piece.id)}
                  >✕</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="sb-backdrop">
      {showEraseModal && activeSurface && (
        <EraseModal
          imageUrl={getEffectiveSurfaceUrl(activeSurface)}
          title={`Erase — ${activeSurface.name}`}
          onApply={handleEraseApply}
          onClose={() => setShowEraseModal(false)}
        />
      )}
      <div
        className={`sb-modal${isDragOver ? ' sb-modal--drag-over' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* ── Unsaved-changes guard modal ──────────────────────────────────── */}
        {pendingRoomId && (
          <div className="sb-guard-backdrop">
            <div className="sb-guard-modal">
              <div className="sb-guard-icon">
                <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                  <circle cx="16" cy="16" r="15" stroke="#f59e0b" strokeWidth="1.5"/>
                  <path d="M16 9v9M16 21v2" stroke="#f59e0b" strokeWidth="2.2" strokeLinecap="round"/>
                </svg>
              </div>
              <div className="sb-guard-title">Unsaved changes</div>
              <div className="sb-guard-body">
                You have unsaved changes to <strong>{space.name}</strong>. What would you like to do before switching rooms?
              </div>
              <div className="sb-guard-actions">
                <button className="sb-guard-btn sb-guard-btn--back" onClick={() => setPendingRoomId(null)}>
                  Go Back
                </button>
                <button className="sb-guard-btn sb-guard-btn--save" onClick={async () => {
                  await handleSave()
                  doLoadRoom(pendingRoomId)
                }} disabled={isSaving}>
                  {isSaving ? 'Saving…' : 'Save Room'}
                </button>
                <button className="sb-guard-btn sb-guard-btn--saveas" onClick={() => {
                  // prompt for new name via saveAs flow then load
                  const name = window.prompt('Save current room as:', space.name + ' copy')
                  if (name?.trim()) handleSave(name.trim()).then(() => doLoadRoom(pendingRoomId))
                }} disabled={isSaving}>
                  Save as New
                </button>
                <button className="sb-guard-btn sb-guard-btn--discard" onClick={() => doLoadRoom(pendingRoomId)}>
                  Discard & Switch
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="sb-header">
          <div className="sb-header-left">
            {/* Room selector dropdown */}
            {Object.keys(rooms).length > 0 && (
              <select
                className="sb-room-select"
                value={space.id}
                onChange={e => handleRoomSelect(e.target.value)}
                title="Switch room"
              >
                {!rooms[space.id] && (
                  <option value={space.id}>{space.name || 'New Room'}</option>
                )}
                {Object.values(rooms).map(r => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            )}
            <input
              className="sb-name-input"
              value={space.name}
              onChange={e => setSpace(prev => ({ ...prev, name: e.target.value }))}
              placeholder="Room name…"
            />
            <span className="sb-surface-count">
              {space.surfaces.length} surface{space.surfaces.length !== 1 ? 's' : ''}
              {hasUnsavedChanges && <span className="sb-unsaved-dot" title="Unsaved changes" />}
            </span>
          </div>

          <div className="sb-header-actions">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />

            {/* Undo / Redo */}
            <button
              className="sb-btn sb-btn--ghost sb-btn--icon"
              onClick={undo}
              disabled={!canUndo}
              title="Undo (Ctrl+Z)"
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <path d="M11 5.5C11 3.57 9.43 2 7.5 2c-1.2 0-2.27.6-2.92 1.52L3.5 5H6v1.5H2V2.5h1.5v1.8l1.08-1.22A4.5 4.5 0 1 1 3 8.5h1.62A3 3 0 1 0 7.5 3.5c-.97 0-1.83.46-2.38 1.17"
                  stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              </svg>
            </button>
            <button
              className="sb-btn sb-btn--ghost sb-btn--icon"
              onClick={redo}
              disabled={!canRedo}
              title="Redo (Ctrl+Y)"
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <path d="M2 5.5C2 3.57 3.57 2 5.5 2c1.2 0 2.27.6 2.92 1.52L9.5 5H7v1.5h4V2.5H9.5v1.8L8.42 3.08A4.5 4.5 0 1 0 10 8.5H8.38A3 3 0 1 1 5.5 3.5c.97 0 1.83.46 2.38 1.17"
                  stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              </svg>
            </button>

            <button className="sb-btn sb-btn--ghost" onClick={handleAddPhotoClick}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <rect x="1" y="3" width="11" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
                <circle cx="4.5" cy="6.5" r="1.5" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M7 10l2-3 3 3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              </svg>
              Add
            </button>

            <button
              className={`sb-btn sb-btn--stitch${isStitching ? ' sb-btn--loading' : ''}`}
              onClick={handleStitch}
              disabled={isStitching || space.surfaces.length < 2}
              title="Blend seams between connected surfaces"
            >
              {isStitching ? (
                <><span className="btn-spinner" />{stitchStatus || (stitchProgress > 0 ? `${stitchProgress}%` : 'Blending…')}</>
              ) : (
                <>
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                    <path d="M2 6.5h9M2 6.5L5 4M2 6.5L5 9M11 6.5L8 4M11 6.5L8 9"
                      stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Stitch
                </>
              )}
            </button>

            <button
              className="sb-btn sb-btn--erase"
              onClick={() => setShowEraseModal(true)}
              disabled={!activeSurface || !(activeSurface.stitchedDataUrl || activeSurface.warpedDataUrl)}
              title="Erase an object from the active surface using content-aware fill"
            >
              <svg width="13" height="13" viewBox="32 7 33 33" xmlns="http://www.w3.org/2000/svg">
                <polyline fill="#f4aa41" stroke="none" points="18.0381,41.8761 36.8684,23.0457 48.1813,34.3586 29.5108,53.0291"/>
                <polyline fill="#EA5A47" stroke="none" points="42.9209,16.9933 50.4228,9.4913 61.7357,20.8042 54.2975,28.2424"/>
                <polyline fill="#9b9b9a" stroke="none" points="35.6498,24.2643 43.3318,16.5823 54.6447,27.8952 47.0278,35.512"/>
                <polygon fill="none" stroke="#000" strokeLinecap="round" strokeLinejoin="round" strokeMiterlimit="10" strokeWidth="2" points="18.6304,56.8203 27.8278,53.2939 53.8207,27.301 43.9212,17.4015 17.9281,43.3946 14.3904,52.6032"/>
                <polyline fill="none" stroke="#000" strokeLinecap="round" strokeLinejoin="round" strokeMiterlimit="10" strokeWidth="2" points="47.3354,13.9873 50.8388,10.4839 60.7383,20.3834 57.2645,23.8572"/>
                <line x1="36.9099" x2="46.4225" y1="25.0073" y2="34.5199" stroke="#000" strokeLinecap="round" strokeLinejoin="round" strokeMiterlimit="10" strokeWidth="2"/>
              </svg>
              Erase
            </button>

            {/* Save Room popover */}
            <div className="sb-save-wrap" ref={saveMenuRef}>
              <button
                className={`sb-btn sb-btn--save${isSaving ? ' sb-btn--loading' : ''}`}
                onClick={() => { if (!isSaving) setShowSaveMenu(v => !v) }}
                disabled={isSaving || space.surfaces.length === 0}
                title="Save room"
              >
                {isSaving ? <><span className="btn-spinner" />Saving…</> : (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M1 1h7.5L11 3.5V11H1V1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                    <rect x="3" y="1" width="3.5" height="2.5" rx="0.4" stroke="currentColor" strokeWidth="1"/>
                    <rect x="2" y="7" width="8" height="3" rx="0.4" stroke="currentColor" strokeWidth="1"/>
                  </svg>
                )}
              </button>
              {showSaveMenu && (
                <div className="sb-save-menu">
                  {/* Overwrite existing */}
                  {rooms[space.id] && (
                    <button className="sb-save-menu-item sb-save-menu-overwrite"
                      onClick={() => handleSave()}>
                      ↩ Overwrite "{space.name}"
                    </button>
                  )}
                  <div className="sb-save-menu-divider" />
                  {/* Save as new */}
                  <div className="sb-save-menu-label">Save as new room</div>
                  <div className="sb-save-menu-row">
                    <input
                      className="sb-save-menu-input"
                      placeholder="New room name…"
                      value={saveAsName}
                      onChange={e => setSaveAsName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && saveAsName.trim()) handleSave(saveAsName.trim())
                      }}
                      autoFocus
                    />
                    <button
                      className="sb-save-menu-go"
                      disabled={!saveAsName.trim()}
                      onClick={() => handleSave(saveAsName.trim())}
                    >Save</button>
                  </div>
                </div>
              )}
            </div>

            <button className="sb-close-btn" onClick={onClose} title="Close builder">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path d="M1 1l9 9M10 1L1 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>

            {/* Mobile hamburger — opens surface panel */}
            <button
              className="sb-hamburger-btn"
              onClick={() => setShowMobilePanel(v => !v)}
              title="Open surfaces panel"
              aria-label="Toggle surfaces panel"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        </div>

        {/* ── Body ────────────────────────────────────────────────────────── */}
        <div className="sb-body">
          {/* Canvas area */}
          <div
            className="sb-canvas-area"
            onClick={() => showMobilePanel && setShowMobilePanel(false)}
          >
            {isDragOver && (
              <div className="sb-drop-overlay">
                <div className="sb-drop-message">
                  <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                    <rect x="2" y="6" width="28" height="20" rx="3" stroke="currentColor" strokeWidth="2"/>
                    <circle cx="11" cy="14" r="3" stroke="currentColor" strokeWidth="2"/>
                    <path d="M17 22l5-7 6 7" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
                  </svg>
                  Drop photos to add
                </div>
              </div>
            )}
            <SpaceBuilderCanvas
              space={space}
              activeSurfaceId={activeSurfaceId}
              onSelectSurface={setActiveSurfaceId}
              onUpdateSurface={updateSurface}
              onSetConnection={setConnection}
              onSurfaceTap={() => setShowMobilePanel(true)}
              requestCropId={cropRequestId}
            />
          </div>

          {/* Mobile overlay backdrop */}
          {showMobilePanel && (
            <div
              className="sb-panel-overlay"
              onClick={() => setShowMobilePanel(false)}
            />
          )}

          {/* Surface panel */}
          <div className={`sb-panel${showMobilePanel ? ' sb-panel--mobile-open' : ''}`}>
            <div className="sb-panel-header">
              <span className="sb-panel-title">Surfaces</span>
              <span className="sb-panel-count">{space.surfaces.length} / 12</span>
              {/* Mobile close button */}
              <button
                className="sb-panel-close-btn"
                onClick={() => setShowMobilePanel(false)}
                title="Close panel"
              >
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <path d="M1 1l9 9M10 1L1 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
            </div>

            {/* Surface list (thumbnails / nav) */}
            <div className="sb-surface-list">
              {space.surfaces.map((s, i) => {
                const color = SURFACE_COLORS[s.colorIdx ?? 0]
                const isActive = s.id === activeSurfaceId
                return (
                  <button
                    key={s.id}
                    className={`sb-surf-row${isActive ? ' sb-surf-row--active' : ''}`}
                    onClick={() => setActiveSurfaceId(s.id)}
                    style={{ '--surf-color': color }}
                  >
                    <span className="sb-surf-dot" />
                    <span className="sb-surf-name">{s.name}</span>
                    <span className="sb-surf-dims">{s.widthIn}″ × {s.heightIn}″</span>
                    {s.warpedDataUrl && (
                      <span className="sb-surf-warped-badge" title="Warped">✓</span>
                    )}
                  </button>
                )
              })}
              {space.surfaces.length < 12 && (
                <button
                  className="sb-surf-add-btn"
                  onClick={() => addSurfaceOnPhoto(space.photos[0]?.id || null)}
                  disabled={space.photos.length === 0}
                  title={space.photos.length === 0 ? 'Add a photo first' : 'Add surface'}
                >
                  + Add Surface
                </button>
              )}
            </div>

            {/* Selected surface editor */}
            <div className="sb-panel-editor">
              {renderSurfacePanel()}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

