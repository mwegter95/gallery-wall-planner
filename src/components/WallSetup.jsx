import { useState, useRef, useCallback, useEffect } from 'react'
import { warpPerspectiveAsync } from '../utils/homography'
import { BASE as API_BASE } from '../utils/api'

const DEFAULT_CORNERS = [
  [0.05, 0.05],   // TL
  [0.95, 0.05],   // TR
  [0.95, 0.95],   // BR
  [0.05, 0.95],   // BL
]

const CORNER_META = [
  { label: 'TL', full: 'Top-Left',     color: '#f97316' },
  { label: 'TR', full: 'Top-Right',    color: '#22d3ee' },
  { label: 'BR', full: 'Bottom-Right', color: '#a78bfa' },
  { label: 'BL', full: 'Bottom-Left',  color: '#34d399' },
]

const isHeic = (file) =>
  file.type === 'image/heic' ||
  file.type === 'image/heif' ||
  /\.(heic|heif)$/i.test(file.name)

const blobToDataUrl = (blob) => new Promise((res, rej) => {
  const r = new FileReader()
  r.onload = () => res(r.result)
  r.onerror = rej
  r.readAsDataURL(blob)
})

/** Scale a canvas/image down so its longest side is at most MAX px */
function scaleDataUrl(dataUrl, max = 2400) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
      const w = Math.round(img.naturalWidth * scale)
      const h = Math.round(img.naturalHeight * scale)
      const c = Object.assign(document.createElement('canvas'), { width: w, height: h })
      c.getContext('2d').drawImage(img, 0, 0, w, h)
      resolve(c.toDataURL('image/jpeg', 0.92))
    }
    img.src = dataUrl
  })
}

/**
 * Convert any image File to a JPEG data URL (same 4-strategy pipeline as AddPieceModal).
 * Strategy 0: server-side sips (macOS, handles all HEIC variants)
 * Strategy 1: createImageBitmap → canvas
 * Strategy 2: heic2any WASM
 * Strategy 3: img element → canvas
 */
async function anyImageToJpeg(file) {
  // ── Strategy 0: server-side sips (macOS dev server) ──
  if (isHeic(file)) {
    try {
      const res = await fetch(`${API_BASE}/api/heic-to-jpeg`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      })
      if (res.ok) {
        const blob = await res.blob()
        return scaleDataUrl(await blobToDataUrl(blob))
      }
    } catch (e) {
      console.warn('[WallSetup] sips endpoint failed:', e)
    }
  }

  // ── Strategy 1: createImageBitmap → canvas ──
  try {
    const bitmap = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    canvas.width  = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d').drawImage(bitmap, 0, 0)
    bitmap.close()
    return scaleDataUrl(canvas.toDataURL('image/jpeg', 0.92))
  } catch (_) { /* fall through */ }

  // ── Strategy 2: heic2any WASM ──
  if (isHeic(file)) {
    try {
      const mod = await import('heic2any')
      const heic2any = typeof mod.default === 'function' ? mod.default : mod
      const result = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.93 })
      const blob   = Array.isArray(result) ? result[0] : result
      return scaleDataUrl(await blobToDataUrl(blob))
    } catch (e) {
      console.warn('[WallSetup] heic2any failed:', e)
    }
  }

  // ── Strategy 3: img element → canvas ──
  try {
    const objUrl = URL.createObjectURL(file)
    const jpeg = await new Promise((res, rej) => {
      const img = new Image()
      img.onload = () => {
        URL.revokeObjectURL(objUrl)
        const c = Object.assign(document.createElement('canvas'), {
          width: img.naturalWidth, height: img.naturalHeight,
        })
        c.getContext('2d').drawImage(img, 0, 0)
        res(c.toDataURL('image/jpeg', 0.92))
      }
      img.onerror = () => { URL.revokeObjectURL(objUrl); rej(new Error('img decode failed')) }
      img.src = objUrl
    })
    return scaleDataUrl(jpeg)
  } catch (_) { /* fall through */ }

  throw new Error('Could not decode image')
}


