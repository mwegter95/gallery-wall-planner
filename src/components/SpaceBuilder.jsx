/**
 * SpaceBuilder — Interactive freeform room/space builder.
 *
 * Layout:
 *   Left (65%):  SpaceBuilderCanvas — photos + surface warp handles
 *   Right (35%): Surface panel — name, W×H, connections, z-order, delete
 *   Header:      Space name, Add Photo, Preview 3D, Save, Close
 */
import { useState, useCallback, useRef, useEffect } from 'react'
import * as THREE from 'three'
import SpaceBuilderCanvas from './SpaceBuilderCanvas'
import EraseModal from './EraseModal'
import {
  createSpace, createPhoto, createSurfaceDef, genId,
  assembleSurfaces, warpSurface, createSurfaceLayout, createSurfacePiece, SURFACE_COLORS,
  getEffectiveSurfaceUrl,
} from '../utils/spaceAssembler'
import { warpPerspectiveAsync } from '../utils/homography'

const EDGES = ['left', 'right', 'top', 'bottom']

const MAX_HISTORY = 50
// Properties that count as "moveable" actions worth undo-ing
const HISTORY_KEYS = new Set(['pose3d', 'rotYDeg', 'widthIn', 'heightIn'])

export default function SpaceBuilder({ existingSpace, onSave, onClose, library = {}, allLayouts = {} }) {
  const [space, setSpace]                 = useState(() => existingSpace
    ? JSON.parse(JSON.stringify(existingSpace))
    : createSpace()
  )
  const [activeSurfaceId, setActiveSurfaceId] = useState(null)
  const [showPreview,     setShowPreview]     = useState(false)
  const [previewData,     setPreviewData]     = useState(null) // { placements, warpedSurfaces }
  const [isWarping,       setIsWarping]       = useState(false)
  const [warpProgress,    setWarpProgress]    = useState(0)
  const [isStitching,     setIsStitching]     = useState(false)
  const [stitchProgress,  setStitchProgress]  = useState(0)
  const [stitchStatus,    setStitchStatus]    = useState('')
  const [isSaving,        setIsSaving]        = useState(false)
  const [isDragOver,      setIsDragOver]      = useState(false)
  // Layout management state (scoped to active surface)
  const [layoutNameInput, setLayoutNameInput] = useState('')
  const [showLibPicker,   setShowLibPicker]   = useState(false)
  const [showEraseModal,  setShowEraseModal]  = useState(false)
  // Undo / redo
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const historyRef   = useRef({ stack: [], index: -1, timer: null })
  const fileInputRef  = useRef(null)
  const warpQueueRef  = useRef(new Set())

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

  // ── Warp + Preview ────────────────────────────────────────────────────────
  const handlePreview = async () => {
    if (!space.surfaces.length) return
    setIsWarping(true)
    setWarpProgress(0)
    try {
      const total   = space.surfaces.filter(s => !s.warpedDataUrl).length
      let   done    = 0

      const warpedSurfaces = await Promise.all(
        space.surfaces.map(async surface => {
          if (surface.warpedDataUrl) return surface
          const photo = space.photos.find(p => p.id === surface.photoId)
          if (!photo) return surface
          try {
            const url = await warpSurface(
              surface, photo.dataUrl, photo.displayW, photo.displayH,
              warpPerspectiveAsync
            )
            done++
            setWarpProgress(Math.round(done / Math.max(1, total) * 100))
            return { ...surface, warpedDataUrl: url, stitchedDataUrl: null }
          } catch {
            return surface
          }
        })
      )

      // Persist warped URLs into space so they survive re-preview
      setSpace(prev => ({ ...prev, surfaces: warpedSurfaces }))

      const placements = assembleSurfaces(warpedSurfaces)
      setPreviewData({ placements, warpedSurfaces })
      setShowPreview(true)
    } finally {
      setIsWarping(false)
      setWarpProgress(0)
    }
  }

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
  const handleSave = async () => {
    if (!space.name.trim()) return
    setIsSaving(true)
    try {
      await onSave(space)
    } finally {
      setIsSaving(false)
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

        {/* Edge connections */}
        <div className="sb-se-connections">
          <div className="sb-se-conn-title">Edge Connections</div>
          {EDGES.map(edge => {
            const conn = activeSurface.connections[edge]
            return (
              <div key={edge} className="sb-se-conn-row">
                <span className="sb-se-conn-edge">{edge}</span>

                <select
                  className="sb-se-select sb-se-conn-sel"
                  value={conn?.surfaceId || ''}
                  onChange={e => {
                    const val = e.target.value
                    if (!val) {
                      setConnection(activeSurface.id, edge, null)
                    } else {
                      setConnection(activeSurface.id, edge, {
                        surfaceId: val,
                        edge:      conn?.edge || 'left',
                        angleDeg:  conn?.angleDeg ?? 90,
                      })
                    }
                  }}
                >
                  <option value="">— none —</option>
                  {otherSurfaces.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>

                {conn && (
                  <>
                    <select
                      className="sb-se-select sb-se-conn-edge-sel"
                      value={conn.edge}
                      onChange={e => setConnection(activeSurface.id, edge, { ...conn, edge: e.target.value })}
                    >
                      {EDGES.map(eg => <option key={eg} value={eg}>{eg}</option>)}
                    </select>

                    <div className="sb-se-angle-wrap">
                      <input
                        type="number" min="10" max="180"
                        className="sb-se-angle-input"
                        value={conn.angleDeg ?? 90}
                        onChange={e => setConnection(activeSurface.id, edge, {
                          ...conn, angleDeg: Number(e.target.value),
                        })}
                      />
                      <span className="sb-se-unit">°</span>
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>

        {/* Re-crop button */}
        <button
          className="sb-se-rewarp-btn"
          onClick={() => updateSurface(activeSurface.id, { warpedDataUrl: null })}
          disabled={!activeSurface.warpedDataUrl}
          title="Clear cached warp — will be re-computed on next preview"
        >
          {activeSurface.warpedDataUrl ? '↺ Re-crop on next preview' : 'Not yet warped'}
        </button>

        {/* ── Wall layouts from main app ────────────────────────── */}
        {(() => {
          const wallLayouts = allLayouts[activeSurface.id] || {}
          const names = Object.keys(wallLayouts)
          if (names.length === 0) return null
          return (
            <div className="sb-wall-layouts">
              <div className="sb-se-section-title">Wall Layouts</div>
              <div className="sb-layout-list">
                {names.map(name => {
                  const data = wallLayouts[name]
                  const pieces = Array.isArray(data) ? data : (data?.pieces || [])
                  const isActive = name === activeSurface.activeLayout
                  return (
                    <div key={name} className={`sb-layout-row${isActive ? ' sb-layout-row--active' : ''}`}>
                      <span className="sb-layout-row-name">{name}</span>
                      <span className="sb-layout-row-count">{pieces.length}p</span>
                      <div className="sb-layout-row-actions">
                        <button
                          className="btn btn-ghost btn-xs"
                          onClick={() => loadWallLayout(activeSurface.id, name, wallLayouts[name])}
                        >{isActive ? '✓ Active' : 'Load'}</button>
                      </div>
                    </div>
                  )
                })}
              </div>
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

  // ── 3D Preview overlay ────────────────────────────────────────────────────
  if (showPreview && previewData) {
    return (
      <div className="room-viewer-overlay">
        <SpacePreviewViewer
          placements={previewData.placements}
          spaceName={space.name}
          onClose={() => setShowPreview(false)}
        />
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
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="sb-header">
          <div className="sb-header-left">
            <input
              className="sb-name-input"
              value={space.name}
              onChange={e => setSpace(prev => ({ ...prev, name: e.target.value }))}
              placeholder="Space name…"
            />
            <span className="sb-surface-count">
              {space.surfaces.length} surface{space.surfaces.length !== 1 ? 's' : ''}
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
                <path d="M2 5.5C2 3.57 3.57 2 5.5 2c1.2 0 2.27.6 2.92 1.52L9.5 5H7v1.5h4V2.5H9.5v1.8L8.42 3.08A4.5 4.5 0 1 0 10 8.5H8.38A3 3 0 1 1 5.5 3.5c.97 0 1.83.46 2.38 1.17"
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
                <path d="M11 5.5C11 3.57 9.43 2 7.5 2c-1.2 0-2.27.6-2.92 1.52L3.5 5H6v1.5H2V2.5h1.5v1.8l1.08-1.22A4.5 4.5 0 1 1 3 8.5h1.62A3 3 0 1 0 7.5 3.5c-.97 0-1.83.46-2.38 1.17"
                  stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              </svg>
            </button>

            <button className="sb-btn sb-btn--ghost" onClick={handleAddPhotoClick}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <rect x="1" y="3" width="11" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
                <circle cx="4.5" cy="6.5" r="1.5" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M7 10l2-3 3 3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              </svg>
              Add Photo
            </button>

            <button
              className={`sb-btn sb-btn--stitch${isStitching ? ' sb-btn--loading' : ''}`}
              onClick={handleStitch}
              disabled={isStitching || isWarping || space.surfaces.length < 2}
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
                  Stitch Seams
                </>
              )}
            </button>

            <button
              className="sb-btn sb-btn--erase"
              onClick={() => setShowEraseModal(true)}
              disabled={!activeSurface || !(activeSurface.stitchedDataUrl || activeSurface.warpedDataUrl)}
              title="Erase an object from the active surface using content-aware fill"
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <path d="M10 3L3 10M3 10l3.5-.5L10 6M3 10l.5-3.5L7 3"
                  stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2 11h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
              Erase Object
            </button>

            <button
              className={`sb-btn sb-btn--preview${isWarping ? ' sb-btn--loading' : ''}`}
              onClick={handlePreview}
              disabled={isWarping || space.surfaces.length === 0}
            >
              {isWarping ? (
                <>
                  <span className="btn-spinner" />
                  {warpProgress > 0 ? `${warpProgress}%` : 'Warping…'}
                </>
              ) : (
                <>
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                    <path d="M6.5 1L12 4.3v4.4L6.5 12 1 8.7V4.3L6.5 1Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                    <path d="M6.5 1v11M1 4.3l5.5 3.4 5.5-3.4" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" opacity=".6"/>
                  </svg>
                  Preview 3D
                </>
              )}
            </button>

            <button
              className={`sb-btn sb-btn--save${isSaving ? ' sb-btn--loading' : ''}`}
              onClick={handleSave}
              disabled={isSaving || !space.name.trim() || space.surfaces.length === 0}
            >
              {isSaving ? <><span className="btn-spinner" />Saving…</> : 'Save Space'}
            </button>

            <button className="sb-close-btn" onClick={onClose} title="Close builder">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path d="M1 1l9 9M10 1L1 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        </div>

        {/* ── Body ────────────────────────────────────────────────────────── */}
        <div className="sb-body">
          {/* Canvas area */}
          <div className="sb-canvas-area">
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
            />
          </div>

          {/* Surface panel */}
          <div className="sb-panel">
            <div className="sb-panel-header">
              <span className="sb-panel-title">Surfaces</span>
              <span className="sb-panel-count">{space.surfaces.length} / 12</span>
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

// ── Inline 3D preview — orbit camera, click-to-select, per-surface sliders ──
function SpacePreviewViewer({ placements, spaceName, onClose }) {
  const mountRef  = useRef(null)
  const [localPlacements, setLocalPlacements] = useState(() => placements.map(p => ({ ...p })))
  const [selectedId, setSelectedId] = useState(null)

  // Three.js handles kept in refs so effects can access without re-running
  const sceneRef    = useRef(null)
  const cameraRef   = useRef(null)
  const rendererRef = useRef(null)
  const meshMapRef  = useRef({})   // { [surfaceId]: { mesh, frame } }
  const rafRef      = useRef(null)
  const orbitRef    = useRef({
    phi: Math.PI / 2.5, theta: 0.3, radius: 5,
    center: [0, 0, 0],
    isDragging: false, hadDrag: false, lastX: 0, lastY: 0,
  })

  const applyOrbit = useCallback(() => {
    const cam = cameraRef.current
    if (!cam) return
    const o = orbitRef.current
    o.phi = Math.max(0.05, Math.min(Math.PI - 0.05, o.phi))
    const [cx, cy, cz] = o.center
    cam.position.set(
      cx + o.radius * Math.sin(o.phi) * Math.sin(o.theta),
      cy + o.radius * Math.cos(o.phi),
      cz + o.radius * Math.sin(o.phi) * Math.cos(o.theta),
    )
    cam.lookAt(cx, cy, cz)
  }, [])

  // ── Scene init (once) ─────────────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth || 900, mount.clientHeight || 650)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    mount.appendChild(renderer.domElement)
    rendererRef.current = renderer

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x090c10)
    sceneRef.current = scene

    const camera = new THREE.PerspectiveCamera(
      60, (mount.clientWidth || 900) / (mount.clientHeight || 650), 0.01, 500
    )
    cameraRef.current = camera

    const ro = new ResizeObserver(() => {
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(mount.clientWidth, mount.clientHeight)
    })
    ro.observe(mount)

    const o = orbitRef.current
    const onDown = e => {
      if (e.button !== 0) return
      o.isDragging = true; o.hadDrag = false
      o.lastX = e.clientX; o.lastY = e.clientY
    }
    const onMove = e => {
      if (!o.isDragging) return
      const dx = e.clientX - o.lastX
      const dy = e.clientY - o.lastY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) o.hadDrag = true
      o.theta -= dx * 0.005
      o.phi   += dy * 0.005
      o.lastX = e.clientX; o.lastY = e.clientY
      applyOrbit()
    }
    const onUp = () => { o.isDragging = false }
    const onWheel = e => {
      o.radius = Math.max(0.3, Math.min(80, o.radius * (1 + e.deltaY * 0.001)))
      applyOrbit()
    }
    const onClickCanvas = e => {
      if (o.hadDrag) return
      const rect = renderer.domElement.getBoundingClientRect()
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left)  / rect.width)  * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
      const ray = new THREE.Raycaster()
      ray.setFromCamera(mouse, camera)
      const meshes = Object.values(meshMapRef.current).map(v => v.mesh).filter(Boolean)
      const hits = ray.intersectObjects(meshes)
      setSelectedId(hits.length ? hits[0].object.userData.surfaceId : null)
    }

    const canvas = renderer.domElement
    canvas.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: true })
    canvas.addEventListener('click', onClickCanvas)

    const animate = () => { rafRef.current = requestAnimationFrame(animate); renderer.render(scene, camera) }
    animate()

    return () => {
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
      canvas.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('click', onClickCanvas)
      scene.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose()
        if (obj.material?.map) obj.material.map.dispose()
        if (obj.material) obj.material.dispose()
      })
      renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
    }
  }, [applyOrbit])

  // ── Rebuild meshes when localPlacements changes ───────────────────────────
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return

    // Remove old surface objects
    Object.values(meshMapRef.current).forEach(({ mesh, frame }) => {
      scene.remove(mesh); scene.remove(frame)
    })
    meshMapRef.current = {}

    const texLoader = new THREE.TextureLoader()
    localPlacements.forEach(p => {
      const geo = new THREE.PlaneGeometry(p.wM, p.hM)
      let mat
      if (p.warpedDataUrl) {
        const tex = texLoader.load(p.warpedDataUrl)
        tex.colorSpace = THREE.SRGBColorSpace
        mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide })
      } else {
        const hex = parseInt((SURFACE_COLORS[p.colorIdx ?? 0] || '#4a9eff').replace('#', ''), 16)
        mat = new THREE.MeshBasicMaterial({ color: hex, side: THREE.DoubleSide, opacity: 0.7, transparent: true })
      }
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(...p.position)
      mesh.rotation.set(p.rotX ?? 0, p.rotY ?? 0, 0)
      mesh.userData.surfaceId = p.surfaceId
      scene.add(mesh)

      const edgesGeo = new THREE.EdgesGeometry(geo)
      const lineMat  = new THREE.LineBasicMaterial({ color: 0x3a5566 })
      const frame    = new THREE.LineSegments(edgesGeo, lineMat)
      frame.position.copy(mesh.position)
      frame.rotation.copy(mesh.rotation)
      scene.add(frame)
      meshMapRef.current[p.surfaceId] = { mesh, frame }
    })

    // Fit orbit
    if (localPlacements.length) {
      const cx = localPlacements.reduce((s, p) => s + p.position[0], 0) / localPlacements.length
      const cy = localPlacements.reduce((s, p) => s + p.position[1], 0) / localPlacements.length
      const cz = localPlacements.reduce((s, p) => s + p.position[2], 0) / localPlacements.length
      const maxDim = Math.max(...localPlacements.flatMap(p => [p.wM, p.hM]))
      const o = orbitRef.current
      o.center  = [cx, cy, cz]
      o.radius  = maxDim * 2.8
      applyOrbit()
    }
  }, [localPlacements, applyOrbit])

  // ── Highlight selected surface ────────────────────────────────────────────
  useEffect(() => {
    Object.entries(meshMapRef.current).forEach(([id, { frame }]) => {
      frame?.material?.color?.set(id === selectedId ? 0xffffff : 0x3a5566)
    })
  }, [selectedId])

  // ── Helpers for selected panel ────────────────────────────────────────────
  const selectedP = localPlacements.find(p => p.surfaceId === selectedId)

  const updateSelPos = (axis, val) => {
    const idx = { x: 0, y: 1, z: 2 }[axis]
    setLocalPlacements(prev => prev.map(p => {
      if (p.surfaceId !== selectedId) return p
      const pos = [...p.position]; pos[idx] = +val
      return { ...p, position: pos }
    }))
  }
  const updateSelRot = (key, deg) =>
    setLocalPlacements(prev => prev.map(p =>
      p.surfaceId !== selectedId ? p : { ...p, [key]: +deg * Math.PI / 180 }
    ))

  return (
    <div className="room-viewer">
      <div ref={mountRef} className="room-viewer__canvas" />
      <div className="room-viewer__hud">
        <div className="room-viewer__hud-top">
          <button className="room-viewer__close-btn" onClick={onClose}>
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M1 1l9 9M10 1L1 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            Back to Builder
          </button>
          <span className="room-viewer__room-name">{spaceName} — 3D Preview</span>
        </div>

        {selectedP ? (
          <div className="spv-sel-panel">
            <div className="spv-sel-header">
              <span className="spv-sel-name" style={{ color: SURFACE_COLORS[selectedP.colorIdx ?? 0] }}>
                {selectedP.name}
              </span>
              <button className="spv-sel-close" onClick={() => setSelectedId(null)}>✕</button>
            </div>
            <div className="spv-sel-fields">
              {[['X', 'x', -20, 20, selectedP.position[0]],
                ['Y', 'y', -10, 10, selectedP.position[1]],
                ['Z', 'z', -20, 20, selectedP.position[2]]].map(([label, axis, min, max, val]) => (
                <label key={axis} className="spv-sel-field">
                  <span className="spv-sel-fl">{label}</span>
                  <span className="spv-sel-fv">{(+val).toFixed(2)}m</span>
                  <input type="range" min={min} max={max} step="0.02" value={val}
                    onChange={e => updateSelPos(axis, e.target.value)} />
                </label>
              ))}
              <label className="spv-sel-field">
                <span className="spv-sel-fl">Rotate Y</span>
                <span className="spv-sel-fv">{Math.round((selectedP.rotY ?? 0) * 180 / Math.PI)}°</span>
                <input type="range" min="-180" max="180" step="1"
                  value={Math.round((selectedP.rotY ?? 0) * 180 / Math.PI)}
                  onChange={e => updateSelRot('rotY', e.target.value)} />
              </label>
              <label className="spv-sel-field">
                <span className="spv-sel-fl">Tilt X</span>
                <span className="spv-sel-fv">{Math.round((selectedP.rotX ?? 0) * 180 / Math.PI)}°</span>
                <input type="range" min="-90" max="90" step="1"
                  value={Math.round((selectedP.rotX ?? 0) * 180 / Math.PI)}
                  onChange={e => updateSelRot('rotX', e.target.value)} />
              </label>
            </div>
          </div>
        ) : (
          <div className="room-viewer__tip">Drag to orbit · Scroll to zoom · Click a surface to move it</div>
        )}
      </div>
    </div>
  )
}


