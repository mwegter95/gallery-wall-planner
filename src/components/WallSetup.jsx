import { useState, useRef, useCallback, useEffect } from 'react'
import { warpPerspectiveAsync } from '../utils/homography'

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

/** Convert a File to a data URL via an img element → canvas (handles most formats) */
async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const objUrl = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(objUrl)
      // Scale down very large photos so the corner-picker is responsive
      const MAX = 2400
      const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight))
      const w = Math.round(img.naturalWidth * scale)
      const h = Math.round(img.naturalHeight * scale)
      const c = Object.assign(document.createElement('canvas'), { width: w, height: h })
      c.getContext('2d').drawImage(img, 0, 0, w, h)
      resolve(c.toDataURL('image/jpeg', 0.92))
    }
    img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error('Could not load image')) }
    img.src = objUrl
  })
}

export default function WallSetup({ onApply, onClose, wallName = 'Wall' }) {
  const imgRef            = useRef(null)
  const fileInputRef      = useRef(null)
  const [rawPhoto,        setRawPhoto]        = useState(null)   // data URL of uploaded photo
  const [loadingPhoto,    setLoadingPhoto]    = useState(false)
  const [photoError,      setPhotoError]      = useState('')
  const [imgSize,         setImgSize]         = useState({ w: 0, h: 0 })
  const [corners,         setCorners]         = useState(DEFAULT_CORNERS)
  const [progress,        setProgress]        = useState(0)
  const [isProcessing,    setIsProcessing]    = useState(false)
  const [statusMsg,       setStatusMsg]       = useState('')
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
      const dataUrl = await fileToDataUrl(file)
      setRawPhoto(dataUrl)
      setCorners(DEFAULT_CORNERS)   // reset corners for new photo
      setShowPreview(false)
      setPreviewUrl(null)
    } catch (err) {
      setPhotoError('Could not load that image. Try a JPEG or PNG file.')
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

  /* ── Drag a corner handle ────────────────────────── */
  const handleMouseDown = useCallback((e, idx) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()

    const move = (ev) => {
      if (!imgRef.current) return
      const rect = imgRef.current.getBoundingClientRect()
      const nx = Math.max(0, Math.min(1, (ev.clientX - rect.left)  / rect.width))
      const ny = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height))
      setCorners(c => c.map((pt, i) => i === idx ? [nx, ny] : pt))
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [])

  /* ── Apply the perspective warp ─────────────────────── */
  const handleApply = useCallback(async () => {
    const img = imgRef.current
    if (!img?.complete || !img.naturalWidth) {
      setStatusMsg('Image not loaded yet — please wait a moment.')
      return
    }
    setIsProcessing(true)
    setProgress(0)
    setStatusMsg('Preparing…')

    await new Promise(r => setTimeout(r, 30))

    try {
      const iw = img.naturalWidth
      const ih = img.naturalHeight
      const pixelCorners = corners.map(([nx, ny]) => [nx * iw, ny * ih])

      // Output at 128:95 ratio, 1280px wide
      const outW = 1280
      const outH = Math.round(outW * 95 / 128)

      setStatusMsg('Warping perspective…')

      const dataUrl = await warpPerspectiveAsync(
        img,
        pixelCorners,
        outW,
        outH,
        (p) => {
          setProgress(p)
          setStatusMsg(`Warping perspective… ${Math.round(p * 100)}%`)
        }
      )

      setPreviewUrl(dataUrl)
      setShowPreview(true)
      setStatusMsg('Done! Check the preview, then click "Use This Wall".')
      setIsProcessing(false)
    } catch (err) {
      console.error(err)
      setStatusMsg('Error: ' + err.message)
      setIsProcessing(false)
    }
  }, [corners])

  /* ── Compute SVG polygon from current handles ──────── */
  const polyPoints = corners
    .map(([nx, ny]) => `${nx * imgSize.w},${ny * imgSize.h}`)
    .join(' ')

  // Edge midpoints for labels
  const edgeLabels = [
    {
      x: ((corners[0][0] + corners[1][0]) / 2) * imgSize.w,
      y: ((corners[0][1] + corners[1][1]) / 2) * imgSize.h - 14,
      text: '← 128" →',
    },
    {
      x: ((corners[1][0] + corners[2][0]) / 2) * imgSize.w + 14,
      y: ((corners[1][1] + corners[2][1]) / 2) * imgSize.h,
      text: '95"',
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
              the 4 corner handles to mark the exact boundary of the <strong>128″ × 95″</strong> wall area.
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
            Drag the four colored handles to the exact corners of your <strong>128″ × 95″</strong> wall.
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
                    background:      meta.color,
                    borderColor:     'rgba(255,255,255,0.9)',
                    boxShadow:       `0 0 0 2px ${meta.color}, 0 2px 6px rgba(0,0,0,0.6)`,
                  }}
                  onMouseDown={(e) => handleMouseDown(e, idx)}
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
            </div>
          ) : (
            /* ── Preview of warped result ── */
            <div className="ws-preview-wrap">
              <div className="ws-preview-badge">✓ Corrected Wall Preview</div>
              <img src={previewUrl} className="ws-preview-img" alt="Corrected wall" />
              <div className="ws-preview-meta">
                128" × 95" — perspective corrected &amp; ready to use
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
