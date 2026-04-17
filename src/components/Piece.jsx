import { useRef, useCallback } from 'react'

const HANDLE_PX = 9

const HANDLES = [
  { id: 'nw', cursor: 'nwse-resize', style: { top: -HANDLE_PX/2, left: -HANDLE_PX/2 } },
  { id: 'n',  cursor: 'ns-resize',   style: { top: -HANDLE_PX/2, left: '50%', transform: 'translateX(-50%)' } },
  { id: 'ne', cursor: 'nesw-resize', style: { top: -HANDLE_PX/2, right: -HANDLE_PX/2 } },
  { id: 'e',  cursor: 'ew-resize',   style: { top: '50%', right: -HANDLE_PX/2, transform: 'translateY(-50%)' } },
  { id: 'se', cursor: 'nwse-resize', style: { bottom: -HANDLE_PX/2, right: -HANDLE_PX/2 } },
  { id: 's',  cursor: 'ns-resize',   style: { bottom: -HANDLE_PX/2, left: '50%', transform: 'translateX(-50%)' } },
  { id: 'sw', cursor: 'nesw-resize', style: { bottom: -HANDLE_PX/2, left: -HANDLE_PX/2 } },
  { id: 'w',  cursor: 'ew-resize',   style: { top: '50%', left: -HANDLE_PX/2, transform: 'translateY(-50%)' } },
]

