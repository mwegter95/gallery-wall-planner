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
  const imgRef    = useRef(null)
  const [size,    setSize]    = useState({ w: 0, h: 0 })
  const [corners, setCorners] = useState(DEFAULT_CORNERS)
  const cornersRef = useRef(corners)
  useEffect(() => { cornersRef.current = corners }, [corners])

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

  /* ── Drag a corner ───────────────────────────────────── */
  const handleDrag = useCallback((e, idx) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    const move = (ev) => {
      if (!imgRef.current) return
      const rect = imgRef.current.getBoundingClientRect()
      const nx = Math.max(0, Math.min(1, (ev.clientX - rect.left)  / rect.width))
      const ny = Math.max(0, Math.min(1, (ev.clientY - rect.top)   / rect.height))
      setCorners(c => c.map((pt, i) => i === idx ? [nx, ny] : pt))
    }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup',   up)
  }, [])

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
        <div className="crop-wrap" style={{ cursor: 'default' }}>
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
                  }}
                  data-label={['TL', 'TR', 'BR', 'BL'][idx]}
                  onMouseDown={(e) => handleDrag(e, idx)}
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
   MAGIC SELECT  (AI bg-removal + circular brush to refine)
   ══════════════════════════════════════════════════════════ */
function MagicSelect({ imageUrl, onApply, onSkip }) {
  const [phase,        setPhase]        = useState('idle')
  const [loadMsg,      setLoadMsg]      = useState('')
  const [loadPct,      setLoadPct]      = useState(0)
  const [sensitivity,  setSensitivity]  = useState(SENS_DEFAULT)
  const [brushMode,    _setBrushMode]   = useState('add')   // 'add' | 'erase'
  const [brushRadius,  _setBrushRadius] = useState(24)
  const [cursor,       setCursor]       = useState(null)
  const [isPainting,   setIsPainting]   = useState(false)
  const [modelQuality, setModelQuality] = useState('isnet_fp16')
  const [edgeTolerance, setEdgeTolerance] = useState(35)    // 0-80

  // Use refs for values read in tight event-handler loops (avoids stale closures)
  const brushModeRef   = useRef('add')
  const brushRadiusRef = useRef(24)
  const isPaintingRef  = useRef(false)
  const setBrushMode   = useCallback((m) => { brushModeRef.current = m;   _setBrushMode(m)   }, [])
  const setBrushRadius = useCallback((r) => { brushRadiusRef.current = r; _setBrushRadius(r) }, [])

  const origDataRef   = useRef(null)   // ImageData  (original, ≤1600px)
  const aiMaskRef     = useRef(null)   // ImageData  (grayscale AI mask)
  const userAlphaRef  = useRef(null)   // Uint8ClampedArray  (one byte per pixel)
  const canvasRef     = useRef(null)
  const wrapRef       = useRef(null)   // .ms-canvas-wrap element (for cursor positioning)

  /* ── Fit canvas CSS size to its container (resize-safe) ─ */
  const fitCanvas = useCallback(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current
    if (!canvas?.width || !wrap?.clientWidth || !wrap?.clientHeight) return
    const scale = Math.min(wrap.clientWidth / canvas.width, wrap.clientHeight / canvas.height)
    canvas.style.width  = Math.round(canvas.width  * scale) + 'px'
    canvas.style.height = Math.round(canvas.height * scale) + 'px'
  }, [])

  // Re-fit when wrap mounts/unmounts (phase change) and on any resize
  useEffect(() => {
    const wrap = wrapRef.current; if (!wrap) return
    // Fit immediately (DOM is settled since we're in a useEffect)
    fitCanvas()
    const ro = new ResizeObserver(fitCanvas)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [fitCanvas, phase])  // phase in deps so observer re-attaches when canvas mounts

  /* ── Init userAlpha from AI mask at given threshold ──── */
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

  /* ── Draw canvas: checkerboard + alpha-composited image  */
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current, orig = origDataRef.current, alpha = userAlphaRef.current
    if (!canvas || !orig || !alpha) return
    const { width: w, height: h } = orig
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
    // Defer fitCanvas until after layout has settled
    requestAnimationFrame(fitCanvas)
  }, [fitCanvas])

  /* ── Paint one brush stamp ─────────────────────────────  */
  const paintAt = useCallback((cssX, cssY) => {
    const canvas = canvasRef.current, orig = origDataRef.current, alpha = userAlphaRef.current
    if (!canvas || !orig || !alpha) return
    const { width: iw } = orig
    const rect   = canvas.getBoundingClientRect()
    const scaleX = iw / rect.width
    const ix = cssX * scaleX, iy = cssY * (orig.height / rect.height)
    const ir = brushRadiusRef.current * scaleX
    const x0 = Math.max(0, Math.floor(ix - ir)),  x1 = Math.min(iw - 1, Math.ceil(ix + ir))
    const y0 = Math.max(0, Math.floor(iy - ir)),  y1 = Math.min(orig.height - 1, Math.ceil(iy + ir))
    const adding = brushModeRef.current === 'add'
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dist = Math.sqrt((x - ix) ** 2 + (y - iy) ** 2)
        if (dist <= ir) {
          const strength = dist <= ir * 0.65 ? 1 : (ir - dist) / (ir * 0.35)
          const delta = Math.round(strength * 255)
          const idx   = y * iw + x
          alpha[idx]  = adding ? Math.min(255, alpha[idx] + delta) : Math.max(0, alpha[idx] - delta)
        }
      }
    }
    renderCanvas()
  }, [renderCanvas])

  /* ── Invert mask ──────────────────────────────────────── */
  const invertMask = useCallback(() => {
    const a = userAlphaRef.current; if (!a) return
    for (let i = 0; i < a.length; i++) a[i] = 255 - a[i]
    renderCanvas()
  }, [renderCanvas])

  /* ── Sensitivity change → reset alpha from AI mask ─────
     (resets any brush edits — adjust threshold first)      */
  useEffect(() => {
    if (phase !== 'ready' || !aiMaskRef.current) return
    initAlphaFromMask(SENS_TO_THRESH(sensitivity))
    renderCanvas()
  }, [sensitivity, phase, initAlphaFromMask, renderCanvas])

  /* ── Edge tolerance change → recompute flood mask ───────  */
  useEffect(() => {
    if (phase !== 'edge-select' || !origDataRef.current) return
    userAlphaRef.current = computeFloodMask(origDataRef.current, edgeTolerance)
    renderCanvas()
  }, [edgeTolerance, phase, renderCanvas])

  /* ── Canvas pointer handlers ─────────────────────────── */
  // Returns canvas-relative coords (for painting) and wrap-relative (for cursor)
  const getCanvasXY = (e) => {
    const canvasRect = canvasRef.current?.getBoundingClientRect()
    const wrapRect   = wrapRef.current?.getBoundingClientRect()
    if (!canvasRect || !wrapRect) return null
    return {
      x:  e.clientX - canvasRect.left,   // canvas-relative → for paint pixel coords
      y:  e.clientY - canvasRect.top,
      cx: e.clientX - wrapRect.left,     // wrap-relative → for cursor div position
      cy: e.clientY - wrapRect.top,
    }
  }
  const onPointerDown = useCallback((e) => {
    if (e.button !== 0) return
    isPaintingRef.current = true; setIsPainting(true)
    const pos = getCanvasXY(e); if (pos) paintAt(pos.x, pos.y)
  }, [paintAt])
  const onPointerMove = useCallback((e) => {
    const pos = getCanvasXY(e); if (!pos) return
    setCursor({ x: pos.cx, y: pos.cy })     // wrap-relative — matches cursor div's position context
    if (isPaintingRef.current) paintAt(pos.x, pos.y)  // canvas-relative — for pixel accuracy
  }, [paintAt])
  const onPointerUp = useCallback(() => { isPaintingRef.current = false; setIsPainting(false) }, [])

  /* ── Quick edge-based selection (instant, no AI needed) ─  */
  const runEdgeSelect = useCallback(async () => {
    setPhase('edge-computing')
    try {
      if (!origDataRef.current) {
        const origImg = await loadImage(imageUrl)
        origDataRef.current = imageToImageData(origImg, 1600)
      }
      const { width: w, height: h } = origDataRef.current
      await new Promise(r => setTimeout(r, 20))  // let 'edge-computing' state render
      userAlphaRef.current = computeFloodMask(origDataRef.current, edgeTolerance)
      if (canvasRef.current) { canvasRef.current.width = w; canvasRef.current.height = h }
      renderCanvas()
      setPhase('edge-select')
    } catch (err) {
      console.error('Edge select failed:', err)
      setPhase('error'); setLoadMsg(String(err.message || err))
    }
  }, [imageUrl, edgeTolerance, renderCanvas])

  const runDetection = useCallback(async () => {
    setPhase('loading'); setLoadPct(0); setLoadMsg('Loading AI model…')
    try {
      const { removeBackground } = await import('@imgly/background-removal')
      // Ensure blob is a web-safe format
      const res     = await fetch(imageUrl)
      const rawBlob = await res.blob()
      let blob = rawBlob
      if (!rawBlob.type.startsWith('image/jpeg') &&
          !rawBlob.type.startsWith('image/png')  &&
          !rawBlob.type.startsWith('image/webp')) {
        const imgEl = await new Promise((r2, j2) => {
          const el = new Image()
          el.onload = () => r2(el)
          el.onerror = () => j2(new Error(`Cannot decode image (${rawBlob.type})`))
          el.src = imageUrl
        })
        const c = Object.assign(document.createElement('canvas'), { width: imgEl.naturalWidth, height: imgEl.naturalHeight })
        c.getContext('2d').drawImage(imgEl, 0, 0)
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
      // Store original + mask as ImageData (origData may already exist from edge-select path)
      if (!origDataRef.current) {
        const origImg = await loadImage(imageUrl)
        origDataRef.current = imageToImageData(origImg, 1600)
      }
      const { width: w, height: h } = origDataRef.current
      const maskObjUrl = URL.createObjectURL(maskBlob)
      const maskImg    = await loadImage(maskObjUrl)
      URL.revokeObjectURL(maskObjUrl)
      const mc = Object.assign(document.createElement('canvas'), { width: w, height: h })
      mc.getContext('2d').drawImage(maskImg, 0, 0, w, h)
      aiMaskRef.current = mc.getContext('2d').getImageData(0, 0, w, h)
      // Build editable alpha layer
      initAlphaFromMask(SENS_TO_THRESH(SENS_DEFAULT))
      // Size canvas and paint initial frame
      if (canvasRef.current) { canvasRef.current.width = w; canvasRef.current.height = h }
      renderCanvas()
      setPhase('ready')
    } catch (err) {
      console.error('Background removal failed:', err)
      setPhase('error'); setLoadMsg(String(err.message || err))
    }
}, [imageUrl, modelQuality, initAlphaFromMask, renderCanvas])

  /* ── Resize canvas when entering ready phase ─────────── */
  useEffect(() => {
    if ((phase === 'ready' || phase === 'edge-select') && canvasRef.current && origDataRef.current) {
      canvasRef.current.width  = origDataRef.current.width
      canvasRef.current.height = origDataRef.current.height
      renderCanvas()
    }
  }, [phase, renderCanvas])

  /* ── Export cutout PNG — auto-cropped to tight bounding box ── */
  const apply = useCallback(() => {
    const orig = origDataRef.current, alpha = userAlphaRef.current
    if (!orig || !alpha) return
    const { width: w, height: h } = orig

    // Scan alpha for tight bounding box of visible pixels
    const THRESH = 12
    let minX = w, maxX = -1, minY = h, maxY = -1
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (alpha[y * w + x] > THRESH) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    // Fallback: nothing selected → full image
    if (maxX < 0) { minX = 0; maxX = w - 1; minY = 0; maxY = h - 1 }

    // Small padding (1% of shortest dimension) to avoid hard edges
    const pad = Math.round(Math.min(maxX - minX, maxY - minY) * 0.01)
    const x0 = Math.max(0, minX - pad),     y0 = Math.max(0, minY - pad)
    const x1 = Math.min(w, maxX + pad + 1), y1 = Math.min(h, maxY + pad + 1)
    const outW = x1 - x0, outH = y1 - y0

    const c = Object.assign(document.createElement('canvas'), { width: outW, height: outH })
    const ctx = c.getContext('2d')
    const idata = ctx.createImageData(outW, outH)
    const o = orig.data, d2 = idata.data
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const si = ((y0 + y) * w + (x0 + x)) * 4
        const di = (y * outW + x) * 4
        d2[di]   = o[si]; d2[di+1] = o[si+1]; d2[di+2] = o[si+2]
        d2[di+3] = alpha[(y0 + y) * w + (x0 + x)]
      }
    }
    ctx.putImageData(idata, 0, 0)
    onApply(c.toDataURL('image/png'), { transparent: true })
  }, [onApply])

  const isCanvasPhase = phase === 'edge-select' || phase === 'ready'

  /* ── Render ──────────────────────────────────────────── */
  return (
    <div className="cm-body">

      {/* ── IDLE ─────────────────────────────────────────── */}
      {phase === 'idle' && (
        <div className="ms-idle">
          <div className="ms-idle-icon">🖼️</div>
          <p className="ms-idle-title">Select your artwork from the photo</p>
          <p className="ms-idle-sub">
            <strong>Edge Select</strong> instantly traces colour boundaries from the photo borders
            to isolate the foreground — no download needed. Then refine with the brush,
            or optionally run <strong>AI Detect</strong> for deeper background removal.
          </p>
          <p className="ms-idle-tip">
            For skewed or on-wall photos, <strong>Perspective Crop</strong> is usually more reliable.
          </p>

          {/* Primary — instant edge detection */}
          <button className="btn btn-primary ms-start-btn" onClick={runEdgeSelect}>
            ⚡ Edge Select
          </button>

          {/* Secondary — AI model */}
          <div className="ms-ai-divider"><span>or use AI</span></div>
          <div className="ms-quality-row">
            <span className="ms-ctrl-label">Quality</span>
            {[['isnet_quint8','Fast'],['isnet_fp16','Balanced'],['isnet','Best']].map(([val, label]) => (
              <button
                key={val}
                className={`ms-mode-btn ${modelQuality === val ? 'ms-mode-add' : ''}`}
                onClick={() => setModelQuality(val)}
                title={val === 'isnet_quint8' ? 'Fastest, smallest download' : val === 'isnet_fp16' ? 'Good quality, moderate size' : 'Best quality, larger download (~170 MB)'}
              >{label}</button>
            ))}
          </div>
          <button className="btn btn-ghost ms-start-btn" onClick={runDetection}>
            ✨ AI Detect Background
          </button>

          <button className="btn btn-ghost ms-skip-btn" onClick={onSkip}>Use Full Image Instead</button>
        </div>
      )}

      {/* ── LOADING (AI) ─────────────────────────────────── */}
      {phase === 'loading' && (
        <div className="ms-loading">
          <div className="ms-spinner" />
          <p className="ms-load-msg">{loadMsg}</p>
          {loadPct > 0 && <div className="ms-load-bar"><div className="ms-load-fill" style={{ width: `${loadPct}%` }} /></div>}
          <p className="ms-load-pct">{loadPct > 0 ? `${loadPct}%` : ''}</p>
        </div>
      )}

      {/* ── EDGE COMPUTING ───────────────────────────────── */}
      {phase === 'edge-computing' && (
        <div className="ms-loading">
          <div className="ms-spinner" />
          <p className="ms-load-msg">Computing edge selection…</p>
        </div>
      )}

      {/* ── CANVAS (edge-select + ready share canvas/wrap refs) */}
      {isCanvasPhase && (
        <div className="ms-ready">
          <div
            ref={wrapRef}
            className="ms-canvas-wrap"
            style={{ cursor: phase === 'ready' ? 'none' : 'default' }}
            onMouseDown={phase === 'ready' ? onPointerDown : undefined}
            onMouseMove={phase === 'ready' ? onPointerMove : undefined}
            onMouseUp={phase === 'ready' ? onPointerUp : undefined}
            onMouseLeave={phase === 'ready' ? () => { isPaintingRef.current = false; setIsPainting(false); setCursor(null) } : undefined}
          >
            <canvas ref={canvasRef} className="ms-canvas" />
            {phase === 'ready' && cursor && (
              <div
                className="ms-brush-cursor"
                style={{
                  left:        cursor.x,
                  top:         cursor.y,
                  width:       brushRadius * 2,
                  height:      brushRadius * 2,
                  borderColor: brushMode === 'add' ? '#4ade80' : '#f87171',
                  opacity:     isPainting ? 0.55 : 1,
                }}
              />
            )}
          </div>

          {/* Edge-select controls */}
          {phase === 'edge-select' && (
            <div className="ms-brush-controls">
              <div className="ms-thresh-row">
                <span className="ms-ctrl-label" title="How loosely to grow the background selection from the image borders">Tolerance</span>
                <input className="ms-brush-slider" type="range" min={0} max={80} step={1}
                  value={edgeTolerance} onChange={e => setEdgeTolerance(+e.target.value)} />
                <span className="ms-ctrl-val">
                  {edgeTolerance < 20 ? 'Tight' : edgeTolerance > 55 ? 'Loose' : 'Balanced'}
                </span>
              </div>
            </div>
          )}

          {/* Brush controls (ready phase) */}
          {phase === 'ready' && (
            <div className="ms-brush-controls">
              <div className="ms-brush-mode-row">
                <button className={`ms-mode-btn ${brushMode === 'add'   ? 'ms-mode-add'   : ''}`} onClick={() => setBrushMode('add')}>＋ Add</button>
                <button className={`ms-mode-btn ${brushMode === 'erase' ? 'ms-mode-erase' : ''}`} onClick={() => setBrushMode('erase')}>✕ Erase</button>
                <div style={{ flex: 1 }} />
                <button className="btn btn-sm btn-ghost" onClick={invertMask} title="Swap selected / unselected">⇄ Invert</button>
              </div>
              <div className="ms-brush-size-row">
                <span className="ms-ctrl-label">Brush</span>
                <input className="ms-brush-slider" type="range" min={5} max={80} step={1}
                  value={brushRadius} onChange={e => setBrushRadius(+e.target.value)} />
                <span className="ms-ctrl-val">{brushRadius}px</span>
              </div>
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

      {/* ── ERROR ────────────────────────────────────────── */}
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

      {/* ── FOOTER ───────────────────────────────────────── */}
      <div className="cm-footer">
        {phase === 'ready' ? (
          <>
            <button className="btn btn-ghost" onClick={() => { setPhase('idle'); aiMaskRef.current = null; origDataRef.current = null; userAlphaRef.current = null }}>↺ Start Over</button>
            <button className="btn btn-ghost" onClick={onSkip}>Use Full Image</button>
            <button className="btn btn-primary" onClick={apply}>✓ Use Cutout</button>
          </>
        ) : phase === 'edge-select' ? (
          <>
            <button className="btn btn-ghost" onClick={() => setPhase('idle')}>↺ Back</button>
            <button className="btn btn-ghost" onClick={() => setPhase('ready')}>🖌 Start Brushing</button>
            <button className="btn btn-primary" onClick={runDetection}>✨ Refine with AI</button>
          </>
        ) : phase === 'loading' ? (
          <span className="ms-footer-note">Processing in browser — please wait…</span>
        ) : phase === 'edge-computing' ? (
          <span className="ms-footer-note">Analysing image borders…</span>
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
