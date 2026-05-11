import { useState, useRef, useCallback, useEffect } from 'react'
import { warpPerspectiveAsync } from '../utils/homography'
import { BASE as API_BASE } from '../utils/api'
import { inToCmInt, cmToIn } from '../utils/units'
import { HANDLE_OFFSET, HANDLE_PAD, HANDLE_DIR, HANDLE_COLORS, WARP_SVG_W, computeLidarDims } from '../utils/warpHandles'

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
  } catch {
    // fall through
  }

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
  } catch {
    // fall through
  }

  throw new Error('Could not decode image')
}


export default function WallSetup({ onApply, onClose, wallName = 'Wall', wallWidth = 120, wallHeight = 96, existingImageUrl = null, unitSystem = 'imperial', cameraData = null, pointCloud = null }) {
  const svgRef            = useRef(null)
  const fileInputRef      = useRef(null)
  const photoWrapRef      = useRef(null)
  const [rawPhoto,        setRawPhoto]        = useState(existingImageUrl)
  const [loadingPhoto,    setLoadingPhoto]    = useState(false)
  const [photoError,      setPhotoError]      = useState('')
  const [imgNaturalSize,  setImgNaturalSize]  = useState({ w: 0, h: 0 })
  const [lidarMeasured,   setLidarMeasured]   = useState(false)
  const [corners,         setCorners]         = useState(DEFAULT_CORNERS)
  const [progress,        setProgress]        = useState(0)
  const [isProcessing,    setIsProcessing]    = useState(false)
  const [statusMsg,       setStatusMsg]       = useState('')
  const [editWidth,       setEditWidth]       = useState(unitSystem === 'metric' ? inToCmInt(wallWidth)  : wallWidth)
  const [editHeight,      setEditHeight]      = useState(unitSystem === 'metric' ? inToCmInt(wallHeight) : wallHeight)
  const [errorMsg,        setErrorMsg]        = useState('')
  const [previewUrl,      setPreviewUrl]      = useState(null)
  const [showPreview,     setShowPreview]     = useState(false)

  /* ── Block context-menu and prevent scroll-start in the image/handle zone ── */
  useEffect(() => {
    const el = photoWrapRef.current
    if (!el) return
    const prevent = (e) => e.preventDefault()
    // contextmenu fires on long-press; blocking it stops iOS "Save Image" sheet
    el.addEventListener('contextmenu', prevent, false)
    // touchstart with passive:false lets us call preventDefault before browser
    // decides to start a scroll gesture
    el.addEventListener('touchstart', prevent, { passive: false })
    return () => {
      el.removeEventListener('contextmenu', prevent)
      el.removeEventListener('touchstart', prevent)
    }
  }, [])

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
    } catch {
      setPhotoError('Could not load that image. Try a JPEG, PNG, or HEIC file.')
    } finally {
      setLoadingPhoto(false)
    }
  }, [])

  /* ── Natural image dimensions (drive SVG viewBox height) ── */
  useEffect(() => {
    if (!rawPhoto) return
    const img = new Image()
    img.onload = () => setImgNaturalSize({ w: img.naturalWidth, h: img.naturalHeight })
    img.src = rawPhoto
  }, [rawPhoto])

  /* ── LiDAR-based live dimension update ──────────────── */
  useEffect(() => {
    const lidarCloud = pointCloud?._buffer ?? pointCloud
    const pointCount = lidarCloud?._len ?? lidarCloud?.pointCount ?? 0
    if (!cameraData || !lidarCloud || pointCount === 0 || !rawPhoto) return
    const tid = setTimeout(() => {
      const dims = computeLidarDims(corners, cameraData, pointCloud)
      if (dims) {
        if (unitSystem === 'metric') {
          setEditWidth(inToCmInt(dims.widthIn))
          setEditHeight(inToCmInt(dims.heightIn))
        } else {
          setEditWidth(dims.widthIn)
          setEditHeight(dims.heightIn)
        }
        setLidarMeasured(true)
      }
    }, 120)
    return () => clearTimeout(tid)
  }, [corners, cameraData, pointCloud, rawPhoto, unitSystem])

  /* ── SVG pointer-capture drag ───────────────────────── */
  const startDrag = useCallback((idx, e) => {
    e.stopPropagation(); e.preventDefault()
    const captureEl = e.currentTarget
    captureEl.setPointerCapture(e.pointerId)
    const k = ['tl','tr','br','bl'][idx]
    const [ddx, ddy] = HANDLE_DIR[k]
    const ox = ddx * HANDLE_OFFSET
    const oy = ddy * HANDLE_OFFSET
    const svgH = imgNaturalSize.h > 0 ? Math.round(WARP_SVG_W * imgNaturalSize.h / imgNaturalSize.w) : 360
    const onMove = (ev) => {
      const svg = svgRef.current
      if (!svg) return
      const svgPt = svg.createSVGPoint()
      svgPt.x = ev.clientX; svgPt.y = ev.clientY
      const sp = svgPt.matrixTransform(svg.getScreenCTM().inverse())
      setCorners(prev => prev.map((c, i) => i === idx
        ? [Math.max(0, Math.min(1, (sp.x - ox) / WARP_SVG_W)),
           Math.max(0, Math.min(1, (sp.y - oy) / svgH))]
        : c
      ))
    }
    const onUp = () => {
      captureEl.removeEventListener('pointermove',   onMove)
      captureEl.removeEventListener('pointerup',     onUp)
      captureEl.removeEventListener('pointercancel', onUp)
    }
    captureEl.addEventListener('pointermove',   onMove)
    captureEl.addEventListener('pointerup',     onUp)
    captureEl.addEventListener('pointercancel', onUp)
  }, [imgNaturalSize])

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
      const outH = Math.round(outW * editHeight / editWidth)

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
  }, [corners, editHeight, editWidth, rawPhoto])

  /* ── SVG coordinate space ───────────────────────────── */
  const SVG_H = imgNaturalSize.h > 0 ? Math.round(WARP_SVG_W * imgNaturalSize.h / imgNaturalSize.w) : 360

  /* ── Compute SVG polygon from current handles ──────── */
  const polyPoints = corners
    .map(([nx, ny]) => `${nx * WARP_SVG_W},${ny * SVG_H}`)
    .join(' ')

  // Edge midpoints for labels
  const edgeLabels = [
    {
      x: ((corners[0][0] + corners[1][0]) / 2) * WARP_SVG_W,
      y: ((corners[0][1] + corners[1][1]) / 2) * SVG_H - 14,
      text: unitSystem === 'metric' ? `← ${editWidth} cm →` : `← ${editWidth}" →`,
    },
    {
      x: ((corners[1][0] + corners[2][0]) / 2) * WARP_SVG_W + 14,
      y: ((corners[1][1] + corners[2][1]) / 2) * SVG_H,
      text: unitSystem === 'metric' ? `${editHeight} cm` : `${editHeight}"`,
    },
  ]

  /* ── Upload step ──────────────────────────────────── */
  if (!rawPhoto) {
    return (
      <div className="ws-backdrop">
        <div className="ws-modal ws-modal--upload">
          <div className="ws-header">
            <div className="ws-title-row">
              <span className="ws-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="5" width="16" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/><circle cx="10" cy="11" r="3" stroke="currentColor" strokeWidth="1.5"/><path d="M7 5l1-2h4l1 2" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg></span>
              <h2>Upload Wall Photo: {wallName}</h2>
            </div>
            <p className="ws-subtitle">
              Upload a photo of your wall taken straight-on. In the next step you’ll drag
              the 4 corner handles to mark the exact boundary of the wall area.
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
                  <span className="ws-upload-icon"><svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="8" width="24" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" opacity="0.5"/><circle cx="16" cy="17" r="4" stroke="currentColor" strokeWidth="1.5" opacity="0.5"/><path d="M12 8l2-3h8l2 3" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" opacity="0.5"/></svg></span>
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
            <span className="ws-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 17L17 3M3 17h5M3 17v-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M7 13l3-3M10 7l3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></span>
            <h2>Calibrate: {wallName}</h2>
          </div>
          <p className="ws-subtitle">
            Drag the four colored handles to the exact corners of your wall.
            The app will correct the perspective so pieces are placed to true scale.
          </p>
        </div>

        {/* Body */}
        <div className="ws-body">
          {!showPreview ? (
            /* ── Corner picker ── */
          <div className="ws-photo-wrap" ref={photoWrapRef}>
            {imgNaturalSize.w > 0 && (
              <svg
                ref={svgRef}
                viewBox={`${-HANDLE_PAD} ${-HANDLE_PAD} ${WARP_SVG_W + 2*HANDLE_PAD} ${SVG_H + 2*HANDLE_PAD}`}
                className="ws-svg"
                style={{
                  display: 'block',
                  position: 'relative',
                  width: '100%',
                  maxHeight: 'calc(96vh - 240px)',
                  touchAction: 'none',
                  aspectRatio: `${WARP_SVG_W + 2*HANDLE_PAD} / ${SVG_H + 2*HANDLE_PAD}`,
                }}
              >
                <defs>
                  <clipPath id="ws-photo-clip">
                    <rect x="0" y="0" width={WARP_SVG_W} height={SVG_H} />
                  </clipPath>
                </defs>

                {/* Photo */}
                <image
                  href={rawPhoto}
                  x="0" y="0"
                  width={WARP_SVG_W} height={SVG_H}
                  preserveAspectRatio="xMidYMid meet"
                  clipPath="url(#ws-photo-clip)"
                />

                {/* Selection polygon */}
                <polygon
                  points={polyPoints}
                  fill="rgba(124,111,247,0.10)"
                  stroke="rgba(124,111,247,0.55)"
                  strokeWidth="2"
                  strokeDasharray="6 3"
                  clipPath="url(#ws-photo-clip)"
                  style={{ pointerEvents: 'none' }}
                />

                {/* Edge labels */}
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
                    style={{ pointerEvents: 'none' }}
                  >
                    {el.text}
                  </text>
                ))}

                {/* Corner handles — offset ring + dashed connector + crosshair */}
                {CORNER_META.map((meta, idx) => {
                  const k   = ['tl','tr','br','bl'][idx]
                  const hx  = corners[idx][0] * WARP_SVG_W
                  const hy  = corners[idx][1] * SVG_H
                  const [ddx, ddy] = HANDLE_DIR[k]
                  const hpx = hx + ddx * HANDLE_OFFSET
                  const hpy = hy + ddy * HANDLE_OFFSET
                  const CX  = 6
                  const color = HANDLE_COLORS[k]
                  return (
                    <g key={k}>
                      {/* Black backing on connector */}
                      <line x1={hx} y1={hy} x2={hpx} y2={hpy}
                        stroke="rgba(0,0,0,0.55)" strokeWidth="3"
                        style={{ pointerEvents: 'none' }} />
                      {/* Dashed coloured connector */}
                      <line x1={hx} y1={hy} x2={hpx} y2={hpy}
                        stroke={color} strokeWidth="1.5" strokeDasharray="4 3"
                        style={{ pointerEvents: 'none' }} />
                      {/* Crosshair at the exact corner */}
                      <line x1={hx-CX} y1={hy} x2={hx+CX} y2={hy}
                        stroke={color} strokeWidth="1.5" style={{ pointerEvents: 'none' }} />
                      <line x1={hx} y1={hy-CX} x2={hx} y2={hy+CX}
                        stroke={color} strokeWidth="1.5" style={{ pointerEvents: 'none' }} />
                      {/* Draggable hollow ring */}
                      <g onPointerDown={e => startDrag(idx, e)}
                        style={{ cursor: 'grab', touchAction: 'none' }}>
                        <circle cx={hpx} cy={hpy} r={26} fill="transparent" />
                        <circle cx={hpx} cy={hpy} r={12}
                          fill="rgba(0,0,0,0.35)" stroke={color} strokeWidth="2" />
                        <text x={hpx} y={hpy}
                          textAnchor="middle" dominantBaseline="central"
                          fontSize="8" fill={color} fontWeight="800" opacity="0.9"
                          style={{ pointerEvents: 'none', userSelect: 'none' }}>
                          {meta.label}
                        </text>
                      </g>
                    </g>
                  )
                })}
              </svg>
            )}

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
                {unitSystem === 'metric'
                  ? `${editWidth} × ${editHeight} cm · perspective corrected & ready to use`
                  : `${editWidth}" × ${editHeight}" · perspective corrected & ready to use`
                }
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

          {/* Live LiDAR scan measurement banner */}
          {cameraData && (
            <div className={`ws-scan-measure ${lidarMeasured ? 'ws-scan-measure--ready' : ''}`}>
              {lidarMeasured ? (
                <>
                  <span className="ws-scan-measure__icon">⌖</span>
                  <span className="ws-scan-measure__dims">
                    {unitSystem === 'metric'
                      ? `${editWidth} × ${editHeight} cm`
                      : `${editWidth}" × ${editHeight}"`
                    }
                  </span>
                  <span className="ws-scan-measure__label">from LiDAR scan</span>
                </>
              ) : (
                <>
                  <span className="ws-scan-measure__spinner" />
                  <span className="ws-scan-measure__label">Measuring from LiDAR scan…</span>
                </>
              )}
            </div>
          )}

          {/* Editable wall dimensions */}
          <div className="ws-dims-row">
            <label className="ws-dims-label">
              Wall size ({unitSystem === 'metric' ? 'cm' : 'inches'})
              :
            </label>
            <div className="ws-dims-inputs">
              <input
                className="ws-dim-input"
                type="number" min="1" max={unitSystem === 'metric' ? 1500 : 600}
                step={unitSystem === 'metric' ? '1' : '0.5'}
                value={editWidth}
                onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0) setEditWidth(v) }}
                aria-label={`Width in ${unitSystem === 'metric' ? 'cm' : 'inches'}`}
              />
              <span className="ws-dims-sep">×</span>
              <input
                className="ws-dim-input"
                type="number" min="1" max={unitSystem === 'metric' ? 1500 : 600}
                step={unitSystem === 'metric' ? '1' : '0.5'}
                value={editHeight}
                onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0) setEditHeight(v) }}
                aria-label={`Height in ${unitSystem === 'metric' ? 'cm' : 'inches'}`}
              />
              <span className="ws-dims-unit">{unitSystem === 'metric' ? 'cm' : 'in'}</span>
            </div>
          </div>

          <div className="ws-actions">
            {showPreview ? (
              <>
                <button className="btn btn-ghost" onClick={() => setShowPreview(false)}>
                  ← Re-adjust
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    const wIn = unitSystem === 'metric' ? Math.round(cmToIn(editWidth))  : editWidth
                    const hIn = unitSystem === 'metric' ? Math.round(cmToIn(editHeight)) : editHeight
                    onApply(previewUrl, corners, { width: wIn, height: hIn })
                  }}
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
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg" className="btn-icon"><path d="M1.5 10.5V4a1 1 0 011-1h2.5l1 1.5H10a1 1 0 011 1v5a1 1 0 01-1 1H2.5a1 1 0 01-1-1z" stroke="currentColor" strokeWidth="1.25"/></svg>
                  Change Photo
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
                  {isProcessing ? `${Math.round(progress * 100)}%…` : 'Apply Correction'}
                </button>
              </>
            )}
          </div>
        </div>

      </div>
    </div>
  )
}
