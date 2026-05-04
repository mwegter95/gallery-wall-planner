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
        setSpace(prev => {
          const photo   = createPhoto({ dataUrl, displayW, displayH, index: prev.photos.length })
          const surface = createSurfaceDef({ photoId: photo.id, index: prev.surfaces.length })
          setActiveSurfaceId(surface.id)
          return {
            ...prev,
            photos:   [...prev.photos,   photo],
            surfaces: [...prev.surfaces, surface],
          }
        })
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  }, [])

  const handleAddPhotoClick = () => fileInputRef.current?.click()

  const handleFileChange = (e) => {
    const file = e.target.files?.[0]
    if (file) addPhotoFromFile(file)
    e.target.value = ''
  }

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
      <div className="sb-modal">
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
            <SpaceBuilderCanvas
              space={space}
              activeSurfaceId={activeSurfaceId}
              onSelectSurface={setActiveSurfaceId}
              onUpdateSurface={updateSurface}
              onUpdatePhoto={updatePhoto}
              onAddSurfaceOnPhoto={addSurfaceOnPhoto}
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

// ── Inline 3D preview (minimal Three.js viewer for freeform placements) ──────
function SpacePreviewViewer({ placements, spaceName, onClose }) {
  const mountRef = useRef(null)

  useEffect(() => {
    if (!mountRef.current || !placements?.length) return
    const mount = mountRef.current

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth || 900, mount.clientHeight || 650)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    mount.appendChild(renderer.domElement)

    const scene  = new THREE.Scene()
    scene.background = new THREE.Color(0x090c10)

    const camera = new THREE.PerspectiveCamera(
      75, (mount.clientWidth || 900) / (mount.clientHeight || 650), 0.01, 500
    )
    camera.position.set(0, 0, 0)

    let phi = Math.PI / 2, theta = 0
    const updateLookAt = () => {
      phi = Math.max(0.05, Math.min(Math.PI - 0.05, phi))
      camera.lookAt(
        Math.sin(phi) * Math.sin(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.cos(theta),
      )
    }
    updateLookAt()

    const texLoader = new THREE.TextureLoader()
    const meshes    = []

    placements.forEach(p => {
      const geo = new THREE.PlaneGeometry(p.wM, p.hM)
      let mat

      if (p.warpedDataUrl) {
        const tex = texLoader.load(p.warpedDataUrl)
        tex.colorSpace = THREE.SRGBColorSpace
        mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide })
      } else {
        const hex = parseInt(
          (SURFACE_COLORS[p.colorIdx ?? 0] || '#4a9eff').replace('#', ''), 16
        )
        mat = new THREE.MeshBasicMaterial({ color: hex, side: THREE.FrontSide, opacity: 0.7, transparent: true })
      }

      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(...p.position)
      mesh.rotation.set(p.rotX ?? 0, p.rotY ?? 0, 0)
      mesh.userData.surfaceId = p.surfaceId
      scene.add(mesh)
      meshes.push(mesh)

      const edges   = new THREE.EdgesGeometry(geo)
      const lineMat = new THREE.LineBasicMaterial({ color: 0x3a5566 })
      const frame   = new THREE.LineSegments(edges, lineMat)
      frame.position.set(...p.position)
      frame.rotation.set(p.rotX ?? 0, p.rotY ?? 0, 0)
      scene.add(frame)
    })

    // Position camera at centroid of all placements, looking at first surface
    if (placements.length) {
      const cx = placements.reduce((s, p) => s + p.position[0], 0) / placements.length
      const cy = placements.reduce((s, p) => s + p.position[1], 0) / placements.length
      const cz = placements.reduce((s, p) => s + p.position[2], 0) / placements.length
      // Place camera slightly behind centroid
      const maxDim = Math.max(...placements.map(p => Math.max(p.wM, p.hM)))
      camera.position.set(cx, cy, cz + maxDim * 1.5)
      camera.lookAt(cx, cy, cz)
      phi = Math.PI / 2; theta = Math.PI
      updateLookAt()
    }

    let isDragging = false, lastX = 0, lastY = 0
    const onPointerDown = e => {
      isDragging = true; lastX = e.clientX; lastY = e.clientY
    }
    const onPointerMove = e => {
      if (!isDragging) return
      theta -= (e.clientX - lastX) * 0.006
      phi   += (e.clientY - lastY) * 0.006
      lastX = e.clientX; lastY = e.clientY
      updateLookAt()
    }
    const onPointerUp = () => { isDragging = false }

    const canvas = renderer.domElement
    canvas.addEventListener('mousedown', onPointerDown)
    canvas.addEventListener('mousemove', onPointerMove)
    canvas.addEventListener('mouseup',   onPointerUp)
    canvas.addEventListener('mouseleave',onPointerUp)

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(mount.clientWidth, mount.clientHeight)
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(mount)

    let raf
    const animate = () => { raf = requestAnimationFrame(animate); renderer.render(scene, camera) }
    animate()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('mousedown', onPointerDown)
      canvas.removeEventListener('mousemove', onPointerMove)
      canvas.removeEventListener('mouseup',   onPointerUp)
      canvas.removeEventListener('mouseleave',onPointerUp)
      scene.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose()
        if (obj.material) {
          if (obj.material.map) obj.material.map.dispose()
          obj.material.dispose()
        }
      })
      renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
    }
  }, [placements])

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
        <div className="room-viewer__tip">Drag to look around</div>
      </div>
    </div>
  )
}
