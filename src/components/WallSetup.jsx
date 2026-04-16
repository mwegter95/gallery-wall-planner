import { useState, useRef, useCallback, useEffect } from 'react'
import { warpPerspectiveAsync } from '../utils/homography'

/**
 * Default corner positions as fractions [0-1] of the photo dimensions.
 * These are initial estimates for the wall photo — user drags to fine-tune.
 *
 * Looking at the photo (2400×1800):
 *   The green wall starts after the kitchen opening on the left,
 *   and the vaulted ceiling creates a slight diagonal at the top.
 *
 *   TL ≈ (0.21, 0.05)   TR ≈ (0.99, 0.09)
 *   BL ≈ (0.21, 0.96)   BR ≈ (0.99, 0.96)
 */
const DEFAULT_CORNERS = [
  [0.21, 0.05],   // 0: Top-Left
  [0.99, 0.09],   // 1: Top-Right
  [0.99, 0.96],   // 2: Bottom-Right
  [0.21, 0.96],   // 3: Bottom-Left
]

const CORNER_META = [
  { label: 'TL', full: 'Top-Left',     color: '#f97316' },
  { label: 'TR', full: 'Top-Right',    color: '#22d3ee' },
  { label: 'BR', full: 'Bottom-Right', color: '#a78bfa' },
  { label: 'BL', full: 'Bottom-Left',  color: '#34d399' },
]

const STORAGE_KEY = 'gwp-wall-corners'

export default function WallSetup({ onApply, onClose, existingDataUrl }) {
  const imgRef       = useRef(null)
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 })

  // Load saved corners or use defaults
  const [corners, setCorners] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY))
      if (saved?.length === 4) return saved
    } catch {}
    return DEFAULT_CORNERS
  })

  const [progress,     setProgress]     = useState(0)
  const [isProcessing, setIsProcessing] = useState(false)
  const [statusMsg,    setStatusMsg]    = useState('')
  const [previewUrl,   setPreviewUrl]   = useState(existingDataUrl || null)
  const [showPreview,  setShowPreview]  = useState(false)

  /* ── Measure the displayed image ─────────────────── */
  useEffect(() => {
    const measure = () => {
      if (!imgRef.current) return
      setImgSize({ w: imgRef.current.offsetWidth, h: imgRef.current.offsetHeight })
    }
    const img = imgRef.current
    if (img?.complete) measure()
    else img?.addEventListener('load', measure)
    const ro = new ResizeObserver(measure)
    if (img) ro.observe(img)
    return () => { img?.removeEventListener('load', measure); ro.disconnect() }
  }, [])

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

  /* ── Apply the perspective warp ──────────────────── */
  const handleApply = useCallback(async () => {
    const img = imgRef.current
    if (!img?.complete || !img.naturalWidth) {
      setStatusMsg('Image not loaded yet — please wait a moment.')
      return
    }
    setIsProcessing(true)
    setProgress(0)
    setStatusMsg('Preparing…')

    // Persist corners
    localStorage.setItem(STORAGE_KEY, JSON.stringify(corners))

    await new Promise(r => setTimeout(r, 30))  // Let UI update

    try {
      const iw = img.naturalWidth
      const ih = img.naturalHeight
      const pixelCorners = corners.map(([nx, ny]) => [nx * iw, ny * ih])

      // Output at 128:95 ratio, 1280px wide
      const outW = 1280
      const outH = Math.round(outW * 95 / 128)  // 950px

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

  /* ── Compute SVG polygon from current handles ────── */
  const polyPoints = corners
    .map(([nx, ny]) => `${nx * imgSize.w},${ny * imgSize.h}`)
    .join(' ')

  // Edge midpoints for labels
  const edgeLabels = [
    { // top edge
      x: ((corners[0][0] + corners[1][0]) / 2) * imgSize.w,
      y: ((corners[0][1] + corners[1][1]) / 2) * imgSize.h - 14,
      text: '← 128" →',
    },
    { // right edge
      x: ((corners[1][0] + corners[2][0]) / 2) * imgSize.w + 14,
      y: ((corners[1][1] + corners[2][1]) / 2) * imgSize.h,
      text: '95"',
    },
  ]

  return (
    <div className="ws-backdrop">
      <div className="ws-modal">

        {/* Header */}
        <div className="ws-header">
          <div className="ws-title-row">
            <span className="ws-icon">📐</span>
            <h2>Calibrate Wall Perspective</h2>
          </div>
          <p className="ws-subtitle">
            Drag the four colored handles to the exact corners of your <strong>128" × 95"</strong> wall.
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
                src="/wall.jpg"
                className="ws-photo"
                alt="Wall photo"
                draggable={false}
                crossOrigin="anonymous"
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
