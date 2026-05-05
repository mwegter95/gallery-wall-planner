/**
 * EraseModal — Content-aware fill / object eraser overlay.
 *
 * Shows the surface image on a canvas and lets the user paint a selection
 * using one of four tools:
 *   rect     – click-drag rectangle
 *   ellipse  – click-drag ellipse
 *   poly     – click to add vertices, double-click (or click near start) to close
 *   lasso    – freehand brush (click+drag)
 *
 * After the user draws their selection they press "Fill" which posts the
 * ImageData + mask to inpaintWorker.js and replaces the masked region with
 * synthesised content-aware fill.
 */
import { useState, useEffect, useRef, useCallback } from 'react'

/* ── Tool icons (inline SVG) ──────────────────────────────────────────────── */
const TOOLS = [
  { id: 'rect',    label: 'Rectangle',  icon: '⬜' },
  { id: 'ellipse', label: 'Ellipse',    icon: '⬤' },
  { id: 'poly',    label: 'Polygon',    icon: '⬡' },
  { id: 'lasso',   label: 'Lasso',      icon: '✍' },
]

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = src
  })
}

function canvasToDataUrl(canvas) { return canvas.toDataURL('image/png') }

/* ── Component ──────────────────────────────────────────────────────────────── */
/**
 * @param {string}   imageUrl  – the source image URL to erase from
 * @param {string}   [title]   – optional header title (default: "Erase Object")
 * @param {function} onApply   – called with newDataUrl each time a fill is applied
 * @param {function} onClose   – called when the user presses Done / closes
 */
