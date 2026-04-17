import { useState, useRef, useEffect, useCallback } from 'react'
import { warpPerspectiveAsync } from '../utils/homography'

/* ── Corner colours: TL · TR · BR · BL (matches WallSetup) ─ */
const PCROP_COLORS = ['#f97316', '#22d3ee', '#a78bfa', '#34d399']

/* ── Magic-select: sensitivity mapping ───────────────────── */
const SENS_DEFAULT   = 6
const SENS_TO_THRESH = (s) => Math.round((10 - s) / 10 * 210 + 20) // 20 – 230
const FEATHER        = 18

/* ── Helpers ─────────────────────────────────────────────── */
function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image()
    img.onload  = () => res(img)
    img.onerror = rej
    img.src     = src
  })
}

function imageToImageData(img, maxPx = 1600) {
  const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.round(img.naturalWidth  * scale)
  const h = Math.round(img.naturalHeight * scale)
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h })
  c.getContext('2d').drawImage(img, 0, 0, w, h)
  return c.getContext('2d').getImageData(0, 0, w, h)
}

/* ── Edge flood-fill: grow background from all 4 image borders ─
   tolerance 0-100 → how loosely to accept colour-similar neighbours */
function computeFloodMask(imageData, tolerance) {
  const { data, width: w, height: h } = imageData
  const n = w * h
  const isBg  = new Uint8Array(n)
  const queue = new Int32Array(n + 4)
  let qHead = 0, qTail = 0
  const enqueue = (idx) => {
    if (idx < 0 || idx >= n || isBg[idx]) return
    isBg[idx] = 1; queue[qTail++] = idx
  }
  for (let x = 0; x < w; x++) { enqueue(x); enqueue((h - 1) * w + x) }
  for (let y = 1; y < h - 1; y++) { enqueue(y * w); enqueue(y * w + w - 1) }
  const thresh = tolerance * 2.55
  while (qHead < qTail) {
    const idx = queue[qHead++]
    const x = idx % w, y = (idx / w) | 0, i4 = idx * 4
    const r = data[i4], g = data[i4 + 1], b = data[i4 + 2]
    const tryN = (ni) => {
      if (ni < 0 || ni >= n || isBg[ni]) return
      const n4 = ni * 4, dr = data[n4]-r, dg = data[n4+1]-g, db = data[n4+2]-b
      if (Math.sqrt(dr*dr + dg*dg + db*db) <= thresh) enqueue(ni)
    }
    if (x > 0)   tryN(idx - 1)
    if (x < w-1) tryN(idx + 1)
    if (y > 0)   tryN(idx - w)
    if (y < h-1) tryN(idx + w)
  }
  const alpha = new Uint8ClampedArray(n)
  for (let i = 0; i < n; i++) alpha[i] = isBg[i] ? 0 : 255
  return alpha
}

/* ══════════════════════════════════════════════════════════
   PERSPECTIVE CROP  (4-corner homography warp, like WallSetup)
   ══════════════════════════════════════════════════════════ */
const DEFAULT_CORNERS = [[0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95]]