export default function WallSetup({ onApply, onClose, wallName = 'Wall', wallWidth = 128, wallHeight = 95, existingImageUrl = null }) {
  const imgRef            = useRef(null)
  const fileInputRef      = useRef(null)
  const [rawPhoto,        setRawPhoto]        = useState(existingImageUrl)   // data URL or existing URL
  const [loadingPhoto,    setLoadingPhoto]    = useState(false)
  const [photoError,      setPhotoError]      = useState('')
  const [imgSize,         setImgSize]         = useState({ w: 0, h: 0 })
  const [corners,         setCorners]         = useState(DEFAULT_CORNERS)
  const [progress,        setProgress]        = useState(0)
  const [isProcessing,    setIsProcessing]    = useState(false)
  const [statusMsg,       setStatusMsg]       = useState('')
  const [errorMsg,        setErrorMsg]        = useState('')
  const [previewUrl,      setPreviewUrl]      = useState(null)
  const [showPreview,     setShowPreview]     = useState(false)

  /* ── File upload handler ─────────────────────────── */
  const handleFileChange = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setPhotoError('')
    setLoadingPhoto(true)
    try {
      const dataUrl = await anyImageToJpeg(file)
      setRawPhoto(dataUrl)
      setCorners(DEFAULT_CORNERS)   // reset corners for new photo
      setShowPreview(false)
      setPreviewUrl(null)
    } catch (err) {
      setPhotoError('Could not load that image. Try a JPEG, PNG, or HEIC file.')
    } finally {
      setLoadingPhoto(false)
    }
  }, [])

  /* ── Measure the displayed image (re-runs when rawPhoto changes) ── */
  useEffect(() => {
    if (!rawPhoto) return
    const measure = () => {
      if (!imgRef.current) return
      setImgSize({ w: imgRef.current.offsetWidth, h: imgRef.current.offsetHeight })
    }
    // Small delay so the img element has been rendered into the DOM
    const raf = requestAnimationFrame(() => {
      const img = imgRef.current
      if (!img) return
      if (img.complete && img.naturalWidth) measure()
      else img.addEventListener('load', measure)
      const ro = new ResizeObserver(measure)
      ro.observe(img)
      return () => { img.removeEventListener('load', measure); ro.disconnect() }
    })
    return () => cancelAnimationFrame(raf)
  }, [rawPhoto])

  /* ── Shared corner-move logic ───────────────────────── */
  const moveCorner = useCallback((clientX, clientY, idx) => {
    if (!imgRef.current) return
    const rect = imgRef.current.getBoundingClientRect()
    const nx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const ny = Math.max(0, Math.min(1, (clientY - rect.top)  / rect.height))
    setCorners(c => c.map((pt, i) => i === idx ? [nx, ny] : pt))
  }, [])

  /* ── Drag a corner handle (mouse) ───────────────────── */
  const handleMouseDown = useCallback((e, idx) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    const move = (ev) => moveCorner(ev.clientX, ev.clientY, idx)
    const up   = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [moveCorner])

  /* ── Drag a corner handle (touch) ───────────────────── */
  const handleTouchStart = useCallback((e, idx) => {
    if (e.touches.length !== 1) return
    e.stopPropagation(); e.preventDefault()
    const move = (ev) => { ev.preventDefault(); if (ev.touches[0]) moveCorner(ev.touches[0].clientX, ev.touches[0].clientY, idx) }
    const up   = () => { window.removeEventListener('touchmove', move); window.removeEventListener('touchend', up) }
    window.addEventListener('touchmove', move, { passive: false })
    window.addEventListener('touchend',  up,   { passive: true })
  }, [moveCorner])

  /* ── Apply the perspective warp ─────────────────────── */
  const handleApply = useCallback(async () => {
    setErrorMsg('')
    setIsProcessing(true)
    setProgress(0)
    setStatusMsg('Preparing…')

    await new Promise(r => setTimeout(r, 40))

    try {
      // If rawPhoto is an external URL (recalibrate case), fetch it and convert to a
      // data URL first — otherwise canvas.getImageData() throws a CORS security error.
      let safeDataUrl = rawPhoto
      if (rawPhoto && !rawPhoto.startsWith('data:')) {
        setStatusMsg('Fetching image…')
        const res = await fetch(rawPhoto)
        const blob = await res.blob()
        safeDataUrl = await blobToDataUrl(blob)
      }

      // Create a fresh Image from the (guaranteed same-origin) data URL
      const safeImg = await new Promise((res, rej) => {
        const im = new Image()
        im.onload = () => res(im)
        im.onerror = () => rej(new Error('Image failed to load for warping'))
        im.src = safeDataUrl
      })

      const iw = safeImg.naturalWidth
      const ih = safeImg.naturalHeight
      if (!iw || !ih) throw new Error('Image has zero dimensions')

      const pixelCorners = corners.map(([nx, ny]) => [nx * iw, ny * ih])

      // Output at wallWidth:wallHeight ratio, 1280px wide
      const outW = 1280
      const outH = Math.round(outW * wallHeight / wallWidth)

      setStatusMsg('Warping perspective…')

      const dataUrl = await warpPerspectiveAsync(
        safeImg,
        pixelCorners,
        outW,
        outH,
        (p) => {
          setProgress(p)
          setStatusMsg(`Warping… ${Math.round(p * 100)}%`)
        }
      )

      setPreviewUrl(dataUrl)
      setShowPreview(true)
      setIsProcessing(false)
    } catch (err) {
      console.error('[WallSetup] warp error:', err)
      setIsProcessing(false)
      setErrorMsg('Warp failed: ' + (err.message || String(err)))
    }
  }, [corners, rawPhoto, wallWidth, wallHeight])

  /* ── Compute SVG polygon from current handles ──────── */
  const polyPoints = corners
    .map(([nx, ny]) => `${nx * imgSize.w},${ny * imgSize.h}`)
    .join(' ')

  // Edge midpoints for labels
  const edgeLabels = [
    {
      x: ((corners[0][0] + corners[1][0]) / 2) * imgSize.w,
      y: ((corners[0][1] + corners[1][1]) / 2) * imgSize.h - 14,
      text: `← ${wallWidth}" →`,
    },
    {
      x: ((corners[1][0] + corners[2][0]) / 2) * imgSize.w + 14,
      y: ((corners[1][1] + corners[2][1]) / 2) * imgSize.h,
      text: `${wallHeight}"`,
    },
  ]

  /* ── Upload step ──────────────────────────────────── */
  if (!rawPhoto) {
    return (
      <div className="ws-backdrop">
        <div className="ws-modal ws-modal--upload">
          <div className="ws-header">
            <div className="ws-title-row">
              <span className="ws-icon">📸</span>
              <h2>Upload Wall Photo — {wallName}</h2>
            </div>
            <p className="ws-subtitle">
              Upload a photo of your wall taken straight-on. In the next step you’ll drag
              the 4 corner handles to mark the exact boundary of the <strong>{wallWidth}″ × {wallHeight}″</strong> wall area.
            </p>
          </div>

          <div className="ws-upload-body">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            <button
              className="ws-upload-zone"
              onClick={() => fileInputRef.current?.click()}
              disabled={loadingPhoto}
            >
              {loadingPhoto ? (
                <><div className="ms-spinner" /><span>Loading photo…</span></>
              ) : (
                <>
                  <span className="ws-upload-icon">🖼️</span>
                  <span className="ws-upload-label">Click to choose a wall photo</span>
                  <span className="ws-upload-sub">JPEG, PNG, WebP, HEIC</span>
                </>
              )}
            </button>
            {photoError && <p className="ws-upload-error">{photoError}</p>}
          </div>

          <div className="ws-footer" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="ws-backdrop">
      <div className="ws-modal">

        {/* Header */}
        <div className="ws-header">
          <div className="ws-title-row">
            <span className="ws-icon">📐</span>
            <h2>Calibrate — {wallName}</h2>
          </div>
          <p className="ws-subtitle">
            Drag the four colored handles to the exact corners of your <strong>{wallWidth}″ × {wallHeight}″</strong> wall.
            The app will correct the perspective so pieces are placed to true scale.
          </p>
        </div>

        {/* Body */}
        <div className="ws-body">
          {!showPreview ? (
            /* ── Corner picker ── */
            <div className="ws-photo-wrap">
              <img
                ref={imgRef}
                src={rawPhoto}
                className="ws-photo"
                alt="Wall photo"
                draggable={false}
              />

              {/* SVG quad overlay */}
              {imgSize.w > 0 && (
                <svg
                  className="ws-svg"
                  width={imgSize.w}
                  height={imgSize.h}
                >
                  <polygon
                    points={polyPoints}
                    fill="rgba(124,111,247,0.10)"
                    stroke="rgba(124,111,247,0.55)"
                    strokeWidth="2"
                    strokeDasharray="6 3"
                  />
                  {edgeLabels.map((el, i) => (
                    <text
                      key={i}
                      x={el.x} y={el.y}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fill="rgba(255,255,255,0.8)"
                      fontSize="13"
                      fontWeight="600"
                      stroke="rgba(0,0,0,0.6)"
                      strokeWidth="3"
                      paintOrder="stroke"
                    >
                      {el.text}
                    </text>
                  ))}
                </svg>
              )}

              {/* Draggable corner handles — small dots */}
              {imgSize.w > 0 && CORNER_META.map((meta, idx) => (
                <div
                  key={idx}
                  className="ws-handle"
                  data-label={meta.full}
                  style={{
                    left:            corners[idx][0] * imgSize.w,
                    top:             corners[idx][1] * imgSize.h,
                    backgroundColor: meta.color + '55',
                    borderColor:     meta.color,
                    boxShadow:       `0 0 0 2px rgba(0,0,0,0.4), 0 2px 6px rgba(0,0,0,0.5)`,
                    touchAction:     'none',
                  }}
                  onMouseDown={(e) => handleMouseDown(e, idx)}
                  onTouchStart={(e) => handleTouchStart(e, idx)}
                />
              ))}

              {/* Progress bar while processing */}
              {isProcessing && (
                <div className="ws-progress-overlay">
                  <div className="ws-progress-bar">
                    <div className="ws-progress-fill" style={{ width: `${progress * 100}%` }} />
                  </div>
                  <span className="ws-progress-text">{statusMsg}</span>
                </div>
              )}
              {errorMsg && !isProcessing && (
                <div className="ws-error-banner">{errorMsg}</div>
              )}
            </div>
          ) : (
            /* ── Preview of warped result ── */
            <div className="ws-preview-wrap">
              <div className="ws-preview-badge">✓ Corrected Wall Preview</div>
              <img src={previewUrl} className="ws-preview-img" alt="Corrected wall" />
              <div className="ws-preview-meta">
                {wallWidth}" × {wallHeight}" — perspective corrected &amp; ready to use
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="ws-footer">
          <div className="ws-legend">
            {CORNER_META.map((m, i) => (
              <span key={i} className="ws-legend-item">
                <span className="ws-legend-dot" style={{ background: m.color }} />
                {m.full}
              </span>
            ))}
          </div>

          <div className="ws-actions">
            {showPreview ? (
              <>
                <button className="btn btn-ghost" onClick={() => setShowPreview(false)}>
                  ← Re-adjust
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => onApply(previewUrl, corners)}
                >
                  ✓ Use This Wall
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-ghost" onClick={onClose} disabled={isProcessing}>
                  Cancel
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => { setRawPhoto(null); setCorners(DEFAULT_CORNERS) }}
                  disabled={isProcessing}
                >
                  📂 Change Photo
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setCorners(DEFAULT_CORNERS)}
                  disabled={isProcessing}
                >
                  Reset Corners
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleApply}
                  disabled={isProcessing}
                >
                  {isProcessing ? `⏳ ${Math.round(progress * 100)}%…` : '⚡ Apply Correction'}
                </button>
              </>
            )}
          </div>
        </div>

      </div>
    </div>
  )
}
