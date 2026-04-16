import { useState, useRef, useEffect, useCallback } from 'react'

/* ── Rectangle-crop handles ─────────────────────────────── */
const CROP_HANDLES = [
  { id: 'nw', nx: 0,   ny: 0,   cursor: 'nwse-resize' },
  { id: 'n',  nx: 0.5, ny: 0,   cursor: 'ns-resize'   },
  { id: 'ne', nx: 1,   ny: 0,   cursor: 'nesw-resize' },
  { id: 'e',  nx: 1,   ny: 0.5, cursor: 'ew-resize'   },
  { id: 'se', nx: 1,   ny: 1,   cursor: 'nwse-resize' },
  { id: 's',  nx: 0.5, ny: 1,   cursor: 'ns-resize'   },
  { id: 'sw', nx: 0,   ny: 1,   cursor: 'nesw-resize' },
  { id: 'w',  nx: 0,   ny: 0.5, cursor: 'ew-resize'   },
]
const MIN_CROP = 0.04

/* ── Magic-select sensitivity: maps 0-10 → alpha threshold ──
   High sensitivity = low threshold = more of the image kept.
   Low sensitivity  = high threshold = tighter selection.      */
const SENS_DEFAULT = 6
const SENS_TO_THRESH = (s) => Math.round((10 - s) / 10 * 210 + 20) // 20-230

/* ── Helpers ─────────────────────────────────────────────── */
function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image()
    img.onload  = () => res(img)
    img.onerror = rej
    img.src = src
    // ← NO crossOrigin here for data URLs
  })
}

function canvasToImageData(img, maxPx = 1600) {
  const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.round(img.naturalWidth  * scale)
  const h = Math.round(img.naturalHeight * scale)
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h })
  c.getContext('2d').drawImage(img, 0, 0, w, h)
  return c.getContext('2d').getImageData(0, 0, w, h)
}

/** Apply threshold + feather to mask, composite onto original → PNG data URL */
function compositeWithThreshold(origData, maskData, threshold) {
  const { width: w, height: h } = origData
  const result = new ImageData(w, h)
  const o = origData.data, m = maskData.data, r = result.data
  const FEATHER = 18
  for (let i = 0; i < w * h; i++) {
    const mv = m[i * 4]   // mask R channel = grayscale
    const alpha = mv < threshold - FEATHER ? 0
                : mv > threshold + FEATHER ? 255
                : Math.round((mv - (threshold - FEATHER)) / (FEATHER * 2) * 255)
    r[i*4]   = o[i*4]
    r[i*4+1] = o[i*4+1]
    r[i*4+2] = o[i*4+2]
    r[i*4+3] = alpha
  }
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h })
  c.getContext('2d').putImageData(result, 0, 0)
  return c.toDataURL('image/png')
}

/* ══════════════════════════════════════════════════════════
   RECTANGLE CROP MODE
   ══════════════════════════════════════════════════════════ */