function PerspectiveCrop({ imageUrl, onApply, onSkip }) {
  const imgRef     = useRef(null)
  const cropWrapRef = useRef(null)
  const [size,    setSize]    = useState({ w: 0, h: 0 })
  const [corners, setCorners] = useState(DEFAULT_CORNERS)
  const cornersRef = useRef(corners)
  useEffect(() => { cornersRef.current = corners }, [corners])

  /* ── Block context-menu and prevent scroll-start over image/handle zone ── */
  useEffect(() => {
    const el = cropWrapRef.current
    if (!el) return
    const prevent = (e) => e.preventDefault()
    el.addEventListener('contextmenu', prevent, false)
    el.addEventListener('touchstart', prevent, { passive: false })
    return () => {
      el.removeEventListener('contextmenu', prevent)
      el.removeEventListener('touchstart', prevent)
    }
  }, [])

  const [warping,    setWarping]    = useState(false)
  const [warpPct,    setWarpPct]    = useState(0)
  const [imgError,   setImgError]   = useState(false)
  const [displayUrl, setDisplayUrl] = useState(imageUrl)
  const [isRotating, setIsRotating] = useState(false)

  /* ── Rotate image data 90° CW or CCW ─────────────────── */
  const rotateImage = useCallback(async (deg) => {
    setIsRotating(true)
    try {
      const img = await loadImage(displayUrl)
      const swap = deg % 180 !== 0
      const cw = swap ? img.naturalHeight : img.naturalWidth
      const ch = swap ? img.naturalWidth  : img.naturalHeight
      const canvas = document.createElement('canvas')
      canvas.width = cw; canvas.height = ch
      const ctx = canvas.getContext('2d')
      ctx.translate(cw / 2, ch / 2)
      ctx.rotate((deg * Math.PI) / 180)
      ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2)
      setDisplayUrl(canvas.toDataURL('image/jpeg', 0.93))
      setCorners(DEFAULT_CORNERS)
    } finally {
      setIsRotating(false)
    }
  }, [displayUrl])

  /* ── Measure displayed image ─────────────────────────── */
  useEffect(() => {
    const measure = () => {
      if (imgRef.current) setSize({ w: imgRef.current.offsetWidth, h: imgRef.current.offsetHeight })
    }
    const img = imgRef.current
    if (img?.complete && img.naturalWidth) measure()
    img?.addEventListener('load', measure)
    const ro = new ResizeObserver(measure)
    if (img) ro.observe(img)
    return () => { img?.removeEventListener('load', measure); ro.disconnect() }
  }, [])

  /* ── Shared corner-move logic ───────────────────────── */
  const movePcCorner = useCallback((clientX, clientY, idx) => {
    if (!imgRef.current) return
    const rect = imgRef.current.getBoundingClientRect()
    const nx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const ny = Math.max(0, Math.min(1, (clientY - rect.top)  / rect.height))
    setCorners(c => c.map((pt, i) => i === idx ? [nx, ny] : pt))
  }, [])

  /* ── Drag a corner (mouse) ───────────────────────────── */
  const handleDrag = useCallback((e, idx) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    const move = (ev) => movePcCorner(ev.clientX, ev.clientY, idx)
    const up   = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup',   up)
  }, [movePcCorner])

  /* ── Drag a corner (touch) ───────────────────────────── */
  const handleTouchDrag = useCallback((e, idx) => {
    if (e.touches.length !== 1) return
    e.stopPropagation(); e.preventDefault()
    const move = (ev) => { ev.preventDefault(); if (ev.touches[0]) movePcCorner(ev.touches[0].clientX, ev.touches[0].clientY, idx) }
    const up   = () => { window.removeEventListener('touchmove', move); window.removeEventListener('touchend', up) }
    window.addEventListener('touchmove', move, { passive: false })
    window.addEventListener('touchend',  up,   { passive: true })
  }, [movePcCorner])

  /* ── Apply perspective warp ──────────────────────────── */
  const handleApply = useCallback(async () => {
    const img = imgRef.current
    if (!img?.naturalWidth) return
    const iw = img.naturalWidth, ih = img.naturalHeight
    const px = cornersRef.current.map(([nx, ny]) => [nx * iw, ny * ih])
    // Note: displayUrl is already baked with any rotation applied
    // Output size = average of opposing side lengths
    const dist = ([ax, ay], [bx, by]) => Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2)
    const outW = Math.round((dist(px[0], px[1]) + dist(px[3], px[2])) / 2)
    const outH = Math.round((dist(px[0], px[3]) + dist(px[1], px[2])) / 2)
    setWarping(true); setWarpPct(0)
    try {
      const dataUrl = await warpPerspectiveAsync(img, px, outW, outH,
        (p) => setWarpPct(Math.round(p * 100)))
      onApply(dataUrl, { transparent: false })
    } catch (err) {
      console.error('Warp failed:', err)
      setWarping(false)
    }
  }, [onApply])

  const pts = size.w > 0 ? corners.map(([nx, ny]) => [nx * size.w, ny * size.h]) : null

  return (
    <div className="cm-body">
      <div className="cm-image-area">
        <div className="crop-wrap" style={{ cursor: 'default' }} ref={cropWrapRef}>
          <img
            ref={imgRef}
            src={displayUrl}
            className="crop-img"
            alt=""
            draggable={false}
            onError={() => setImgError(true)}
          />

          {imgError && (
            <div className="pc-img-error">
              ⚠️ Could not display image. Try exporting as JPEG and re-uploading.
            </div>
          )}

          {pts && !warping && (
            <>
              <svg className="ws-svg" width={size.w} height={size.h}>
                <polygon
                  points={pts.map(p => p.join(',')).join(' ')}
                  fill="rgba(124,111,247,0.10)"
                  stroke="rgba(255,255,255,0.75)"
                  strokeWidth={1.5}
                  strokeDasharray="7 4"
                />
              </svg>
              {corners.map(([nx, ny], idx) => (
                <div
                  key={idx}
                  className="ws-handle"
                  style={{
                    left: nx * size.w,
                    top:  ny * size.h,
                    borderColor:     PCROP_COLORS[idx],
                    backgroundColor: PCROP_COLORS[idx] + '55',
                    touchAction:     'none',
                  }}
                  data-label={['TL', 'TR', 'BR', 'BL'][idx]}
                  onMouseDown={(e) => handleDrag(e, idx)}
                  onTouchStart={(e) => handleTouchDrag(e, idx)}
                  onContextMenu={(e) => e.preventDefault()}
                />
              ))}
            </>
          )}

          {warping && (
            <div className="ws-progress-overlay" style={{ borderRadius: 4 }}>
              <div className="ws-progress-bar">
                <div className="ws-progress-fill" style={{ width: `${warpPct}%` }} />
              </div>
              <p className="ws-progress-text">Warping… {warpPct}%</p>
            </div>
          )}
        </div>
      </div>

      <div className="cm-footer">
        <button className="btn btn-ghost" onClick={onSkip} disabled={warping || isRotating}>Use Full Image</button>
        <div className="cm-rotate-btns">
          <button
            className="btn btn-ghost btn-sm"
            title="Rotate 90° counter-clockwise"
            onClick={() => rotateImage(-90)}
            disabled={warping || isRotating}
          >↺ 90°</button>
          <button
            className="btn btn-ghost btn-sm"
            title="Rotate 90° clockwise"
            onClick={() => rotateImage(90)}
            disabled={warping || isRotating}
          >↻ 90°</button>
        </div>
        <button className="btn btn-primary" onClick={handleApply} disabled={warping || isRotating}>
          {warping ? `Warping… ${warpPct}%` : isRotating ? 'Rotating…' : '✓ Apply Warp'}
        </button>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════
   MAGIC SELECT  (edge flood + smart brush + AI + warp)
   ══════════════════════════════════════════════════════════ */
function MagicSelect({ imageUrl, onApply, onSkip }) {
  /* ── Core phase state ──────────────────────────────────── */
  const [phase,        setPhase]        = useState('idle')    // idle|edge-computing|edge-select|loading|ready|warp|error
  const [loadMsg,      setLoadMsg]      = useState('')
  const [loadPct,      setLoadPct]      = useState(0)
  const [modelQuality, setModelQuality] = useState('isnet_fp16')

  /* ── Mask controls ─────────────────────────────────────── */
  const [sensitivity,   setSensitivity]   = useState(SENS_DEFAULT)
  const [edgeTolerance, setEdgeTolerance] = useState(35)

  /* ── Brush state ───────────────────────────────────────── */
  const [brushType,    _setBrushType]    = useState('smart')   // 'smart' | 'manual'
  const [brushMode,    _setBrushMode]    = useState('add')     // 'add'   | 'erase'
  const [brushRadius,  _setBrushRadius] = useState(28)
  const [smartTol,     _setSmartTol]    = useState(28)         // smart-brush colour tolerance 0–80
  const [cursor,       setCursor]       = useState(null)
  const [isPainting,   setIsPainting]   = useState(false)

  const brushTypeRef   = useRef('smart')
  const brushModeRef   = useRef('add')
  const brushRadiusRef = useRef(28)
  const smartTolRef    = useRef(28)
  const isPaintingRef  = useRef(false)
  const setBrushType   = useCallback((v) => { brushTypeRef.current = v;   _setBrushType(v)   }, [])
  const setBrushMode   = useCallback((m) => { brushModeRef.current = m;   _setBrushMode(m)   }, [])
  const setBrushRadius = useCallback((r) => { brushRadiusRef.current = r; _setBrushRadius(r) }, [])
  const setSmartTol    = useCallback((t) => { smartTolRef.current = t;    _setSmartTol(t)    }, [])

  /* ── Image / mask data ─────────────────────────────────── */
  const origDataRef  = useRef(null)   // ImageData (original ≤1600px)
  const aiMaskRef    = useRef(null)   // ImageData (grayscale AI mask)
  const userAlphaRef = useRef(null)   // Uint8ClampedArray (1 byte per pixel)

  /* ── Canvas refs ───────────────────────────────────────── */
  const canvasRef = useRef(null)
  const wrapRef    = useRef(null)
  const warpWrapRef = useRef(null)

  /* ── Warp-phase state ────────────────────────── */
  const [warpCutoutUrl, setWarpCutoutUrl] = useState(null)
  const [warpCorners,   setWarpCorners]   = useState(DEFAULT_CORNERS)
  const warpCornersRef  = useRef(DEFAULT_CORNERS)
  useEffect(() => { warpCornersRef.current = warpCorners }, [warpCorners])
  const warpImgRef      = useRef(null)
  const [warpSize,      setWarpSize]      = useState({ w: 0, h: 0 })
  const [warpWarping,   setWarpWarping]   = useState(false)
  const [warpPct,       setWarpPct]       = useState(0)

  /* ── Block context-menu + scroll on warp-phase handle area ── */
  useEffect(() => {
    if (phase !== 'warp') return
    const el = warpWrapRef.current
    if (!el) return
    const prevent = (e) => e.preventDefault()
    el.addEventListener('contextmenu', prevent, false)
    el.addEventListener('touchstart', prevent, { passive: false })
    return () => {
      el.removeEventListener('contextmenu', prevent)
      el.removeEventListener('touchstart', prevent)
    }
  }, [phase])

  /* ── fitCanvas: scale canvas to fill wrap ──────────────── */
  const fitCanvas = useCallback(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current
    if (!canvas?.width || !wrap?.clientWidth || !wrap?.clientHeight) return
    const scale = Math.min(wrap.clientWidth / canvas.width, wrap.clientHeight / canvas.height)
    canvas.style.width  = Math.round(canvas.width  * scale) + 'px'
    canvas.style.height = Math.round(canvas.height * scale) + 'px'
  }, [])

  useEffect(() => {
    const wrap = wrapRef.current; if (!wrap) return
    fitCanvas()
    const ro = new ResizeObserver(fitCanvas)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [fitCanvas, phase])

  /* ── renderCanvas ──────────────────────────────────────── */
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current, orig = origDataRef.current, alpha = userAlphaRef.current
    if (!canvas || !orig || !alpha) return
    const { width: w, height: h } = orig
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    const idata = ctx.createImageData(w, h)
    const d = idata.data, o = orig.data
    const cs = 14
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i  = (y * w + x) * 4
        const af = alpha[y * w + x] / 255
        const cb = ((Math.floor(x / cs) + Math.floor(y / cs)) % 2 === 0) ? 136 : 85
        d[i]     = Math.round(o[i]   * af + cb * (1 - af))
        d[i + 1] = Math.round(o[i+1] * af + cb * (1 - af))
        d[i + 2] = Math.round(o[i+2] * af + cb * (1 - af))
        d[i + 3] = 255
      }
    }
    ctx.putImageData(idata, 0, 0)
    requestAnimationFrame(fitCanvas)
  }, [fitCanvas])

  /* ── Init alpha from AI mask ───────────────────────────── */
  const initAlphaFromMask = useCallback((thresh) => {
    const orig = origDataRef.current, mask = aiMaskRef.current
    if (!orig || !mask) return
    const n = orig.width * orig.height, m = mask.data
    if (!userAlphaRef.current) userAlphaRef.current = new Uint8ClampedArray(n)
    const a = userAlphaRef.current
    for (let i = 0; i < n; i++) {
      const mv = m[i * 4]
      a[i] = mv < thresh - FEATHER ? 0
           : mv > thresh + FEATHER ? 255
           : Math.round((mv - (thresh - FEATHER)) / (FEATHER * 2) * 255)
    }
  }, [])

  /* ── Soft manual brush ─────────────────────────────────── */
  const paintManual = useCallback((cssX, cssY) => {
    const canvas = canvasRef.current, orig = origDataRef.current, alpha = userAlphaRef.current
    if (!canvas || !orig || !alpha) return
    const { width: iw, height: ih } = orig
    const rect = canvas.getBoundingClientRect()
    const scaleX = iw / rect.width, scaleY = ih / rect.height
    const ix = cssX * scaleX, iy = cssY * scaleY
    const ir = brushRadiusRef.current * Math.max(scaleX, scaleY)
    const x0 = Math.max(0, Math.floor(ix - ir)), x1 = Math.min(iw - 1, Math.ceil(ix + ir))
    const y0 = Math.max(0, Math.floor(iy - ir)), y1 = Math.min(ih - 1, Math.ceil(iy + ir))
    const adding = brushModeRef.current === 'add'
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dist = Math.sqrt((x - ix) ** 2 + (y - iy) ** 2)
        if (dist <= ir) {
          const strength = dist <= ir * 0.65 ? 1 : (ir - dist) / (ir * 0.35)
          const delta = Math.round(strength * 255)
          const idx = y * iw + x
          alpha[idx] = adding ? Math.min(255, alpha[idx] + delta) : Math.max(0, alpha[idx] - delta)
        }
      }
    }
    renderCanvas()
  }, [renderCanvas])

  /* ── Smart brush: flood-fill from cursor bounded by radius + colour ─
     Traces edges like Snapchat — samples seed colour at cursor and
     grows selection to all connected similarly-coloured pixels within
     the brush radius circle.                                           */
  const paintSmart = useCallback((cssX, cssY) => {
    const canvas = canvasRef.current, orig = origDataRef.current, alpha = userAlphaRef.current
    if (!canvas || !orig || !alpha) return
    const { width: iw, height: ih } = orig
    const rect   = canvas.getBoundingClientRect()
    const scaleX = iw / rect.width, scaleY = ih / rect.height
    const ix = Math.round(cssX * scaleX), iy = Math.round(cssY * scaleY)
    if (ix < 0 || ix >= iw || iy < 0 || iy >= ih) return
    const ir  = brushRadiusRef.current * Math.max(scaleX, scaleY)
    const ir2 = ir * ir
    const thr = smartTolRef.current * 3.0   // 0-80 → 0-240 distance
    const adding = brushModeRef.current === 'add'
    // Seed colour at cursor
    const si = (iy * iw + ix) * 4
    const sr = orig.data[si], sg = orig.data[si + 1], sb = orig.data[si + 2]
    const visited = new Uint8Array(iw * ih)
    const queue = new Int32Array(iw * ih)
    let qHead = 0, qTail = 0
    const enq = (x, y) => {
      if (x < 0 || x >= iw || y < 0 || y >= ih) return
      const idx = y * iw + x
      if (visited[idx]) return
      const dx = x - ix, dy = y - iy
      if (dx * dx + dy * dy > ir2) return
      const p = idx * 4
      const dr = orig.data[p] - sr, dg = orig.data[p + 1] - sg, db = orig.data[p + 2] - sb
      if (Math.sqrt(dr * dr + dg * dg + db * db) > thr) return
      visited[idx] = 1; queue[qTail++] = idx
    }
    enq(ix, iy)
    while (qHead < qTail) {
      const idx = queue[qHead++]
      alpha[idx] = adding ? 255 : 0
      const x = idx % iw, y = (idx / iw) | 0
      enq(x - 1, y); enq(x + 1, y); enq(x, y - 1); enq(x, y + 1)
    }
    renderCanvas()
  }, [renderCanvas])

  /* ── Invert mask ───────────────────────────────────────── */
  const invertMask = useCallback(() => {
    const a = userAlphaRef.current; if (!a) return
    for (let i = 0; i < a.length; i++) a[i] = 255 - a[i]
    renderCanvas()
  }, [renderCanvas])

  /* ── Recompute mask when controls change ───────────────── */
  useEffect(() => {
    if (phase !== 'ready' || !aiMaskRef.current) return
    initAlphaFromMask(SENS_TO_THRESH(sensitivity))
    renderCanvas()
  }, [sensitivity, phase, initAlphaFromMask, renderCanvas])

  useEffect(() => {
    if (phase !== 'edge-select' || !origDataRef.current) return
    userAlphaRef.current = computeFloodMask(origDataRef.current, edgeTolerance)
    renderCanvas()
  }, [edgeTolerance, phase, renderCanvas])

  /* ── Canvas pointer handlers ───────────────────────────── */
  const getCanvasXY = (e) => {
    const cr = canvasRef.current?.getBoundingClientRect()
    const wr = wrapRef.current?.getBoundingClientRect()
    if (!cr || !wr) return null
    return { x: e.clientX - cr.left, y: e.clientY - cr.top,
             cx: e.clientX - wr.left, cy: e.clientY - wr.top }
  }
  const doPaint = useCallback((cssX, cssY) => {
    if (brushTypeRef.current === 'smart') paintSmart(cssX, cssY)
    else paintManual(cssX, cssY)
  }, [paintSmart, paintManual])

  const onPointerDown = useCallback((e) => {
    if (e.button !== 0) return
    isPaintingRef.current = true; setIsPainting(true)
    const pos = getCanvasXY(e); if (pos) doPaint(pos.x, pos.y)
  }, [doPaint])
  const onPointerMove = useCallback((e) => {
    const pos = getCanvasXY(e); if (!pos) return
    setCursor({ x: pos.cx, y: pos.cy })
    if (isPaintingRef.current) doPaint(pos.x, pos.y)
  }, [doPaint])
  const onPointerUp = useCallback(() => { isPaintingRef.current = false; setIsPainting(false) }, [])

  /* ── Touch equivalents for brush canvas ─────────────── */
  const getCanvasXYFromClient = (clientX, clientY) => {
    const cr = canvasRef.current?.getBoundingClientRect()
    const wr = wrapRef.current?.getBoundingClientRect()
    if (!cr || !wr) return null
    return { x: clientX - cr.left, y: clientY - cr.top,
             cx: clientX - wr.left, cy: clientY - wr.top }
  }
  const onTouchStartCanvas = useCallback((e) => {
    if (e.touches.length !== 1) return
    e.preventDefault()
    isPaintingRef.current = true; setIsPainting(true)
    const t = e.touches[0]
    const pos = getCanvasXYFromClient(t.clientX, t.clientY); if (pos) doPaint(pos.x, pos.y)
  }, [doPaint])  // eslint-disable-line react-hooks/exhaustive-deps
  const onTouchMoveCanvas = useCallback((e) => {
    if (e.touches.length !== 1) return
    e.preventDefault()
    const t = e.touches[0]
    const pos = getCanvasXYFromClient(t.clientX, t.clientY); if (!pos) return
    setCursor({ x: pos.cx, y: pos.cy })
    if (isPaintingRef.current) doPaint(pos.x, pos.y)
  }, [doPaint])  // eslint-disable-line react-hooks/exhaustive-deps
  const onTouchEndCanvas = useCallback(() => { isPaintingRef.current = false; setIsPainting(false) }, [])

  /* ── Load original image data (shared across paths) ────── */
  const ensureOrigData = useCallback(async () => {
    if (origDataRef.current) return
    const img = await loadImage(imageUrl)
    origDataRef.current = imageToImageData(img, 1600)
  }, [imageUrl])

  /* ── Edge select ───────────────────────────────────────── */
  const runEdgeSelect = useCallback(async () => {
    setPhase('edge-computing')
    try {
      await ensureOrigData()
      const { width: w, height: h } = origDataRef.current
      await new Promise(r => setTimeout(r, 20))
      userAlphaRef.current = computeFloodMask(origDataRef.current, edgeTolerance)
      if (canvasRef.current) { canvasRef.current.width = w; canvasRef.current.height = h }
      renderCanvas()
      setPhase('edge-select')
    } catch (err) {
      console.error('Edge select failed:', err)
      setPhase('error'); setLoadMsg(String(err.message || err))
    }
  }, [ensureOrigData, edgeTolerance, renderCanvas])

  /* ── Move from edge-select → brush, keeping current mask ─ */
  const goToBrush = useCallback(() => setPhase('ready'), [])

  /* ── AI detection ──────────────────────────────────────── */
  const runDetection = useCallback(async () => {
    setPhase('loading'); setLoadPct(0); setLoadMsg('Loading AI model…')
    try {
      const { removeBackground } = await import('@imgly/background-removal')
      await ensureOrigData()
      const res = await fetch(imageUrl)
      const rawBlob = await res.blob()
      let blob = rawBlob
      if (!['image/jpeg','image/png','image/webp'].includes(rawBlob.type)) {
        const el = await loadImage(imageUrl)
        const c = Object.assign(document.createElement('canvas'), { width: el.naturalWidth, height: el.naturalHeight })
        c.getContext('2d').drawImage(el, 0, 0)
        blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.93))
      }
      const maskBlob = await removeBackground(blob, {
        model: modelQuality,
        output: { type: 'mask', format: 'image/png' },
        progress: (key, cur, total) => {
          if (total > 0) {
            setLoadPct(Math.round(cur / total * 100))
            setLoadMsg(key.includes('fetch') ? 'Downloading model…' : key.includes('run') ? 'Analysing…' : 'Processing…')
          }
        },
      })
      const { width: w, height: h } = origDataRef.current
      const maskObjUrl = URL.createObjectURL(maskBlob)
      const maskImg = await loadImage(maskObjUrl)
      URL.revokeObjectURL(maskObjUrl)
      const mc = Object.assign(document.createElement('canvas'), { width: w, height: h })
      mc.getContext('2d').drawImage(maskImg, 0, 0, w, h)
      aiMaskRef.current = mc.getContext('2d').getImageData(0, 0, w, h)
      initAlphaFromMask(SENS_TO_THRESH(SENS_DEFAULT))
      if (canvasRef.current) { canvasRef.current.width = w; canvasRef.current.height = h }
      renderCanvas()
      setPhase('ready')
    } catch (err) {
      console.error('Background removal failed:', err)
      setPhase('error'); setLoadMsg(String(err.message || err))
    }
  }, [ensureOrigData, imageUrl, modelQuality, initAlphaFromMask, renderCanvas])

  /* ── Compute tight-cropped cutout PNG ──────────────────── */
  const computeCutout = useCallback(() => {
    const orig = origDataRef.current, alpha = userAlphaRef.current
    if (!orig || !alpha) return null
    const { width: w, height: h } = orig
    const THRESH = 12
    let minX = w, maxX = -1, minY = h, maxY = -1
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (alpha[y * w + x] > THRESH) {
          if (x < minX) minX = x;  if (x > maxX) maxX = x
          if (y < minY) minY = y;  if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < 0) { minX = 0; maxX = w - 1; minY = 0; maxY = h - 1 }
    const pad = Math.round(Math.min(maxX - minX, maxY - minY) * 0.01)
    const x0 = Math.max(0, minX - pad), y0 = Math.max(0, minY - pad)
    const x1 = Math.min(w, maxX + pad + 1), y1 = Math.min(h, maxY + pad + 1)
    const outW = x1 - x0, outH = y1 - y0
    const c = Object.assign(document.createElement('canvas'), { width: outW, height: outH })
    const ctx = c.getContext('2d')
    const idata = ctx.createImageData(outW, outH)
    const o = orig.data, d2 = idata.data
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const si = ((y0 + y) * w + (x0 + x)) * 4, di = (y * outW + x) * 4
        d2[di] = o[si]; d2[di+1] = o[si+1]; d2[di+2] = o[si+2]
        d2[di+3] = alpha[(y0 + y) * w + (x0 + x)]
      }
    }
    ctx.putImageData(idata, 0, 0)
    return c.toDataURL('image/png')
  }, [])

  /* ── Direct export (no warp) ───────────────────────────── */
  const apply = useCallback(() => {
    const url = computeCutout()
    if (url) onApply(url, { transparent: true })
  }, [computeCutout, onApply])

  /* ── Enter warp phase ──────────────────────────────────── */
  const goToWarp = useCallback(() => {
    const url = computeCutout()
    if (!url) return
    setWarpCutoutUrl(url)
    setWarpCorners(DEFAULT_CORNERS)
    setWarpSize({ w: 0, h: 0 })
    setPhase('warp')
  }, [computeCutout])

  /* ── Measure warp image ────────────────────────────────── */
  useEffect(() => {
    if (phase !== 'warp') return
    const measure = () => {
      if (warpImgRef.current) setWarpSize({ w: warpImgRef.current.offsetWidth, h: warpImgRef.current.offsetHeight })
    }
    const img = warpImgRef.current
    if (img?.complete && img.naturalWidth) measure()
    img?.addEventListener('load', measure)
    const ro = new ResizeObserver(measure)
    if (img) ro.observe(img)
    return () => { img?.removeEventListener('load', measure); ro.disconnect() }
  }, [phase, warpCutoutUrl])

  /* ── Shared warp corner move ──────────────────────────── */
  const moveWarpCorner = useCallback((clientX, clientY, idx) => {
    if (!warpImgRef.current) return
    const rect = warpImgRef.current.getBoundingClientRect()
    const nx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const ny = Math.max(0, Math.min(1, (clientY - rect.top)  / rect.height))
    setWarpCorners(c => c.map((pt, i) => i === idx ? [nx, ny] : pt))
  }, [])

  /* ── Drag a warp corner (mouse) ────────────────────────── */
  const handleWarpDrag = useCallback((e, idx) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    const move = (ev) => {
      if (!warpImgRef.current) return
      moveWarpCorner(ev.clientX, ev.clientY, idx)
    }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [moveWarpCorner])

  /* ── Drag a warp corner (touch) ────────────────────────── */
  const handleWarpTouchDrag = useCallback((e, idx) => {
    if (e.touches.length !== 1) return
    e.stopPropagation(); e.preventDefault()
    const move = (ev) => { ev.preventDefault(); if (ev.touches[0]) moveWarpCorner(ev.touches[0].clientX, ev.touches[0].clientY, idx) }
    const up   = () => { window.removeEventListener('touchmove', move); window.removeEventListener('touchend', up) }
    window.addEventListener('touchmove', move, { passive: false })
    window.addEventListener('touchend',  up,   { passive: true })
  }, [moveWarpCorner])

  /* ── Apply perspective warp to the cutout ──────────────── */
  const applyWarp = useCallback(async () => {
    const img = warpImgRef.current
    if (!img?.naturalWidth) return
    const iw = img.naturalWidth, ih = img.naturalHeight
    const px = warpCornersRef.current.map(([nx, ny]) => [nx * iw, ny * ih])
    const dist = ([ax,ay],[bx,by]) => Math.sqrt((bx-ax)**2+(by-ay)**2)
    const outW = Math.round((dist(px[0],px[1]) + dist(px[3],px[2])) / 2)
    const outH = Math.round((dist(px[0],px[3]) + dist(px[1],px[2])) / 2)
    setWarpWarping(true); setWarpPct(0)
    try {
      const dataUrl = await warpPerspectiveAsync(img, px, outW, outH, p => setWarpPct(Math.round(p * 100)), { transparent: true })
      onApply(dataUrl, { transparent: true })
    } catch (err) {
      console.error('Warp failed:', err); setWarpWarping(false)
    }
  }, [onApply])

  const warpPts = warpSize.w > 0 ? warpCorners.map(([nx, ny]) => [nx * warpSize.w, ny * warpSize.h]) : null
  const isCanvasPhase = phase === 'edge-select' || phase === 'ready'

  /* ── Render ────────────────────────────────────────────── */
  return (
    <div className="cm-body">

      {/* ── IDLE ──────────────────────────────────────────── */}
      {phase === 'idle' && (
        <div className="ms-idle">
          <div className="ms-idle-icon">🖼️</div>
          <p className="ms-idle-title">Select your artwork from the photo</p>
          <p className="ms-idle-sub">
            <strong>Edge Select</strong> traces colour boundaries from the photo borders instantly.
            Then paint with the <strong>Smart Brush</strong> to refine, or run <strong>AI Detect</strong>.
          </p>
          <p className="ms-idle-tip">
            For skewed/on-wall photos, <strong>Perspective Crop</strong> is usually more reliable.
          </p>
          <button className="btn btn-primary ms-start-btn" onClick={runEdgeSelect}>⚡ Edge Select</button>
          <div className="ms-ai-divider"><span>or use AI</span></div>
          <div className="ms-quality-row">
            <span className="ms-ctrl-label">Quality</span>
            {[['isnet_quint8','Fast'],['isnet_fp16','Balanced'],['isnet','Best']].map(([val, label]) => (
              <button key={val} className={`ms-mode-btn ${modelQuality === val ? 'ms-mode-add' : ''}`}
                onClick={() => setModelQuality(val)}
                title={val === 'isnet_quint8' ? 'Fastest' : val === 'isnet_fp16' ? 'Balanced (~40 MB)' : 'Best (~170 MB)'}
              >{label}</button>
            ))}
          </div>
          <button className="btn btn-ghost ms-start-btn" onClick={runDetection}>✨ AI Detect Background</button>
          <button className="btn btn-ghost ms-skip-btn" onClick={onSkip}>Use Full Image Instead</button>
        </div>
      )}

      {/* ── LOADING ───────────────────────────────────────── */}
      {(phase === 'loading' || phase === 'edge-computing') && (
        <div className="ms-loading">
          <div className="ms-spinner" />
          <p className="ms-load-msg">{phase === 'edge-computing' ? 'Computing edge selection…' : loadMsg}</p>
          {loadPct > 0 && <div className="ms-load-bar"><div className="ms-load-fill" style={{ width: `${loadPct}%` }} /></div>}
          {loadPct > 0 && <p className="ms-load-pct">{loadPct}%</p>}
        </div>
      )}

      {/* ── CANVAS (edge-select + brush) ──────────────────── */}
      {isCanvasPhase && (
        <div className="ms-ready">
          <div
            ref={wrapRef}
            className="ms-canvas-wrap"
            style={{ cursor: phase === 'ready' ? 'none' : 'default', touchAction: phase === 'ready' ? 'none' : 'auto' }}
            onMouseDown={phase === 'ready' ? onPointerDown : undefined}
            onMouseMove={phase === 'ready' ? onPointerMove : undefined}
            onMouseUp={phase === 'ready' ? onPointerUp : undefined}
            onMouseLeave={phase === 'ready' ? () => { isPaintingRef.current = false; setIsPainting(false); setCursor(null) } : undefined}
            onTouchStart={phase === 'ready' ? onTouchStartCanvas : undefined}
            onTouchMove={phase === 'ready' ? onTouchMoveCanvas : undefined}
            onTouchEnd={phase === 'ready' ? onTouchEndCanvas : undefined}
          >
            <canvas ref={canvasRef} className="ms-canvas" />
            {phase === 'ready' && cursor && (
              <div className="ms-brush-cursor" style={{
                left: cursor.x, top: cursor.y,
                width: brushRadius * 2, height: brushRadius * 2,
                borderColor: brushMode === 'add' ? '#4ade80' : '#f87171',
                opacity: isPainting ? 0.55 : 1,
              }} />
            )}
          </div>

          {/* Edge-select: tolerance slider only */}
          {phase === 'edge-select' && (
            <div className="ms-brush-controls">
              <div className="ms-thresh-row">
                <span className="ms-ctrl-label" title="How loosely the flood-fill grows from photo borders">Tolerance</span>
                <input className="ms-brush-slider" type="range" min={0} max={80} step={1}
                  value={edgeTolerance} onChange={e => setEdgeTolerance(+e.target.value)} />
                <span className="ms-ctrl-val">{edgeTolerance < 20 ? 'Tight' : edgeTolerance > 55 ? 'Loose' : 'Balanced'}</span>
              </div>
            </div>
          )}

          {/* Brush controls */}
          {phase === 'ready' && (
            <div className="ms-brush-controls">
              {/* Row 1: smart vs manual + add/erase + invert */}
              <div className="ms-brush-mode-row">
                <button className={`ms-mode-btn ${brushType === 'smart'  ? 'ms-mode-smart'  : ''}`} onClick={() => setBrushType('smart')}  title="Traces colour edges like a smart-select lasso">🪄 Smart</button>
                <button className={`ms-mode-btn ${brushType === 'manual' ? 'ms-mode-manual' : ''}`} onClick={() => setBrushType('manual')} title="Plain soft circle brush">✏️ Manual</button>
                <div className="ms-brush-sep" />
                <button className={`ms-mode-btn ${brushMode === 'add'   ? 'ms-mode-add'   : ''}`} onClick={() => setBrushMode('add')}>＋ Add</button>
                <button className={`ms-mode-btn ${brushMode === 'erase' ? 'ms-mode-erase' : ''}`} onClick={() => setBrushMode('erase')}>✕ Erase</button>
                <div style={{ flex: 1 }} />
                <button className="btn btn-sm btn-ghost" onClick={invertMask} title="Swap selected/unselected">⇄ Invert</button>
              </div>
              {/* Row 2: brush size */}
              <div className="ms-brush-size-row">
                <span className="ms-ctrl-label">Size</span>
                <input className="ms-brush-slider" type="range" min={5} max={100} step={1}
                  value={brushRadius} onChange={e => setBrushRadius(+e.target.value)} />
                <span className="ms-ctrl-val">{brushRadius}px</span>
              </div>
              {/* Row 3: smart tolerance (smart mode only) */}
              {brushType === 'smart' && (
                <div className="ms-thresh-row">
                  <span className="ms-ctrl-label" title="How similar neighbouring pixels must be to be included">Sensitivity</span>
                  <input className="ms-brush-slider" type="range" min={0} max={80} step={1}
                    value={smartTol} onChange={e => setSmartTol(+e.target.value)} />
                  <span className="ms-ctrl-val">{smartTol < 20 ? 'Precise' : smartTol > 55 ? 'Loose' : 'Balanced'}</span>
                </div>
              )}
              {/* Row 4: AI threshold (only shown when AI mask exists) */}
              {aiMaskRef.current && (
                <div className="ms-thresh-row">
                  <span className="ms-ctrl-label" title="Adjusting resets brush edits">AI Threshold</span>
                  <div className="ms-sens-track">
                    {Array.from({ length: 11 }, (_, i) => (
                      <div key={i} className={`ms-sens-pip ${i <= sensitivity ? 'active' : ''}`}
                        onClick={() => setSensitivity(i)} title="Resets brush edits" />
                    ))}
                  </div>
                  <span className="ms-ctrl-val" style={{ minWidth: 52, textAlign: 'right' }}>
                    {sensitivity < 4 ? 'Tight' : sensitivity > 7 ? 'Loose' : 'Balanced'}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── WARP PHASE ────────────────────────────────────── */}
      {phase === 'warp' && (
        <div className="cm-body">
          <div className="cm-image-area">
            <div className="crop-wrap" ref={warpWrapRef}>
              <img
                ref={warpImgRef}
                src={warpCutoutUrl}
                className="crop-img"
                alt=""
                draggable={false}
                style={{ background: 'transparent' }}
              />
              {warpPts && !warpWarping && (
                <>
                  <svg className="ws-svg" width={warpSize.w} height={warpSize.h}>
                    <polygon
                      points={warpPts.map(p => p.join(',')).join(' ')}
                      fill="rgba(124,111,247,0.10)"
                      stroke="rgba(255,255,255,0.75)"
                      strokeWidth={1.5}
                      strokeDasharray="7 4"
                    />
                  </svg>
                  {warpCorners.map(([nx, ny], idx) => (
                    <div key={idx} className="ws-handle"
                      style={{
                        left: nx * warpSize.w, top: ny * warpSize.h,
                        borderColor: PCROP_COLORS[idx],
                        backgroundColor: PCROP_COLORS[idx] + '55',
                        touchAction: 'none',
                      }}
                      data-label={['TL','TR','BR','BL'][idx]}
                      onMouseDown={e => handleWarpDrag(e, idx)}
                      onTouchStart={e => handleWarpTouchDrag(e, idx)}
                      onContextMenu={e => e.preventDefault()}
                    />
                  ))}
                </>
              )}
              {warpWarping && (
                <div className="ws-progress-overlay" style={{ borderRadius: 4 }}>
                  <div className="ws-progress-bar">
                    <div className="ws-progress-fill" style={{ width: `${warpPct}%` }} />
                  </div>
                  <p className="ws-progress-text">Warping… {warpPct}%</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── ERROR ─────────────────────────────────────────── */}
      {phase === 'error' && (
        <div className="ms-error">
          <p>⚠️ Failed</p>
          <p className="ms-error-detail">{loadMsg}</p>
          <div className="ms-error-btns">
            <button className="btn btn-ghost" onClick={() => setPhase('idle')}>Try Again</button>
            <button className="btn btn-ghost" onClick={onSkip}>Use Full Image</button>
          </div>
        </div>
      )}

      {/* ── FOOTER ────────────────────────────────────────── */}
      <div className="cm-footer">
        {phase === 'ready' ? (
          <>
            <button className="btn btn-ghost"
              onClick={() => { setPhase('idle'); aiMaskRef.current = null; origDataRef.current = null; userAlphaRef.current = null }}>
              ↺ Start Over
            </button>
            <button className="btn btn-ghost" onClick={goToWarp} title="Perspective-correct the cutout">↗ Warp Cutout</button>
            <button className="btn btn-primary" onClick={apply}>✓ Use Cutout</button>
          </>
        ) : phase === 'edge-select' ? (
          <>
            <button className="btn btn-ghost" onClick={() => setPhase('idle')}>↺ Back</button>
            <button className="btn btn-ghost" onClick={goToBrush}>🖌 Brush to Refine</button>
            <button className="btn btn-primary" onClick={runDetection}>✨ Refine with AI</button>
          </>
        ) : phase === 'warp' ? (
          <>
            <button className="btn btn-ghost" onClick={() => setPhase('ready')} disabled={warpWarping}>↺ Back to Brush</button>
            <button className="btn btn-ghost" onClick={onSkip} disabled={warpWarping}>Use Full Image</button>
            <button className="btn btn-primary" onClick={applyWarp} disabled={warpWarping}>
              {warpWarping ? `Warping… ${warpPct}%` : '✓ Apply Warp'}
            </button>
          </>
        ) : phase === 'loading' || phase === 'edge-computing' ? (
          <span className="ms-footer-note">Processing in browser — please wait…</span>
        ) : (
          <button className="btn btn-ghost" onClick={onSkip}>Use Full Image</button>
        )}
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════
   CROP MODAL  (tab container)
   ══════════════════════════════════════════════════════════ */
export default function CropModal({ imageUrl, onApply, onSkip }) {
  const [mode, setMode] = useState('crop')
  return (
    <div className="crop-backdrop">
      <div className="crop-modal">
        <div className="crop-header">
          <div className="cm-tabs">
            <button className={`cm-tab ${mode === 'crop'  ? 'active' : ''}`} onClick={() => setMode('crop')} >✂️ Perspective Crop</button>
            <button className={`cm-tab ${mode === 'magic' ? 'active' : ''}`} onClick={() => setMode('magic')}>✨ Magic Select</button>
          </div>
          <p className="cm-hint">
            {mode === 'crop'
              ? 'Drag the 4 corners to frame the artwork · Apply Warp flattens perspective'
              : 'Edge Select traces borders instantly · optionally refine with AI · brush to clean up'}
          </p>
        </div>
        {mode === 'crop'
          ? <PerspectiveCrop imageUrl={imageUrl} onApply={onApply} onSkip={onSkip} />
          : <MagicSelect     imageUrl={imageUrl} onApply={onApply} onSkip={onSkip} />
        }
      </div>
    </div>
  )
}
