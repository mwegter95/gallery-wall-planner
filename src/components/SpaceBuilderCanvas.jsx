/**
 * SpaceBuilderCanvas — interactive multi-surface, multi-photo perspective canvas.
 *
 * - Pan the canvas by dragging the background
 * - Each photo can be repositioned (drag the photo header grip)
 * - Each photo can be z-ordered (send forward/back)
 * - Up to 12 surfaces defined per-photo with 4 draggable corner handles
 * - Surfaces show name + dims inline at centroid
 * - Corner snapping: handles turn white when near another surface's corner
 * - Click a surface quad to select it
 */
import { useRef, useState, useEffect, useCallback, useLayoutEffect } from 'react'
import { cornersToCanvas, cornersCentroid, findSnapTarget, SURFACE_COLORS } from '../utils/spaceAssembler'

const HANDLE_R       = 9
const SNAP_THRESHOLD = 22
const CANVAS_W       = 6000
const CANVAS_H       = 4500

export default function SpaceBuilderCanvas({
  space,
  activeSurfaceId,
  onSelectSurface,
  onUpdateSurface,
  onUpdatePhoto,
  onAddSurfaceOnPhoto,
}) {
  const viewportRef = useRef(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [snapInfo, setSnapInfo] = useState(null) // { surfaceId, corner }

  // Refs so stable callbacks can read latest values
  const offsetRef   = useRef({ x: 0, y: 0 })
  const spaceRef    = useRef(space)
  const handlersRef = useRef({})
  const dragRef     = useRef(null)

  useLayoutEffect(() => { spaceRef.current   = space   }, [space])
  useLayoutEffect(() => { offsetRef.current  = offset  }, [offset])
  handlersRef.current = { onUpdateSurface, onUpdatePhoto, onSelectSurface, onAddSurfaceOnPhoto }

  // ── Coordinate helper (no React deps, stable) ─────────────────────────────
  function screenToCanvas(clientX, clientY) {
    const rect = viewportRef.current?.getBoundingClientRect()
    if (!rect) return [0, 0]
    return [
      clientX - rect.left + offsetRef.current.x,
      clientY - rect.top  + offsetRef.current.y,
    ]
  }

  // ── Stable global mouse handlers (use refs, never recreated) ──────────────
  const globalMouseMove = useRef((e) => {
    const d = dragRef.current
    if (!d) return

    if (d.type === 'pan') {
      const newOffset = {
        x: d.startOffX - (e.clientX - d.startScreenX),
        y: d.startOffY - (e.clientY - d.startScreenY),
      }
      offsetRef.current = newOffset
      setOffset(newOffset)
      return
    }

    const [cx, cy] = screenToCanvas(e.clientX, e.clientY)

    if (d.type === 'photo') {
      handlersRef.current.onUpdatePhoto(d.photoId, {
        x: d.startPhotoX + (e.clientX - d.startScreenX),
        y: d.startPhotoY + (e.clientY - d.startScreenY),
      })
      return
    }

    if (d.type === 'surface-move') {
      const dx = e.clientX - d.startScreenX
      const dy = e.clientY - d.startScreenY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.hasMoved = true
      const { photos } = spaceRef.current
      const photo = photos.find(p => p.id === d.photoId)
      if (!photo) return
      const dfx = dx / photo.displayW
      const dfy = dy / photo.displayH
      const newCorners = {}
      for (const [k, [fx, fy]] of Object.entries(d.startCorners)) {
        newCorners[k] = [fx + dfx, fy + dfy]
      }
      handlersRef.current.onUpdateSurface(d.surfaceId, { corners: newCorners })
      return
    }

    if (d.type === 'handle') {
      const { surfaces, photos } = spaceRef.current
      const surface = surfaces.find(s => s.id === d.surfaceId)
      const photo   = photos.find(p => p.id === surface?.photoId)
      if (!photo) return

      const fx = (cx - photo.x) / photo.displayW
      const fy = (cy - photo.y) / photo.displayH

      handlersRef.current.onUpdateSurface(d.surfaceId, {
        corners: { ...surface.corners, [d.corner]: [fx, fy] },
      })

      // Check snap
      const snap = findSnapTarget(surfaces, photos, d.surfaceId, d.corner, SNAP_THRESHOLD)
      setSnapInfo(snap)
    }
  }).current

  const globalMouseUp = useRef(() => {
    const d = dragRef.current
    // surface-move with no movement = click to select
    if (d?.type === 'surface-move' && !d.hasMoved) {
      handlersRef.current.onSelectSurface(d.surfaceId)
    }
    dragRef.current = null
    setSnapInfo(null)
    document.removeEventListener('mousemove', globalMouseMove)
    document.removeEventListener('mouseup',   globalMouseUp)
  }).current

  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', globalMouseMove)
      document.removeEventListener('mouseup',   globalMouseUp)
    }
  }, []) // eslint-disable-line

  // ── Pointer down handlers (per element type) ──────────────────────────────
  const onBgMouseDown = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = {
      type: 'pan',
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      startOffX: offsetRef.current.x,
      startOffY: offsetRef.current.y,
    }
    document.addEventListener('mousemove', globalMouseMove)
    document.addEventListener('mouseup',   globalMouseUp)
  }

  const onPhotoGripMouseDown = (e, photoId) => {
    e.stopPropagation()
    e.preventDefault()
    const photo = spaceRef.current.photos.find(p => p.id === photoId)
    if (!photo) return
    dragRef.current = {
      type: 'photo',
      photoId,
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      startPhotoX:  photo.x,
      startPhotoY:  photo.y,
    }
    document.addEventListener('mousemove', globalMouseMove)
    document.addEventListener('mouseup',   globalMouseUp)
  }

  const onHandleMouseDown = (e, surfaceId, corner) => {
    e.stopPropagation()
    e.preventDefault()
    dragRef.current = { type: 'handle', surfaceId, corner }
    document.addEventListener('mousemove', globalMouseMove)
    document.addEventListener('mouseup',   globalMouseUp)
  }

  const onSurfaceBodyMouseDown = (e, surfaceId) => {
    e.stopPropagation()
    e.preventDefault()
    const surface = spaceRef.current.surfaces.find(s => s.id === surfaceId)
    if (!surface) return
    dragRef.current = {
      type:         'surface-move',
      surfaceId,
      photoId:      surface.photoId,
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      startCorners: JSON.parse(JSON.stringify(surface.corners)),
      hasMoved:     false,
    }
    document.addEventListener('mousemove', globalMouseMove)
    document.addEventListener('mouseup',   globalMouseUp)
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  const toScreen = useCallback(([x, y]) => [x - offset.x, y - offset.y], [offset])

  function getSCC(surface) {
    const photo = space.photos.find(p => p.id === surface.photoId)
    if (!photo) return null
    const cc = cornersToCanvas(surface.corners, photo)
    return {
      tl: toScreen(cc.tl),
      tr: toScreen(cc.tr),
      bl: toScreen(cc.bl),
      br: toScreen(cc.br),
    }
  }

  function polyPoints(scc) {
    return `${scc.tl[0]},${scc.tl[1]} ${scc.tr[0]},${scc.tr[1]} ${scc.br[0]},${scc.br[1]} ${scc.bl[0]},${scc.bl[1]}`
  }

  const sortedPhotos = [...space.photos].sort((a, b) => a.zIndex - b.zIndex)

  return (
    <div
      className="sbc-viewport"
      ref={viewportRef}
      onMouseDown={onBgMouseDown}
    >
      {/* Photo layer — positioned photos with drag grips */}
      {sortedPhotos.map(photo => (
        <div
          key={photo.id}
          className="sbc-photo-wrap"
          style={{
            left:   photo.x - offset.x,
            top:    photo.y - offset.y,
            width:  photo.displayW,
            zIndex: photo.zIndex + 1,
          }}
        >
          {/* Drag grip bar */}
          <div
            className="sbc-photo-grip"
            onMouseDown={e => onPhotoGripMouseDown(e, photo.id)}
            title="Drag to reposition photo"
          >
            <span className="sbc-photo-grip-dots">⠿</span>
            <span className="sbc-photo-label">Photo {space.photos.indexOf(photo) + 1}</span>
            <div className="sbc-photo-grip-actions">
              <button
                className="sbc-photo-btn"
                title="Add surface on this photo"
                onMouseDown={e => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onAddSurfaceOnPhoto(photo.id) }}
              >+ Surface</button>
              <button
                className="sbc-photo-btn sbc-photo-btn--z"
                title="Send photo back"
                onMouseDown={e => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  onUpdatePhoto(photo.id, { zIndex: photo.zIndex - 1 })
                }}
              >↓</button>
              <button
                className="sbc-photo-btn sbc-photo-btn--z"
                title="Bring photo forward"
                onMouseDown={e => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  onUpdatePhoto(photo.id, { zIndex: photo.zIndex + 1 })
                }}
              >↑</button>
            </div>
          </div>
          <img
            src={photo.dataUrl}
            draggable={false}
            alt=""
            style={{ width: '100%', display: 'block' }}
          />
        </div>
      ))}

      {/* SVG surface overlay (covers full viewport) */}
      <svg
        className="sbc-svg"
        width="100%"
        height="100%"
        style={{ position: 'absolute', inset: 0, zIndex: 50 }}
      >
        {space.surfaces.map((surface) => {
          const scc = getSCC(surface)
          if (!scc) return null

          const color    = SURFACE_COLORS[surface.colorIdx ?? 0]
          const isActive = surface.id === activeSurfaceId
          const pts      = polyPoints(scc)
          const [cx, cy] = cornersCentroid(scc)

          return (
            <g key={surface.id}>
              {/* Quad fill — drag to move, click (no drag) to select */}
              <polygon
                points={pts}
                fill={`${color}22`}
                stroke={color}
                strokeWidth={isActive ? 2.5 : 1.5}
                strokeDasharray={isActive ? 'none' : '7 3'}
                style={{ cursor: 'move', pointerEvents: 'all' }}
                onMouseDown={e => onSurfaceBodyMouseDown(e, surface.id)}
              />

              {/* Surface name + dims at centroid */}
              <text
                x={cx}
                y={cy - 8}
                textAnchor="middle"
                fontSize="13"
                fontWeight="700"
                fill={color}
                style={{ pointerEvents: 'none', userSelect: 'none', paintOrder: 'stroke' }}
                stroke="#0d1117"
                strokeWidth="3"
              >{surface.name}</text>
              <text
                x={cx}
                y={cy + 8}
                textAnchor="middle"
                fontSize="11"
                fill={`${color}cc`}
                style={{ pointerEvents: 'none', userSelect: 'none', paintOrder: 'stroke' }}
                stroke="#0d1117"
                strokeWidth="3"
              >{surface.widthIn}" × {surface.heightIn}"</text>

              {/* Corner handles */}
              {(['tl', 'tr', 'bl', 'br']).map(corner => {
                const [hx, hy] = scc[corner]
                const isSnapping = (
                  snapInfo && dragRef.current?.surfaceId === surface.id && dragRef.current?.corner === corner
                )
                return (
                  <g key={corner}>
                    {/* Hit area (larger transparent circle) */}
                    <circle
                      cx={hx} cy={hy} r={HANDLE_R + 8}
                      fill="transparent"
                      style={{ cursor: 'crosshair', pointerEvents: 'all' }}
                      onMouseDown={e => onHandleMouseDown(e, surface.id, corner)}
                    />
                    {/* Visible handle */}
                    <circle
                      cx={hx} cy={hy} r={HANDLE_R}
                      fill={isSnapping ? '#fff' : (isActive ? color : `${color}99`)}
                      stroke={isSnapping ? color : '#1a2332'}
                      strokeWidth="2"
                      style={{ pointerEvents: 'none' }}
                    />
                    {/* Corner label */}
                    <text
                      x={hx}
                      y={hy + 4}
                      textAnchor="middle"
                      fontSize="8"
                      fill={isActive ? '#fff' : '#ffffff66'}
                      fontWeight="700"
                      style={{ pointerEvents: 'none', userSelect: 'none' }}
                    >{corner.toUpperCase()}</text>
                  </g>
                )
              })}
            </g>
          )
        })}

        {/* Snap indicator line */}
        {snapInfo && dragRef.current?.type === 'handle' && (() => {
          const activeSurf = space.surfaces.find(s => s.id === dragRef.current.surfaceId)
          const targetSurf = space.surfaces.find(s => s.id === snapInfo.surfaceId)
          if (!activeSurf || !targetSurf) return null
          const activeSCC = getSCC(activeSurf)
          const targetSCC = getSCC(targetSurf)
          if (!activeSCC || !targetSCC) return null
          const [ax, ay] = activeSCC[dragRef.current.corner]
          const [tx, ty] = targetSCC[snapInfo.corner]
          return (
            <line
              x1={ax} y1={ay} x2={tx} y2={ty}
              stroke="#ffffff66"
              strokeWidth="1"
              strokeDasharray="4 4"
            />
          )
        })()}
      </svg>

      {/* Empty state */}
      {space.photos.length === 0 && (
        <div className="sbc-empty">
          <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
            <rect x="4" y="12" width="48" height="32" rx="4" stroke="#4a9eff" strokeWidth="2"/>
            <circle cx="19" cy="24" r="5" stroke="#4a9eff" strokeWidth="2"/>
            <path d="M4 36l14-10 10 7 10-13 18 16" stroke="#4a9eff" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>
          </svg>
          <p>Click <strong>Add Photo</strong> to place your first room photo</p>
          <p className="sbc-empty-sub">Then drag the corner handles to define each surface</p>
        </div>
      )}
    </div>
  )
}
