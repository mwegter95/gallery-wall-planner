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

/* ══════════════════════════════════════════════════════════
   PERSPECTIVE CROP  (4-corner homography warp, like WallSetup)
   ══════════════════════════════════════════════════════════ */
function PerspectiveCrop({ imageUrl, onApply, onSkip }) {
  const imgRef    = useRef(null)
  const [size,    setSize]    = useState({ w: 0, h: 0 })
  const [corners, setCorners] = useState([
    [0.05, 0.05], // TL
    [0.95, 0.05], // TR
    [0.95, 0.95], // BR
    [0.05, 0.95], // BL
  ])
  const cornersRef = useRef(corners)
  useEffect(() => { cornersRef.current = corners }, [corners])

  const [warping,  setWarping]  = useState(false)
  const [warpPct,  setWarpPct]  = useState(0)
  const [imgError, setImgError] = useState(false)

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
            src={imageUrl}
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
        <button className="btn btn-ghost" onClick={onSkip} disabled={warping}>Use Full Image</button>
        <button className="btn btn-primary" onClick={handleApply} disabled={warping}>
          {warping ? `Warping… ${warpPct}%` : '✓ Apply Warp'}
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
  }, [])

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
    if (phase !== 'ready') return
    initAlphaFromMask(SENS_TO_THRESH(sensitivity))
    renderCanvas()
  }, [sensitivity, phase, initAlphaFromMask, renderCanvas])

  /* ── Canvas pointer handlers ─────────────────────────── */
  const getCanvasXY = (e) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return null
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }
  const onPointerDown = useCallback((e) => {
    if (e.button !== 0) return
    isPaintingRef.current = true; setIsPainting(true)
    const pos = getCanvasXY(e); if (pos) paintAt(pos.x, pos.y)
  }, [paintAt])
  const onPointerMove = useCallback((e) => {
    const pos = getCanvasXY(e); if (!pos) return
    setCursor({ x: pos.x, y: pos.y })
    if (isPaintingRef.current) paintAt(pos.x, pos.y)
  }, [paintAt])
  const onPointerUp = useCallback(() => { isPaintingRef.current = false; setIsPainting(false) }, [])

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
        output: { type: 'mask', format: 'image/png' },
        progress: (key, cur, total) => {
          if (total > 0) {
            setLoadPct(Math.round(cur / total * 100))
            setLoadMsg(key.includes('fetch') ? 'Downloading model…' : key.includes('run') ? 'Analysing…' : 'Processing…')
          }
        },
      })
      // Store original + mask as ImageData
      const origImg = await loadImage(imageUrl)
      origDataRef.current = imageToImageData(origImg, 1600)
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
  }, [imageUrl, initAlphaFromMask, renderCanvas])

  /* ── Resize canvas when entering ready phase ─────────── */
  useEffect(() => {
    if (phase === 'ready' && canvasRef.current && origDataRef.current) {
      canvasRef.current.width  = origDataRef.current.width
      canvasRef.current.height = origDataRef.current.height
      renderCanvas()
    }
  }, [phase, renderCanvas])

  /* ── Export cutout PNG ───────────────────────────────── */
  const apply = useCallback(() => {
    const orig = origDataRef.current, alpha = userAlphaRef.current
    if (!orig || !alpha) return
    const { width: w, height: h } = orig
    const c = Object.assign(document.createElement('canvas'), { width: w, height: h })
    const ctx = c.getContext('2d')
    const idata = ctx.createImageData(w, h)
    const o = orig.data, d2 = idata.data
    for (let i = 0; i < w * h; i++) {
      d2[i*4] = o[i*4]; d2[i*4+1] = o[i*4+1]; d2[i*4+2] = o[i*4+2]; d2[i*4+3] = alpha[i]
    }
    ctx.putImageData(idata, 0, 0)
    onApply(c.toDataURL('image/png'), { transparent: true })
  }, [onApply])

  /* ── Render ──────────────────────────────────────────── */
  return (
    <div className="cm-body">

      {phase === 'idle' && (
        <div className="ms-idle">
          <div className="ms-idle-icon">✨</div>
          <p className="ms-idle-title">Remove background from image</p>
          <p className="ms-idle-sub">
            AI detects the main subject and removes the background. Works best when the
            <strong> whole framed piece</strong> is the primary object against a contrasting wall.
          </p>
          <p className="ms-idle-tip">
            For a photo of artwork on a wall, the <strong>Perspective Crop</strong> tab lets
            you place 4 corners and flatten the view — often more reliable.
          </p>
          <button className="btn btn-primary ms-start-btn" onClick={runDetection}>
            ✨ Detect Frame from Background
          </button>
          <button className="btn btn-ghost" onClick={onSkip}>Use Full Image Instead</button>
        </div>
      )}

      {phase === 'loading' && (
        <div className="ms-loading">
          <div className="ms-spinner" />
          <p className="ms-load-msg">{loadMsg}</p>
          {loadPct > 0 && <div className="ms-load-bar"><div className="ms-load-fill" style={{ width: `${loadPct}%` }} /></div>}
          <p className="ms-load-pct">{loadPct > 0 ? `${loadPct}%` : ''}</p>
        </div>
      )}

      {phase === 'ready' && (
        <div className="ms-ready">
          {/* Brush canvas */}
          <div
            className="ms-canvas-wrap"
            style={{ cursor: 'none' }}
            onMouseDown={onPointerDown}
            onMouseMove={onPointerMove}
            onMouseUp={onPointerUp}
            onMouseLeave={() => { isPaintingRef.current = false; setIsPainting(false); setCursor(null) }}
          >
            <canvas ref={canvasRef} className="ms-canvas" />
            {cursor && (
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

          {/* Controls */}
          <div className="ms-brush-controls">
            <div className="ms-brush-mode-row">
              <button
                className={`ms-mode-btn ${brushMode === 'add' ? 'ms-mode-add' : ''}`}
                onClick={() => setBrushMode('add')}
              >＋ Add</button>
              <button
                className={`ms-mode-btn ${brushMode === 'erase' ? 'ms-mode-erase' : ''}`}
                onClick={() => setBrushMode('erase')}
              >✕ Erase</button>
              <div style={{ flex: 1 }} />
              <button className="btn btn-sm btn-ghost" onClick={invertMask} title="Swap selected / unselected">⇄ Invert</button>
            </div>

            <div className="ms-brush-size-row">
              <span className="ms-ctrl-label">Brush</span>
              <input className="ms-brush-slider" type="range" min={5} max={80} step={1}
                value={brushRadius} onChange={e => setBrushRadius(+e.target.value)} />
              <span className="ms-ctrl-val">{brushRadius}px</span>
            </div>

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
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="ms-error">
          <p>⚠️ Detection failed</p>
          <p className="ms-error-detail">{loadMsg}</p>
          <div className="ms-error-btns">
            <button className="btn btn-ghost" onClick={() => setPhase('idle')}>Try Again</button>
            <button className="btn btn-ghost" onClick={onSkip}>Use Full Image</button>
          </div>
        </div>
      )}

      <div className="cm-footer">
        {phase === 'ready' ? (
          <>
            <button className="btn btn-ghost" onClick={() => setPhase('idle')}>↺ Re-detect</button>
            <button className="btn btn-ghost" onClick={onSkip}>Use Full Image</button>
            <button className="btn btn-primary" onClick={apply}>✓ Use Cutout</button>
          </>
        ) : phase === 'loading' ? (
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
              : 'AI removes the background · paint with the circular brush to refine'}
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