function useWindowDrag(onMove, onEnd) {
  const active = useRef(false)
  const start = useCallback((e) => {
    active.current = true
    const handleMove = (ev) => { if (active.current) onMove(ev) }
    const handleUp   = (ev) => {
      active.current = false
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      onEnd && onEnd(ev)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }, [onMove, onEnd])
  return start
}

export default function Piece({
  piece, scale, isSelected, onSelect, onMove, onResize, wallWidth, wallHeight,
  resizable,
}) {
  const dragRef = useRef(null)

  const pxX = piece.x * scale
  const pxY = piece.y * scale
  const pxW = piece.width  * scale
  const pxH = piece.height * scale

  /* ── Drag to move ──────────────────────────────────── */
  const startDragMove = useWindowDrag(
    useCallback((e) => {
      if (!dragRef.current) return
      const { wallRect, ox, oy } = dragRef.current
      const mx = (e.clientX - wallRect.left) / scale
      const my = (e.clientY - wallRect.top)  / scale
      const newX = Math.max(0, Math.min(wallWidth  - piece.width,  mx - ox))
      const newY = Math.max(0, Math.min(wallHeight - piece.height, my - oy))
      onMove(newX, newY)
    }, [scale, piece.width, piece.height, wallWidth, wallHeight, onMove]),
    null
  )

  const handlePieceMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    e.stopPropagation()
    onSelect()
    const wallEl = e.currentTarget.parentElement
    const wallRect = wallEl.getBoundingClientRect()
    const ox = (e.clientX - wallRect.left) / scale - piece.x
    const oy = (e.clientY - wallRect.top)  / scale - piece.y
    dragRef.current = { wallRect, ox, oy }
    startDragMove(e)
  }, [onSelect, scale, piece.x, piece.y, startDragMove])

  /* ── Touch drag to move ──────────────────────────────── */
  const handlePieceTouchStart = useCallback((e) => {
    if (e.touches.length !== 1) return
    e.stopPropagation()
    e.preventDefault()  // stop scroll gesture from starting when grabbing a piece
    const touch = e.touches[0]
    onSelect()
    const wallEl = e.currentTarget.parentElement
    const wallRect = wallEl.getBoundingClientRect()
    const ox = (touch.clientX - wallRect.left) / scale - piece.x
    const oy = (touch.clientY - wallRect.top)  / scale - piece.y
    const ref = { wallRect, ox, oy, moved: false }

    const handleTouchMove = (ev) => {
      if (ev.touches.length !== 1) return
      ev.preventDefault()  // prevent scroll while dragging a piece
      ref.moved = true
      const t = ev.touches[0]
      const mx = (t.clientX - ref.wallRect.left) / scale
      const my = (t.clientY - ref.wallRect.top)  / scale
      const newX = Math.max(0, Math.min(wallWidth  - piece.width,  mx - ref.ox))
      const newY = Math.max(0, Math.min(wallHeight - piece.height, my - ref.oy))
      onMove(newX, newY)
    }
    const handleTouchEnd = () => {
      window.removeEventListener('touchmove', handleTouchMove)
      window.removeEventListener('touchend', handleTouchEnd)
    }
    window.addEventListener('touchmove', handleTouchMove, { passive: false })
    window.addEventListener('touchend', handleTouchEnd, { passive: true })
  }, [onSelect, scale, piece.x, piece.y, piece.width, piece.height, wallWidth, wallHeight, onMove])

  /* ── Resize handles ────────────────────────────────── */
  const resizeRef = useRef(null)

  const startDragResize = useWindowDrag(
    useCallback((e) => {
      if (!resizeRef.current) return
      const { wallRect, handle, sx, sy, sw, sh } = resizeRef.current
      const mx = (e.clientX - wallRect.left) / scale
      const my = (e.clientY - wallRect.top)  / scale

      let newW = sw, newH = sh, newX = sx, newY = sy

      if (handle.includes('e')) newW = Math.max(2, mx - sx)
      if (handle.includes('s')) newH = Math.max(2, my - sy)
      if (handle.includes('w')) {
        newW = Math.max(2, sx + sw - mx)
        newX = Math.min(mx, sx + sw - 2)
      }
      if (handle.includes('n')) {
        newH = Math.max(2, sy + sh - my)
        newY = Math.min(my, sy + sh - 2)
      }

      // Clamp to wall bounds
      newX = Math.max(0, newX)
      newY = Math.max(0, newY)
      newW = Math.min(newW, wallWidth  - newX)
      newH = Math.min(newH, wallHeight - newY)

      onResize(newW, newH, newX, newY)
    }, [scale, wallWidth, wallHeight, onResize]),
    null
  )

  const handleResizeMouseDown = useCallback((e, handle) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const wallEl = e.currentTarget.closest('.wall')
    const wallRect = wallEl.getBoundingClientRect()
    resizeRef.current = {
      wallRect, handle,
      sx: piece.x, sy: piece.y,
      sw: piece.width, sh: piece.height,
    }
    startDragResize(e)
  }, [piece, startDragResize])

  /* ── Render ────────────────────────────────────────── */


  return (
    <div
      className={`piece${isSelected ? ' piece--selected' : ''}${piece.transparent ? ' piece--transparent' : ''}`}

      onMouseDown={handlePieceMouseDown}
      onTouchStart={handlePieceTouchStart}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position:  'absolute',
        left:      pxX,
        top:       pxY,
        width:     pxW,
        height:    pxH,
        backgroundColor: piece.transparent ? 'transparent' : piece.color,
        backgroundImage: piece.image ? `url(${piece.image})` : undefined,
        backgroundSize:     piece.transparent ? 'contain' : 'cover',
        backgroundRepeat:   'no-repeat',
        backgroundPosition: 'center',
        cursor: 'grab',
        zIndex: isSelected ? 50 : 1,
        userSelect: 'none',
        touchAction: 'none',
      }}
    >
      {/* Overlay tint so image is legible */}
      {piece.image && !piece.transparent && <div className="piece-img-tint" />}

      {/* Selection border + resize handles (only when resizable=true) */}
      {isSelected && (
        <>
          <div className="piece-selection-border" />
          {resizable && HANDLES.map(h => (
            <div
              key={h.id}
              className="resize-handle"
              style={{ ...h.style, cursor: h.cursor }}
              onMouseDown={(e) => handleResizeMouseDown(e, h.id)}
            />
          ))}
        </>
      )}
    </div>
  )
}
