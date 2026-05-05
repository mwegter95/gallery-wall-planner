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
import {
  createSpace, createPhoto, createSurfaceDef,
  assembleSurfaces, warpSurface, SURFACE_COLORS,
} from '../utils/spaceAssembler'
import { warpPerspectiveAsync } from '../utils/homography'

const EDGES = ['left', 'right', 'top', 'bottom']

export default function SpaceBuilder({ existingSpace, onSave, onClose }) {
  const [space, setSpace]                 = useState(() => existingSpace
    ? JSON.parse(JSON.stringify(existingSpace))
    : createSpace()
  )
  const [activeSurfaceId, setActiveSurfaceId] = useState(null)
  const [showPreview,     setShowPreview]     = useState(false)
  const [previewData,     setPreviewData]     = useState(null) // { placements, warpedSurfaces }
  const [isWarping,       setIsWarping]       = useState(false)
  const [warpProgress,    setWarpProgress]    = useState(0)
  const [isSaving,        setIsSaving]        = useState(false)
  const [isDragOver,      setIsDragOver]      = useState(false)
  const fileInputRef = useRef(null)

  const activeSurface = space.surfaces.find(s => s.id === activeSurfaceId)

  // ── Space / photo mutations ───────────────────────────────────────────────
  const updateSurface = useCallback((surfaceId, update) => {
    setSpace(prev => ({
      ...prev,
      surfaces: prev.surfaces.map(s => s.id === surfaceId ? { ...s, ...update } : s),
    }))
  }, [])

  const updatePhoto = useCallback((photoId, update) => {
    setSpace(prev => ({
      ...prev,
      photos: prev.photos.map(p => p.id === photoId ? { ...p, ...update } : p),
    }))
  }, [])

  const addPhotoFromFile = useCallback((file) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = e => {
      const dataUrl = e.target.result
      const img = new Image()
      img.onload = () => {
        const displayW = Math.min(680, img.naturalWidth)
        const displayH = Math.round(displayW * img.naturalHeight / img.naturalWidth)
        // Capture the newly created surface so we can auto-warp outside the updater
        let autoSurface = null
        setSpace(prev => {
          const photo   = createPhoto({ dataUrl, displayW, displayH, index: prev.photos.length })
          const surface = createSurfaceDef({ photoId: photo.id, index: prev.surfaces.length })
          autoSurface = surface
          setActiveSurfaceId(surface.id)
          return {
            ...prev,
            photos:   [...prev.photos,   photo],
            surfaces: [...prev.surfaces, surface],
          }
        })
        // Auto-warp with default corners immediately after adding to state
        if (autoSurface) {
          warpSurface(autoSurface, dataUrl, displayW, displayH, warpPerspectiveAsync)
            .then(url => updateSurface(autoSurface.id, { warpedDataUrl: url }))
            .catch(() => {})
        }
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  }, [updateSurface])

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
            return { ...surface, warpedDataUrl: url }
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
            <button className="sb-btn sb-btn--ghost" onClick={handleAddPhotoClick}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <rect x="1" y="3" width="11" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
                <circle cx="4.5" cy="6.5" r="1.5" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M7 10l2-3 3 3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              </svg>
              Add Photo
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