export default function EraseModal({ imageUrl, title = 'Erase Object', onApply, onClose }) {
  /* Track the "current working image" — starts from imageUrl, updates after each apply */
  const [workingUrl, setWorkingUrl] = useState(imageUrl)

  const [tool,     setTool]     = useState('rect')
  const [status,   setStatus]   = useState(null)    // null | 'processing' | 'done' | 'error'
  const [progress, setProgress] = useState(0)
  const [errMsg,   setErrMsg]   = useState('')
  const [hasMask,  setHasMask]  = useState(false)   // true once user has drawn something
  const [brushSize, setBrushSize] = useState(20)    // lasso brush radius in display px

  /* Canvas refs */
  const canvasRef   = useRef(null)  // visible overlay canvas (draw selections)
  const maskCanvasRef = useRef(null) // offscreen mask accumulator (same pixel size as image)
  const workerRef   = useRef(null)

  /* State persisted inside useRef so event handlers always see current values */
  const toolRef      = useRef(tool)
  const brushRef     = useRef(brushSize)
  useEffect(() => { toolRef.current = tool }, [tool])
  useEffect(() => { brushRef.current = brushSize }, [brushSize])

  /* Image natural dimensions */
  const imgRef   = useRef(null)   // the loaded Image object
  const scaleRef = useRef(1)      // display scale factor (image→canvas)

  /* Interaction state */
  const dragging   = useRef(false)
  const startPt    = useRef({ x: 0, y: 0 })  // in IMAGE coords
  const polyPts    = useRef([])               // polygon vertices in IMAGE coords

  /* ── Reload canvas when workingUrl changes (after each apply) ───────────── */
  useEffect(() => {
    if (!workingUrl) return
    loadImage(workingUrl).then(img => {
      imgRef.current = img

      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width  = img.naturalWidth
      canvas.height = img.naturalHeight

      /* mask canvas — same pixel dimensions, monochrome */
      const mc = maskCanvasRef.current
      mc.width  = img.naturalWidth
      mc.height = img.naturalHeight

      scaleRef.current = canvas.clientWidth / img.naturalWidth

      /* Draw the source image */
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0)
    })
  }, [workingUrl])

  /* ── Convert mouse event to image-space coordinates ─────────────────────── */
  function evtToImg(e) {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width  / rect.width
    const scaleY = canvas.height / rect.height
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top)  * scaleY,
    }
  }

  /* ── Redraw overlay ──────────────────────────────────────────────────────── */
  function redrawOverlay(tempShape = null) {
    const canvas = canvasRef.current
    const img    = imgRef.current
    if (!canvas || !img) return
    const ctx = canvas.getContext('2d')

    /* 1. Source image */
    ctx.drawImage(img, 0, 0)

    /* 2. Accumulated mask (semi-transparent red tint) */
    const mc = maskCanvasRef.current
    ctx.save()
    ctx.globalAlpha = 0.38
    ctx.fillStyle = '#ff3333'
    ctx.drawImage(mc, 0, 0)
    ctx.restore()

    /* 3. In-progress shape */
    if (tempShape) {
      ctx.save()
      ctx.globalAlpha = 0.55
      ctx.fillStyle = '#ff3333'
      ctx.strokeStyle = '#ff0000'
      ctx.lineWidth = 2
      ctx.setLineDash([5, 4])
      const { type, x, y, x2, y2, pts } = tempShape
      if (type === 'rect') {
        ctx.fillRect(x, y, x2 - x, y2 - y)
        ctx.strokeRect(x, y, x2 - x, y2 - y)
      } else if (type === 'ellipse') {
        const cx = (x + x2) / 2, cy = (y + y2) / 2
        const rx = Math.abs(x2 - x) / 2, ry = Math.abs(y2 - y) / 2
        ctx.beginPath()
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
        ctx.fill(); ctx.stroke()
      } else if (type === 'poly') {
        ctx.beginPath()
        pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y))
        ctx.closePath()
        ctx.fill(); ctx.stroke()
      }
      ctx.restore()
    }
  }

  /* ── Commit a shape into the mask canvas ────────────────────────────────── */
  function commitToMask(shape) {
    const mc  = maskCanvasRef.current
    if (!mc) return
    const ctx = mc.getContext('2d')
    ctx.fillStyle   = '#ff2222'
    ctx.strokeStyle = '#ff2222'

    const { type, x, y, x2, y2, pts } = shape
    if (type === 'rect') {
      ctx.fillRect(x, y, x2 - x, y2 - y)
    } else if (type === 'ellipse') {
      const cx = (x + x2) / 2, cy = (y + y2) / 2
      const rx = Math.abs(x2 - x) / 2, ry = Math.abs(y2 - y) / 2
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
      ctx.fill()
    } else if (type === 'poly') {
      ctx.beginPath()
      pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y))
      ctx.closePath()
      ctx.fill()
    } else if (type === 'lasso') {
      // pts contains a series of brush circles
      pts.forEach(p => {
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
      })
    }
    setHasMask(true)
  }

  /* ── Pointer handlers ────────────────────────────────────────────────────── */
  const onPointerDown = useCallback(e => {
    if (status === 'processing') return
    e.currentTarget.setPointerCapture(e.pointerId)
    const pt = evtToImg(e)
    const t  = toolRef.current

    if (t === 'poly') {
      const pts = polyPts.current
      if (pts.length > 2) {
        const d = Math.hypot(pt.x - pts[0].x, pt.y - pts[0].y)
        if (d < 20) {
          /* Close polygon */
          commitToMask({ type: 'poly', pts: [...pts] })
          polyPts.current = []
          redrawOverlay()
          return
        }
      }
      pts.push(pt)
      redrawOverlay({ type: 'poly', pts: [...pts], x: 0, y: 0, x2: 0, y2: 0 })
      return
    }

    dragging.current  = true
    startPt.current   = pt

    if (t === 'lasso') {
      const canvas = canvasRef.current
      const rect   = canvas.getBoundingClientRect()
      const dispR  = brushRef.current
      const scaleX = canvas.width  / rect.width
      // Convert display brush radius to image pixels
      const r = dispR * scaleX
      polyPts.current = [{ x: pt.x, y: pt.y, r }]
      const mc = maskCanvasRef.current
      const ctx = mc.getContext('2d')
      ctx.fillStyle = '#ff2222'
      ctx.beginPath(); ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2); ctx.fill()
      setHasMask(true)
      redrawOverlay()
    }
  }, [status]) // eslint-disable-line

  const onPointerMove = useCallback(e => {
    if (status === 'processing') return
    if (!dragging.current && toolRef.current !== 'poly') return
    const pt = evtToImg(e)
    const t  = toolRef.current
    const s  = startPt.current

    if (t === 'lasso' && dragging.current) {
      const canvas = canvasRef.current
      const rect   = canvas.getBoundingClientRect()
      const scaleX = canvas.width / rect.width
      const r = brushRef.current * scaleX
      const mc = maskCanvasRef.current
      const ctx = mc.getContext('2d')
      ctx.fillStyle = '#ff2222'
      ctx.beginPath(); ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2); ctx.fill()
      setHasMask(true)
      redrawOverlay()
      return
    }

    if (t === 'poly') {
      const pts = polyPts.current
      if (pts.length > 0) {
        redrawOverlay({ type: 'poly', pts: [...pts, pt], x: 0, y: 0, x2: 0, y2: 0 })
      }
      return
    }

    redrawOverlay({
      type: t, x: s.x, y: s.y, x2: pt.x, y2: pt.y,
      pts: [],
    })
  }, [status]) // eslint-disable-line

  const onPointerUp = useCallback(e => {
    if (!dragging.current) return
    dragging.current = false
    if (status === 'processing') return
    const pt = evtToImg(e)
    const t  = toolRef.current
    const s  = startPt.current

    if (t === 'lasso') { redrawOverlay(); return }

    if (t === 'rect' || t === 'ellipse') {
      const minX = Math.min(s.x, pt.x), maxX = Math.max(s.x, pt.x)
      const minY = Math.min(s.y, pt.y), maxY = Math.max(s.y, pt.y)
      if (maxX - minX < 4 || maxY - minY < 4) return
      commitToMask({ type: t, x: minX, y: minY, x2: maxX, y2: maxY })
      redrawOverlay()
    }
  }, [status]) // eslint-disable-line

  /* ── Clear selection ─────────────────────────────────────────────────────── */
  function clearMask() {
    const mc = maskCanvasRef.current
    if (!mc) return
    const ctx = mc.getContext('2d')
    ctx.clearRect(0, 0, mc.width, mc.height)
    polyPts.current = []
    setHasMask(false)
    redrawOverlay()
  }

  /* ── Run inpainting ──────────────────────────────────────────────────────── */
  function runFill() {
    const canvas = canvasRef.current
    const mc     = maskCanvasRef.current
    const img    = imgRef.current
    if (!canvas || !mc || !img) return

    /* Build ImageData for the source image */
    const tmpCtx = document.createElement('canvas').getContext('2d')
    tmpCtx.canvas.width = img.naturalWidth; tmpCtx.canvas.height = img.naturalHeight
    tmpCtx.drawImage(img, 0, 0)
    const imageData = tmpCtx.getImageData(0, 0, img.naturalWidth, img.naturalHeight)

    /* Build mask: white pixels → 1, black → 0 */
    const mCtx = mc.getContext('2d')
    const rawMask = mCtx.getImageData(0, 0, mc.width, mc.height)
    const maskData = new Uint8Array(mc.width * mc.height)
    for (let i = 0; i < maskData.length; i++) {
      maskData[i] = rawMask.data[i * 4] > 127 ? 1 : 0
    }

    setStatus('processing')
    setProgress(0)

    if (workerRef.current) { workerRef.current.terminate() }
    const worker = new Worker(new URL('../utils/inpaintWorker.js', import.meta.url))
    workerRef.current = worker

    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        setProgress(data.pct)
      } else if (data.type === 'done') {
        /* Paint result onto canvas */
        const outCanvas = document.createElement('canvas')
        outCanvas.width  = data.imageData.width
        outCanvas.height = data.imageData.height
        const outCtx = outCanvas.getContext('2d')
        const iData  = new ImageData(
          new Uint8ClampedArray(data.imageData.data),
          data.imageData.width, data.imageData.height,
        )
        outCtx.putImageData(iData, 0, 0)

        /* Update visible canvas */
        const ctx = canvas.getContext('2d')
        ctx.drawImage(outCanvas, 0, 0)

        /* Store for export */
        imgRef.current = null   // no longer the original
        const newUrl = canvasToDataUrl(outCanvas)
        setStatus('done')
        clearMask()
        worker.terminate()
        workerRef.current = null

        /* Update workingUrl so the next erase starts from this result */
        setWorkingUrl(newUrl)
        loadImage(newUrl).then(i => { imgRef.current = i })
        /* Notify parent — this is a non-destructive layer on top of the original */
        onApply(newUrl)
      } else if (data.type === 'error') {
        setErrMsg(data.message)
        setStatus('error')
        worker.terminate()
        workerRef.current = null
      }
    }

    worker.postMessage({
      type: 'inpaint',
      imageData: { width: imageData.width, height: imageData.height, data: imageData.data.buffer },
      mask:      { width: mc.width, height: mc.height, data: maskData.buffer },
    }, [imageData.data.buffer, maskData.buffer])
  }

  /* ── Render ──────────────────────────────────────────────────────────────── */
  return (
    <div className="erase-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="erase-modal">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="erase-modal-header">
          <span className="erase-modal-title">{title}</span>
          <div className="erase-modal-tools">
            {TOOLS.map(t => (
              <button
                key={t.id}
                className={`erase-tool-btn${tool === t.id ? ' erase-tool-btn--active' : ''}`}
                title={t.label}
                onClick={() => { setTool(t.id); polyPts.current = [] }}
                disabled={status === 'processing'}
              >{t.icon} <span>{t.label}</span></button>
            ))}
            {tool === 'lasso' && (
              <label className="erase-brush-size">
                Brush
                <input
                  type="range" min={5} max={80} step={1}
                  value={brushSize}
                  onChange={e => setBrushSize(Number(e.target.value))}
                />
                <span>{brushSize}px</span>
              </label>
            )}
          </div>
          <div className="erase-modal-actions">
            <button
              className="erase-action-btn erase-action-btn--clear"
              onClick={clearMask}
              disabled={!hasMask || status === 'processing'}
            >Clear</button>
            <button
              className="erase-action-btn erase-action-btn--fill"
              onClick={runFill}
              disabled={!hasMask || status === 'processing'}
            >
              {status === 'processing'
                ? `Filling… ${progress}%`
                : 'Fill Selection'}
            </button>
            <button
              className="erase-action-btn erase-action-btn--close"
              onClick={onClose}
            >Done</button>
          </div>
        </div>

        {/* ── Instruction hint ───────────────────────────────────────────── */}
        <div className="erase-hint">
          {tool === 'rect'    && 'Click and drag to draw a rectangle over the object to erase'}
          {tool === 'ellipse' && 'Click and drag to draw an ellipse over the object to erase'}
          {tool === 'poly'    && 'Click to place vertices — click near the first point (or double-click) to close the polygon'}
          {tool === 'lasso'   && 'Click and drag to paint over the object to erase'}
        </div>

        {/* ── Canvas area ────────────────────────────────────────────────── */}
        <div className={`erase-canvas-wrap erase-tool--${tool}`}>
          <canvas
            ref={canvasRef}
            className="erase-canvas"
            style={{
              cursor: tool === 'lasso' ? `none` : tool === 'poly' ? 'crosshair' : 'crosshair',
              userSelect: 'none',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
          {/* Hidden offscreen mask accumulator */}
          <canvas ref={maskCanvasRef} style={{ display: 'none' }} />

          {/* Lasso brush cursor */}
          {tool === 'lasso' && (
            <LassoCursor size={brushSize} canvasRef={canvasRef} />
          )}
        </div>

        {/* ── Progress bar ───────────────────────────────────────────────── */}
        {status === 'processing' && (
          <div className="erase-progress-bar-wrap">
            <div className="erase-progress-bar" style={{ width: `${progress}%` }} />
            <span className="erase-progress-label">Content-aware fill — {progress}%</span>
          </div>
        )}
        {status === 'done' && (
          <div className="erase-status erase-status--done">Fill applied. You can make more selections or press Done.</div>
        )}
        {status === 'error' && (
          <div className="erase-status erase-status--error">Error: {errMsg}</div>
        )}
      </div>
    </div>
  )
}

/* ── Lasso cursor SVG (follows mouse inside canvas) ──────────────────────── */
function LassoCursor({ size, canvasRef }) {
  const [pos, setPos] = useState({ x: -100, y: -100 })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const move = e => {
      const rect = canvas.getBoundingClientRect()
      setPos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
    }
    const leave = () => setPos({ x: -100, y: -100 })
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerleave', leave)
    return () => {
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerleave', leave)
    }
  }, [canvasRef])

  return (
    <div
      className="erase-lasso-cursor"
      style={{
        left: pos.x, top: pos.y,
        width: size * 2, height: size * 2,
        marginLeft: -size, marginTop: -size,
      }}
    />
  )
}