function RectCrop({ imageUrl, onApply, onSkip }) {
  const imgRef  = useRef(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [box,  setBox]  = useState({ x: 0.02, y: 0.02, w: 0.96, h: 0.96 })
  const boxRef = useRef(box)
  useEffect(() => { boxRef.current = box }, [box])

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

  const d = { x: box.x*size.w, y: box.y*size.h, w: box.w*size.w, h: box.h*size.h }

  const startDrag = useCallback((e, onMove) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    const rect = imgRef.current.getBoundingClientRect()
    const toN  = (ev) => ({ x: (ev.clientX-rect.left)/rect.width, y: (ev.clientY-rect.top)/rect.height })
    const origin = toN(e), start = { ...boxRef.current }
    const move = (ev) => onMove(toN(ev), origin, start)
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [])

  const moveBox = useCallback((e) => {
    startDrag(e, ({ x: mx, y: my }, { x: ox, y: oy }, sb) => {
      setBox({ ...sb,
        x: Math.max(0, Math.min(1 - sb.w, sb.x + mx - ox)),
        y: Math.max(0, Math.min(1 - sb.h, sb.y + my - oy)),
      })
    })
  }, [startDrag])

  const resizeHandle = useCallback((e, hid) => {
    startDrag(e, ({ x: mx, y: my }, { x: ox, y: oy }, sb) => {
      let { x, y, w, h } = sb, dx = mx-ox, dy = my-oy
      if (hid.includes('w')) { const nx = Math.max(0, Math.min(x+w-MIN_CROP, x+dx)); w=x+w-nx; x=nx }
      if (hid.includes('e')) w = Math.max(MIN_CROP, Math.min(1-x, w+dx))
      if (hid.includes('n')) { const ny = Math.max(0, Math.min(y+h-MIN_CROP, y+dy)); h=y+h-ny; y=ny }
      if (hid.includes('s')) h = Math.max(MIN_CROP, Math.min(1-y, h+dy))
      setBox({ x, y, w, h })
    })
  }, [startDrag])

  const apply = useCallback(() => {
    const img = imgRef.current
    if (!img?.naturalWidth) return
    const iw = img.naturalWidth, ih = img.naturalHeight
    const c = Object.assign(document.createElement('canvas'), {
      width:  Math.round(box.w * iw),
      height: Math.round(box.h * ih),
    })
    c.getContext('2d').drawImage(img,
      Math.round(box.x*iw), Math.round(box.y*ih),
      Math.round(box.w*iw), Math.round(box.h*ih),
      0, 0, c.width, c.height
    )
    onApply(c.toDataURL('image/jpeg', 0.93), { transparent: false })
  }, [box, onApply])

  const natW = imgRef.current ? Math.round(box.w * imgRef.current.naturalWidth)  : '–'
  const natH = imgRef.current ? Math.round(box.h * imgRef.current.naturalHeight) : '–'

  return (
    <div className="cm-body">
      {/* cm-image-area centers the crop-wrap without inflating it,
          keeping position:relative intact for absolute overlay children */}
      <div className="cm-image-area">
        <div className="crop-wrap">
          {/* ← No crossOrigin — this is always a data: URL */}
          <img ref={imgRef} src={imageUrl} className="crop-img" alt="" draggable={false} />

          {size.w > 0 && <>
            <div className="crop-dim crop-dim-top"    style={{ height: d.y }} />
            <div className="crop-dim crop-dim-bottom" style={{ top: d.y + d.h }} />
            <div className="crop-dim crop-dim-left"   style={{ top: d.y, height: d.h, width: d.x }} />
            <div className="crop-dim crop-dim-right"  style={{ top: d.y, height: d.h, left: d.x + d.w }} />

            <div className="crop-rect"
              style={{ left: d.x, top: d.y, width: d.w, height: d.h }}
              onMouseDown={moveBox}
            >
              <div className="crop-thirds-h" style={{ top: '33.3%' }} />
              <div className="crop-thirds-h" style={{ top: '66.6%' }} />
              <div className="crop-thirds-v" style={{ left: '33.3%' }} />
              <div className="crop-thirds-v" style={{ left: '66.6%' }} />
              {CROP_HANDLES.map(h => (
                <div key={h.id} className="crop-handle"
                  style={{ left: h.nx*d.w, top: h.ny*d.h, cursor: h.cursor }}
                  onMouseDown={(e) => resizeHandle(e, h.id)}
                />
              ))}
            </div>
            <div className="crop-dim-badge" style={{ left: d.x + d.w/2, top: d.y + d.h + 8 }}>
              {natW} × {natH} px
            </div>
          </>}
        </div>
      </div>

      <div className="cm-footer">
        <button className="btn btn-ghost" onClick={() => onSkip()}>Use Full Image</button>
        <button className="btn btn-primary" onClick={apply}>✓ Apply Crop</button>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════
   MAGIC SELECT MODE
   ══════════════════════════════════════════════════════════ */
function MagicSelect({ imageUrl, onApply, onSkip }) {
  const [phase,       setPhase]       = useState('idle')    // idle|loading|ready|error
  const [loadMsg,     setLoadMsg]     = useState('')
  const [loadPct,     setLoadPct]     = useState(0)
  const [sensitivity, setSensitivity] = useState(SENS_DEFAULT)
  const [previewUrl,  setPreviewUrl]  = useState(null)

  // Stored once after model runs
  const origDataRef = useRef(null)
  const maskDataRef = useRef(null)

  /* Regenerate preview whenever sensitivity changes */
  useEffect(() => {
    if (origDataRef.current && maskDataRef.current) {
      const thresh = SENS_TO_THRESH(sensitivity)
      setPreviewUrl(compositeWithThreshold(origDataRef.current, maskDataRef.current, thresh))
    }
  }, [sensitivity])

  const runDetection = useCallback(async () => {
    setPhase('loading')
    setLoadPct(0)
    setLoadMsg('Loading AI model…')

    try {
      const { removeBackground } = await import('@imgly/background-removal')

      // Convert data URL → Blob (the library needs a Blob/File)
      const res  = await fetch(imageUrl)
      const blob = await res.blob()

      // Get foreground mask (grayscale PNG where white = keep)
      const maskBlob = await removeBackground(blob, {
        output: { type: 'mask', format: 'image/png' },
        progress: (key, cur, total) => {
          if (total > 0) {
            setLoadPct(Math.round(cur / total * 100))
            setLoadMsg(
              key.includes('fetch') ? 'Downloading model…'
              : key.includes('run')  ? 'Detecting subject…'
              : 'Processing…'
            )
          }
        },
      })

      // Load original into ImageData (capped at 1600px)
      const origImg  = await loadImage(imageUrl)
      origDataRef.current = canvasToImageData(origImg, 1600)

      // Load mask into ImageData (same size as orig)
      const maskObjUrl = URL.createObjectURL(maskBlob)
      const maskImg    = await loadImage(maskObjUrl)
      URL.revokeObjectURL(maskObjUrl)

      // Scale mask to match orig dimensions
      const { width: w, height: h } = origDataRef.current
      const mc = Object.assign(document.createElement('canvas'), { width: w, height: h })
      mc.getContext('2d').drawImage(maskImg, 0, 0, w, h)
      maskDataRef.current = mc.getContext('2d').getImageData(0, 0, w, h)

      // Initial preview
      const thresh = SENS_TO_THRESH(SENS_DEFAULT)
      setPreviewUrl(compositeWithThreshold(origDataRef.current, maskDataRef.current, thresh))
      setPhase('ready')

    } catch (err) {
      console.error('Background removal failed:', err)
      setPhase('error')
      setLoadMsg(String(err.message || err))
    }
  }, [imageUrl])

  const apply = useCallback(() => {
    if (previewUrl) onApply(previewUrl, { transparent: true })
  }, [previewUrl, onApply])

  /* ── Render ── */
  return (
    <div className="cm-body">
      {phase === 'idle' && (
        <div className="ms-idle">
          <div className="ms-idle-icon">✨</div>
          <p className="ms-idle-title">Auto-detect & cut out subject</p>
          <p className="ms-idle-sub">
            An AI model runs entirely in your browser — no upload needed.
            First run downloads the model (~25 MB, then cached).
          </p>
          <button className="btn btn-primary ms-start-btn" onClick={runDetection}>
            ✨ Detect Subject
          </button>
          <button className="btn btn-ghost" onClick={() => onSkip()}>
            Use Full Image Instead
          </button>
        </div>
      )}

      {phase === 'loading' && (
        <div className="ms-loading">
          <div className="ms-spinner" />
          <p className="ms-load-msg">{loadMsg}</p>
          {loadPct > 0 && (
            <div className="ms-load-bar">
              <div className="ms-load-fill" style={{ width: `${loadPct}%` }} />
            </div>
          )}
          <p className="ms-load-pct">{loadPct > 0 ? `${loadPct}%` : ''}</p>
        </div>
      )}

      {phase === 'ready' && (
        <div className="ms-ready">
          {/* Checkerboard + preview */}
          <div className="ms-preview-wrap">
            <img src={previewUrl} className="ms-preview-img" alt="Cutout preview" />
          </div>

          {/* Sensitivity / selection size controls */}
          <div className="ms-controls">
            <span className="ms-ctrl-label">Selection size</span>
            <div className="ms-sens-row">
              <button
                className="ms-sens-btn"
                onClick={() => setSensitivity(s => Math.max(0, s - 1))}
                disabled={sensitivity === 0}
                title="Shrink selection"
              >−</button>
              <div className="ms-sens-track">
                {Array.from({ length: 11 }, (_, i) => (
                  <div
                    key={i}
                    className={`ms-sens-pip ${i <= sensitivity ? 'active' : ''}`}
                    onClick={() => setSensitivity(i)}
                  />
                ))}
              </div>
              <button
                className="ms-sens-btn"
                onClick={() => setSensitivity(s => Math.min(10, s + 1))}
                disabled={sensitivity === 10}
                title="Grow selection"
              >+</button>
            </div>
            <span className="ms-sens-hint">
              {sensitivity < 4 ? 'Tight — only high-confidence areas'
              : sensitivity > 7 ? 'Loose — includes uncertain edges'
              : 'Balanced'}
            </span>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="ms-error">
          <p>⚠️ Detection failed</p>
          <p className="ms-error-detail">{loadMsg}</p>
          <div className="ms-error-btns">
            <button className="btn btn-ghost" onClick={() => setPhase('idle')}>Try Again</button>
            <button className="btn btn-ghost" onClick={() => onSkip()}>Use Full Image</button>
          </div>
        </div>
      )}

      <div className="cm-footer">
        {phase === 'ready' ? (
          <>
            <button className="btn btn-ghost" onClick={() => setPhase('idle')}>↺ Re-detect</button>
            <button className="btn btn-ghost" onClick={() => onSkip()}>Use Full Image</button>
            <button className="btn btn-primary" onClick={apply}>✓ Use Cutout</button>
          </>
        ) : phase === 'loading' ? (
          <span className="ms-footer-note">Processing in browser — please wait…</span>
        ) : (
          <button className="btn btn-ghost" onClick={() => onSkip()}>Use Full Image</button>
        )}
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════
   CROP MODAL  (container with mode tabs)
   ══════════════════════════════════════════════════════════ */
export default function CropModal({ imageUrl, onApply, onSkip }) {
  const [mode, setMode] = useState('crop')

  return (
    <div className="crop-backdrop">
      <div className="crop-modal">

        <div className="crop-header">
          <div className="cm-tabs">
            <button
              className={`cm-tab ${mode === 'crop' ? 'active' : ''}`}
              onClick={() => setMode('crop')}
            >✂️ Crop</button>
            <button
              className={`cm-tab ${mode === 'magic' ? 'active' : ''}`}
              onClick={() => setMode('magic')}
            >✨ Magic Select</button>
          </div>
          <p className="cm-hint">
            {mode === 'crop'
              ? 'Drag inside to move · handles to resize'
              : 'AI isolates the subject and removes the background'}
          </p>
        </div>

        {mode === 'crop'
          ? <RectCrop  imageUrl={imageUrl} onApply={onApply} onSkip={onSkip} />
          : <MagicSelect imageUrl={imageUrl} onApply={onApply} onSkip={onSkip} />
        }

      </div>
    </div>
  )
}
