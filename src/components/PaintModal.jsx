import { useState, useRef, useEffect, useCallback, useMemo } from 'react'

/* ─────────────────────────────────────────────────────────────────────────
   Color conversion helpers
──────────────────────────────────────────────────────────────────────────── */
function hexToHsv(hex) {
  const n = parseInt(hex.replace('#', ''), 16)
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  let h = 0
  if (d !== 0) {
    if      (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else                h = ((r - g) / d + 4) / 6
  }
  return { h: h * 360, s: max === 0 ? 0 : d / max, v: max }
}

function hsvToHex(h, s, v) {
  h = ((h % 360) + 360) % 360
  const i = Math.floor(h / 60) % 6, f = h / 60 - Math.floor(h / 60)
  const p = v*(1-s), q = v*(1-f*s), t = v*(1-(1-f)*s)
  const tbl = [[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]]
  return '#' + tbl[i].map(x => Math.round(x*255).toString(16).padStart(2,'0')).join('')
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#',''), 16)
  return { r:(n>>16)&255, g:(n>>8)&255, b:n&255 }
}

/* ─────────────────────────────────────────────────────────────────────────
   Image helpers
──────────────────────────────────────────────────────────────────────────── */
function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
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

/** Sample a dominant color from an area around (px, py) of an ImageData */
function sampleColor(imageData, px, py, radius = 6) {
  const { data, width: w, height: h } = imageData
  let rSum = 0, gSum = 0, bSum = 0, count = 0
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = px + dx, y = py + dy
      if (x < 0 || x >= w || y < 0 || y >= h) continue
      const i = (y * w + x) * 4
      rSum += data[i]; gSum += data[i+1]; bSum += data[i+2]; count++
    }
  }
  if (!count) return '#888888'
  const r = Math.round(rSum/count).toString(16).padStart(2,'0')
  const g = Math.round(gSum/count).toString(16).padStart(2,'0')
  const b = Math.round(bSum/count).toString(16).padStart(2,'0')
  return `#${r}${g}${b}`
}

/* ─────────────────────────────────────────────────────────────────────────
   Flood-fill from image edges → selects the WALL (edge-connected region)
   tolerance 0–100: higher = more permissive (paints more of similar colors)
──────────────────────────────────────────────────────────────────────────── */
function floodFillWall(imageData, tolerance) {
  const { data, width: w, height: h } = imageData
  const n = w * h
  const isEdge  = new Uint8Array(n)   // 1 = edge-connected (background / wall)
  const queue   = new Int32Array(n + 4)
  let qHead = 0, qTail = 0
  const enqueue = (idx) => {
    if (idx < 0 || idx >= n || isEdge[idx]) return
    isEdge[idx] = 1; queue[qTail++] = idx
  }
  // Seed from all 4 borders
  for (let x = 0; x < w; x++) { enqueue(x); enqueue((h - 1) * w + x) }
  for (let y = 1; y < h - 1; y++) { enqueue(y * w); enqueue(y * w + w - 1) }
  const thresh = tolerance * 2.55
  while (qHead < qTail) {
    const idx = queue[qHead++]
    const x = idx % w, y = (idx / w) | 0, i4 = idx * 4
    const r = data[i4], g = data[i4+1], b = data[i4+2]
    const tryN = (ni) => {
      if (ni < 0 || ni >= n || isEdge[ni]) return
      const n4 = ni * 4
      const dr = data[n4]-r, dg = data[n4+1]-g, db = data[n4+2]-b
      if (Math.sqrt(dr*dr + dg*dg + db*db) <= thresh) enqueue(ni)
    }
    if (x > 0)   tryN(idx - 1)
    if (x < w-1) tryN(idx + 1)
    if (y > 0)   tryN(idx - w)
    if (y < h-1) tryN(idx + w)
  }
  // Wall = edge-connected pixels → return 255 for those
  const alpha = new Uint8ClampedArray(n)
  for (let i = 0; i < n; i++) alpha[i] = isEdge[i] ? 255 : 0
  return alpha
}

/* ─────────────────────────────────────────────────────────────────────────
   HSV Color Picker
──────────────────────────────────────────────────────────────────────────── */
function HsvPicker({ color, onChange }) {
  const { h, s, v } = useMemo(() => hexToHsv(color), [color])
  const svRef   = useRef(null)
  const hueRef  = useRef(null)
  const draggingSv  = useRef(false)
  const draggingHue = useRef(false)
  const pureHue = hsvToHex(h, 1, 1)

  const updateSv = useCallback((e) => {
    const rect = svRef.current?.getBoundingClientRect()
    if (!rect) return
    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top)  / rect.height))
    onChange(hsvToHex(h, nx, 1 - ny))
  }, [h, onChange])

  const updateHue = useCallback((e) => {
    const rect = hueRef.current?.getBoundingClientRect()
    if (!rect) return
    const nx  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    onChange(hsvToHex(nx * 360, s, v))
  }, [s, v, onChange])

  useEffect(() => {
    const onMove = (e) => {
      if (draggingSv.current)  updateSv(e)
      if (draggingHue.current) updateHue(e)
    }
    const onUp = () => { draggingSv.current = false; draggingHue.current = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    window.addEventListener('touchmove', e => onMove(e.touches[0]), { passive: true })
    window.addEventListener('touchend',  onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
  }, [updateSv, updateHue])

  const dotX = `${s * 100}%`
  const dotY = `${(1 - v) * 100}%`
  const hueX = `${(h / 360) * 100}%`

  return (
    <div className="hsv-picker">
      {/* SV box */}
      <div
        ref={svRef}
        className="hsv-sv-box"
        style={{ background: pureHue }}
        onMouseDown={e => { draggingSv.current = true; updateSv(e) }}
        onTouchStart={e => { draggingSv.current = true; updateSv(e.touches[0]) }}
      >
        <div className="hsv-sv-white" />
        <div className="hsv-sv-black" />
        <div className="hsv-dot" style={{ left: dotX, top: dotY, background: color }} />
      </div>
      {/* Hue bar */}
      <div
        ref={hueRef}
        className="hsv-hue-bar"
        onMouseDown={e => { draggingHue.current = true; updateHue(e) }}
        onTouchStart={e => { draggingHue.current = true; updateHue(e.touches[0]) }}
      >
        <div className="hsv-hue-thumb" style={{ left: hueX }} />
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────────
   Preset wall-paint palette
──────────────────────────────────────────────────────────────────────────── */
const PAINT_PALETTE = [
  { name: 'Bright White',  hex: '#F8F6F2' }, { name: 'Warm White',   hex: '#F0EAD6' },
  { name: 'Ivory',         hex: '#EDE8DB' }, { name: 'Linen',        hex: '#E2D9C8' },
  { name: 'Pale Gray',     hex: '#D5D5D2' }, { name: 'Silver',       hex: '#B8BCB9' },
  { name: 'Storm Gray',    hex: '#8A8E94' }, { name: 'Charcoal',     hex: '#474B51' },
  { name: 'Sky',           hex: '#C3D8E8' }, { name: 'Denim',        hex: '#7AA3BF' },
  { name: 'Navy',          hex: '#2B4773' }, { name: 'Sage Teal',    hex: '#7BA499' },
  { name: 'Mint',          hex: '#C5DDD1' }, { name: 'Sage',         hex: '#9AB59A' },
  { name: 'Forest',        hex: '#4A6B4E' }, { name: 'Olive',        hex: '#7A7F54' },
  { name: 'Blush',         hex: '#E8C4B8' }, { name: 'Terracotta',   hex: '#C4875A' },
  { name: 'Rust',          hex: '#A0522D' }, { name: 'Mustard',      hex: '#C8A850' },
  { name: 'Mauve',         hex: '#B08898' }, { name: 'Plum',         hex: '#7B5E7B' },
  { name: 'Midnight',      hex: '#1E2A3A' }, { name: 'Near Black',   hex: '#1A1A1A' },
]

/* ─────────────────────────────────────────────────────────────────────────
   PaintModal
──────────────────────────────────────────────────────────────────────────── */
export default function PaintModal({ wallImage, initialColor, initialMask, onApply, onClose }) {
  /* ── State ──────────────────────────────────────────────────────────── */
  const [phase,        setPhase]        = useState('loading')  // loading|ready|error
  const [paintColor,   setPaintColor]   = useState(initialColor || '#C4875A')
  const [hexInput,     setHexInput]     = useState(initialColor || '#C4875A')
  const [brushMode,    setBrushMode]    = useState('add')   // add|erase
  const [brushRadius,  setBrushRadius]  = useState(30)
  const [sensitivity,  setSensitivity]  = useState(40)
  const [isDetecting,  setIsDetecting]  = useState(false)
  const [detectMsg,    setDetectMsg]    = useState('')
  const [detectPct,    setDetectPct]    = useState(0)
  const [isSampling,   setIsSampling]   = useState(false)
  const [swatchImg,    setSwatchImg]    = useState(null)   // { imageData, w, h }
  const [colorTab,     setColorTab]     = useState('picker') // picker|palette|swatch

  /* ── Refs ───────────────────────────────────────────────────────────── */
  const canvasRef      = useRef(null)
  const swatchDispRef  = useRef(null)
  const origDataRef    = useRef(null)   // ImageData of wall photo
  const maskRef        = useRef(null)   // Uint8ClampedArray alpha mask
  const isPaintingRef  = useRef(false)
  const brushModeRef   = useRef(brushMode)
  const brushRadiusRef = useRef(brushRadius)
  const colorRef       = useRef(paintColor)
  const isSamplingRef  = useRef(isSampling)

  useEffect(() => { brushModeRef.current = brushMode }, [brushMode])
  useEffect(() => { brushRadiusRef.current = brushRadius }, [brushRadius])
  useEffect(() => { colorRef.current = paintColor }, [paintColor])
  useEffect(() => { isSamplingRef.current = isSampling }, [isSampling])

  /* ── Load wall image on mount ───────────────────────────────────────── */
  useEffect(() => {
    if (!wallImage) { setPhase('error'); return }
    setPhase('loading')
    loadImage(wallImage)
      .then(img => {
        origDataRef.current = imageToImageData(img, 1600)
        const { width: w, height: h } = origDataRef.current
        const initCanvas = () => {
          if (canvasRef.current) { canvasRef.current.width = w; canvasRef.current.height = h }
          renderCanvas()
          setPhase('ready')
        }
        if (initialMask) {
          loadImage(initialMask)
            .then(maskImg => {
              const mc = Object.assign(document.createElement('canvas'), { width: w, height: h })
              mc.getContext('2d').drawImage(maskImg, 0, 0, w, h)
              const md = mc.getContext('2d').getImageData(0, 0, w, h)
              const alpha = new Uint8ClampedArray(w * h)
              for (let i = 0; i < w * h; i++) alpha[i] = md.data[i * 4]
              maskRef.current = alpha
              initCanvas()
            })
            .catch(() => { maskRef.current = new Uint8ClampedArray(w * h); initCanvas() })
        } else {
          maskRef.current = new Uint8ClampedArray(w * h)
          initCanvas()
        }
      })
      .catch(() => setPhase('error'))
  }, [wallImage]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Canvas render ──────────────────────────────────────────────────── */
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const orig   = origDataRef.current
    const mask   = maskRef.current
    if (!canvas || !orig || !mask) return
    const { width: w, height: h } = orig
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')

    // 1. Draw original photo
    ctx.putImageData(orig, 0, 0)

    // 2. Tinted overlay on masked pixels — luminance-preserving color blend
    const { r: pr, g: pg, b: pb } = hexToRgb(colorRef.current)
    const overlayData = ctx.getImageData(0, 0, w, h)
    const od = overlayData.data
    for (let i = 0; i < w * h; i++) {
      const a = mask[i]
      if (a === 0) continue
      const i4 = i * 4
      const strength = (a / 255) * 0.72
      const photoR = od[i4], photoG = od[i4+1], photoB = od[i4+2]
      const lum = 0.299 * photoR + 0.587 * photoG + 0.114 * photoB
      const ratio = lum / 255
      od[i4]   = Math.round(photoR * (1 - strength) + (pr * ratio * 2) * strength)
      od[i4+1] = Math.round(photoG * (1 - strength) + (pg * ratio * 2) * strength)
      od[i4+2] = Math.round(photoB * (1 - strength) + (pb * ratio * 2) * strength)
    }
    ctx.putImageData(overlayData, 0, 0)

    // 3. Edge highlight
    const edgeData = ctx.getImageData(0, 0, w, h)
    const ed = edgeData.data
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x
        const m = mask[idx] > 128
        if (m !== (mask[(y-1)*w+x] > 128) || m !== (mask[(y+1)*w+x] > 128) ||
            m !== (mask[y*w+x-1] > 128)   || m !== (mask[y*w+x+1] > 128)) {
          const i4 = idx * 4
          ed[i4]=80; ed[i4+1]=160; ed[i4+2]=255; ed[i4+3]=200
        }
      }
    }
    ctx.putImageData(edgeData, 0, 0)
  }, [])

  // Re-render when color changes
  useEffect(() => {
    if (phase === 'ready') renderCanvas()
  }, [paintColor, phase, renderCanvas])

  /* ── Color helpers ──────────────────────────────────────────────────── */
  const setColor = useCallback((hex) => {
    const h = hex.startsWith('#') ? hex : `#${hex}`
    if (/^#[0-9a-fA-F]{6}$/.test(h)) {
      const lc = h.toLowerCase()
      setPaintColor(lc)
      setHexInput(lc)
    }
  }, [])

  /* ── Brush painting ─────────────────────────────────────────────────── */
  const paintBrush = useCallback((cssX, cssY) => {
    const canvas = canvasRef.current, orig = origDataRef.current, mask = maskRef.current
    if (!canvas || !orig || !mask) return
    const { width: iw, height: ih } = orig
    const rect = canvas.getBoundingClientRect()
    const ix = cssX * (iw / rect.width), iy = cssY * (ih / rect.height)
    const ir = brushRadiusRef.current * Math.max(iw / rect.width, ih / rect.height)
    const x0 = Math.max(0, Math.floor(ix - ir)), x1 = Math.min(iw-1, Math.ceil(ix + ir))
    const y0 = Math.max(0, Math.floor(iy - ir)), y1 = Math.min(ih-1, Math.ceil(iy + ir))
    const adding = brushModeRef.current === 'add'
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dist = Math.sqrt((x - ix)**2 + (y - iy)**2)
        if (dist > ir) continue
        const str = dist <= ir * 0.65 ? 1 : (ir - dist) / (ir * 0.35)
        const delta = Math.round(str * 255)
        const idx = y * iw + x
        mask[idx] = adding ? Math.min(255, mask[idx] + delta) : Math.max(0, mask[idx] - delta)
      }
    }
    renderCanvas()
  }, [renderCanvas])

  /* ── Pointer / touch handlers ───────────────────────────────────────── */
  const getXY = (e) => {
    const cr = canvasRef.current?.getBoundingClientRect()
    return cr ? { x: e.clientX - cr.left, y: e.clientY - cr.top } : null
  }

  const handlePointerDown = useCallback((e) => {
    if (e.button !== 0 || isSamplingRef.current) return
    isPaintingRef.current = true
    const pos = getXY(e); if (pos) paintBrush(pos.x, pos.y)
  }, [paintBrush]) // eslint-disable-line react-hooks/exhaustive-deps

  const handlePointerMove = useCallback((e) => {
    if (!isPaintingRef.current) return
    const pos = getXY(e); if (pos) paintBrush(pos.x, pos.y)
  }, [paintBrush]) // eslint-disable-line react-hooks/exhaustive-deps

  const handlePointerUp = useCallback(() => { isPaintingRef.current = false }, [])

  const handleCanvasClick = useCallback((e) => {
    if (!isSamplingRef.current) return
    const orig = origDataRef.current; if (!orig) return
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const px = Math.round((e.clientX - rect.left) * (orig.width  / rect.width))
    const py = Math.round((e.clientY - rect.top)  * (orig.height / rect.height))
    setColor(sampleColor(orig, px, py, 8))
    setIsSampling(false)
  }, [setColor])

  useEffect(() => {
    const c = canvasRef.current; if (!c) return
    const opts = { passive: false }
    const ots = (e) => { e.preventDefault(); isPaintingRef.current = true; const t = e.touches[0]; const cr = c.getBoundingClientRect(); paintBrush(t.clientX-cr.left, t.clientY-cr.top) }
    const otm = (e) => { e.preventDefault(); if (!isPaintingRef.current || !e.touches[0]) return; const t = e.touches[0]; const cr = c.getBoundingClientRect(); paintBrush(t.clientX-cr.left, t.clientY-cr.top) }
    const ote = () => { isPaintingRef.current = false }
    c.addEventListener('touchstart', ots, opts)
    c.addEventListener('touchmove',  otm, opts)
    c.addEventListener('touchend',   ote)
    return () => { c.removeEventListener('touchstart', ots); c.removeEventListener('touchmove', otm); c.removeEventListener('touchend', ote) }
  }, [paintBrush])

  /* ── Flood-fill auto-detect ─────────────────────────────────────────── */
  const runFloodFill = useCallback(async () => {
    const orig = origDataRef.current; if (!orig) return
    setIsDetecting(true); setDetectMsg('Detecting wall…'); setDetectPct(0)
    await new Promise(r => setTimeout(r, 20))
    maskRef.current = floodFillWall(orig, sensitivity)
    renderCanvas()
    setIsDetecting(false); setDetectMsg('')
  }, [sensitivity, renderCanvas])

  /* ── AI object detection (background-removal, then invert) ─────────── */
  const runAiDetect = useCallback(async () => {
    if (!wallImage) return
    setIsDetecting(true); setDetectMsg('Loading AI model…'); setDetectPct(0)
    try {
      const { removeBackground } = await import('@imgly/background-removal')
      // Fetch wall image as blob
      const res = await fetch(wallImage)
      let blob = await res.blob()
      // Convert to JPEG if needed (library handles jpg/png/webp best)
      if (!['image/jpeg','image/png','image/webp'].includes(blob.type)) {
        const img = await loadImage(wallImage)
        const c = Object.assign(document.createElement('canvas'), { width: img.naturalWidth, height: img.naturalHeight })
        c.getContext('2d').drawImage(img, 0, 0)
        blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.93))
      }
      setDetectMsg('Running detection…')
      // Get foreground mask (white = objects/furniture, black = wall background)
      const maskBlob = await removeBackground(blob, {
        model: 'small',
        output: { type: 'mask', format: 'image/png' },
        progress: (key, cur, total) => {
          if (total > 0) setDetectPct(Math.round(cur / total * 100))
        },
      })
      setDetectMsg('Applying…')
      // Load mask and ensure it matches origData dimensions
      const orig = origDataRef.current
      if (!orig) return
      const { width: w, height: h } = orig
      const maskObjUrl = URL.createObjectURL(maskBlob)
      const maskImg = await loadImage(maskObjUrl)
      URL.revokeObjectURL(maskObjUrl)
      const mc = Object.assign(document.createElement('canvas'), { width: w, height: h })
      mc.getContext('2d').drawImage(maskImg, 0, 0, w, h)
      const md = mc.getContext('2d').getImageData(0, 0, w, h)
      // INVERT: white (255) was objects → we want wall (non-objects) to be white
      const alpha = new Uint8ClampedArray(w * h)
      for (let i = 0; i < w * h; i++) alpha[i] = 255 - md.data[i * 4]
      maskRef.current = alpha
      if (canvasRef.current) { canvasRef.current.width = w; canvasRef.current.height = h }
      renderCanvas()
    } catch (err) {
      console.error('AI wall detect failed:', err)
      setDetectMsg('AI failed — try Auto-fill instead')
      setTimeout(() => setDetectMsg(''), 3000)
    } finally {
      setIsDetecting(false); setDetectPct(0)
    }
  }, [wallImage, renderCanvas])

  /* ── Clear / Invert ─────────────────────────────────────────────────── */
  const clearMask = useCallback(() => {
    const orig = origDataRef.current; if (!orig) return
    maskRef.current = new Uint8ClampedArray(orig.width * orig.height)
    renderCanvas()
  }, [renderCanvas])

  const invertMask = useCallback(() => {
    const mask = maskRef.current; if (!mask) return
    for (let i = 0; i < mask.length; i++) mask[i] = 255 - mask[i]
    renderCanvas()
  }, [renderCanvas])

  /* ── Swatch image upload ────────────────────────────────────────────── */
  const handleSwatchUpload = useCallback((e) => {
    const file = e.target.files?.[0]; if (!file) return
    const url = URL.createObjectURL(file)
    loadImage(url).then(img => {
      const scale = Math.min(1, 300 / Math.max(img.naturalWidth, img.naturalHeight))
      const w = Math.round(img.naturalWidth  * scale), h = Math.round(img.naturalHeight * scale)
      const c = Object.assign(document.createElement('canvas'), { width: w, height: h })
      c.getContext('2d').drawImage(img, 0, 0, w, h)
      const id = c.getContext('2d').getImageData(0, 0, w, h)
      setSwatchImg({ imageData: id, w, h })
      URL.revokeObjectURL(url)
      setTimeout(() => {
        const dc = swatchDispRef.current; if (!dc) return
        dc.width = w; dc.height = h
        dc.getContext('2d').putImageData(id, 0, 0)
      }, 0)
    })
    e.target.value = ''
  }, [])

  const handleSwatchClick = useCallback((e) => {
    const si = swatchImg; if (!si) return
    const dc = swatchDispRef.current; if (!dc) return
    const rect = dc.getBoundingClientRect()
    const px = Math.round((e.clientX - rect.left) * (si.w / rect.width))
    const py = Math.round((e.clientY - rect.top)  * (si.h / rect.height))
    setColor(sampleColor(si.imageData, px, py, 6))
  }, [swatchImg, setColor])

  /* ── Apply — export mask as dataURL ────────────────────────────────── */
  const handleApply = useCallback(() => {
    const orig = origDataRef.current, mask = maskRef.current
    if (!orig || !mask) { onApply(paintColor, null); return }
    const { width: w, height: h } = orig
    const mc = Object.assign(document.createElement('canvas'), { width: w, height: h })
    const ctx = mc.getContext('2d')
    const id = ctx.createImageData(w, h)
    for (let i = 0; i < w * h; i++) {
      id.data[i*4] = id.data[i*4+1] = id.data[i*4+2] = mask[i]
      id.data[i*4+3] = 255
    }
    ctx.putImageData(id, 0, 0)
    onApply(paintColor, mc.toDataURL('image/png'))
  }, [paintColor, onApply])

  /* ── Escape key ─────────────────────────────────────────────────────── */
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])

  /* ── Render ──────────────────────────────────────────────────────────  */
  const detectBtnDisabled = isDetecting || phase !== 'ready'

  return (
    <div className="paint-modal-fullscreen" role="dialog" aria-modal="true">

      {/* ── Header bar ─────────────────────────────────────────────── */}
      <div className="paint-header">
        <div className="paint-header-left">
          <span className="paint-header-title">Paint Wall</span>
          <div className="paint-tool-group">
            <button
              className={`paint-tool-btn ${brushMode === 'add' && !isSampling ? 'active' : ''}`}
              onClick={() => { setBrushMode('add'); setIsSampling(false) }}
              title="Paint brush"
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M2 11c.8-.9 1.7-2.1 3.4-3L9.5 3.5 9 3l-4 4C3.5 8 2.6 9.2 2 11z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="currentColor" fillOpacity="0.2"/>
                <circle cx="9.5" cy="3.5" r="1.5" stroke="currentColor" strokeWidth="1.2"/>
              </svg>
              Paint
            </button>
            <button
              className={`paint-tool-btn ${brushMode === 'erase' && !isSampling ? 'active' : ''}`}
              onClick={() => { setBrushMode('erase'); setIsSampling(false) }}
              title="Eraser"
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M2 11h4M7.5 3l2.5 2.5-5 5L2.5 8l5-5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              </svg>
              Erase
            </button>
            <button
              className={`paint-tool-btn ${isSampling ? 'active' : ''}`}
              onClick={() => setIsSampling(s => !s)}
              title="Pick color from wall photo"
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M8.5 2l2.5 2.5-5.5 5.5L3.5 9l-.5-1.5L8.5 2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                <path d="M2 11l1.5-1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
              Pick Color
            </button>
          </div>
          <div className="paint-brush-size">
            <span className="paint-ctrl-label">Size</span>
            <input type="range" min={5} max={80} value={brushRadius}
              onChange={e => setBrushRadius(Number(e.target.value))}
              className="paint-range" style={{ width: 80 }} />
          </div>
        </div>
        <div className="paint-header-right">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={handleApply} disabled={phase !== 'ready'}>
            Apply Paint
          </button>
        </div>
      </div>

      {/* ── Body ────────────────────────────────────────────────────── */}
      <div className="paint-body">

        {/* ── Left: canvas ─────────────────────────────────────────── */}
        <div className="paint-canvas-panel">
          {/* Canvas */}
          <div className={`paint-canvas-wrap ${isSampling ? 'cursor-eyedropper' : brushMode === 'erase' ? 'cursor-erase' : 'cursor-brush'}`}>
            {phase === 'loading' && (
              <div className="paint-canvas-loading">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="spin">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeDasharray="6 4"/>
                </svg>
                Loading wall photo…
              </div>
            )}
            {phase === 'error' && (
              <div className="paint-canvas-loading">No wall photo found.<br/>Calibrate your wall first.</div>
            )}
            <canvas
              ref={canvasRef}
              className="paint-canvas"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={handlePointerUp}
              onClick={handleCanvasClick}
              style={{ display: phase === 'ready' ? 'block' : 'none' }}
            />
          </div>

          {/* Bottom controls */}
          {phase === 'ready' && (
            <div className="paint-bottom-bar">
              <div className="paint-detect-controls">
                <div className="paint-detect-btns">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={runAiDetect}
                    disabled={detectBtnDisabled}
                    title="Use AI to detect objects (furniture, lamps, etc.) and select just the wall"
                  >
                    {isDetecting && detectMsg.includes('AI') ? (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="btn-icon spin"><circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 2"/></svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="btn-icon"><path d="M6 1a5 5 0 110 10A5 5 0 016 1z" stroke="currentColor" strokeWidth="1.2"/><path d="M3.5 6h1m3 0h1M6 3.5v1m0 3v1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                    )}
                    AI Detect Wall
                  </button>

                  <div className="paint-sens-ctrl">
                    <span className="paint-ctrl-label">Sensitivity</span>
                    <input type="range" min={5} max={95} value={sensitivity}
                      onChange={e => setSensitivity(Number(e.target.value))}
                      className="paint-range" style={{ width: 70 }} />
                  </div>

                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={runFloodFill}
                    disabled={detectBtnDisabled}
                    title="Flood-fill from photo edges to detect uniform wall color"
                  >
                    {isDetecting && !detectMsg.includes('AI') ? (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="btn-icon spin"><circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 2"/></svg>
                    ) : null}
                    Auto-fill
                  </button>
                </div>

                {isDetecting && (
                  <span className="paint-detect-status">
                    {detectMsg}{detectPct > 0 ? ` ${detectPct}%` : ''}
                  </span>
                )}
              </div>

              <div className="paint-mask-btns">
                <button className="btn btn-ghost btn-sm" onClick={invertMask}>Invert</button>
                <button className="btn btn-ghost btn-sm" onClick={clearMask}>Clear</button>
              </div>
            </div>
          )}
        </div>

        {/* ── Right: color panel ───────────────────────────────────── */}
        <div className="paint-color-panel">
          {/* Color preview strip */}
          <div className="paint-color-preview" style={{ background: paintColor }}>
            <span className="paint-preview-hex">{paintColor}</span>
          </div>

          {/* Color tabs */}
          <div className="paint-color-tabs">
            <button className={`paint-color-tab ${colorTab==='picker'  ?'active':''}`} onClick={() => setColorTab('picker')}>Picker</button>
            <button className={`paint-color-tab ${colorTab==='palette' ?'active':''}`} onClick={() => setColorTab('palette')}>Palette</button>
            <button className={`paint-color-tab ${colorTab==='swatch'  ?'active':''}`} onClick={() => setColorTab('swatch')}>Swatch</button>
          </div>

          {/* Picker tab */}
          {colorTab === 'picker' && (
            <div className="paint-tab-content">
              <HsvPicker color={paintColor} onChange={setColor} />
              <div className="paint-hex-row">
                <span className="paint-ctrl-label">#</span>
                <input
                  type="text"
                  className="text-input paint-hex-input"
                  value={hexInput.replace('#','')}
                  onChange={e => {
                    setHexInput(e.target.value)
                    const hex = `#${e.target.value}`
                    if (/^#[0-9a-fA-F]{6}$/.test(hex)) setColor(hex)
                  }}
                  onBlur={() => setHexInput(paintColor)}
                  maxLength={6}
                  placeholder="rrggbb"
                />
              </div>
            </div>
          )}

          {/* Palette tab */}
          {colorTab === 'palette' && (
            <div className="paint-tab-content">
              <div className="paint-palette-grid">
                {PAINT_PALETTE.map(({ name, hex }) => (
                  <button
                    key={hex}
                    className={`paint-palette-swatch ${paintColor === hex ? 'active' : ''}`}
                    style={{ background: hex }}
                    title={name}
                    onClick={() => setColor(hex)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Swatch tab */}
          {colorTab === 'swatch' && (
            <div className="paint-tab-content">
              <p className="paint-swatch-hint-text">Upload a paint chip, fabric swatch, or any image. Click any pixel to sample its color.</p>
              <label className="paint-swatch-upload-btn">
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" className="btn-icon"><path d="M6.5 1.5v7M3.5 5.5l3-4 3 4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 9.5v1.5h9V9.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Upload Image
                <input type="file" accept="image/*" onChange={handleSwatchUpload} style={{ display:'none' }} />
              </label>
              {swatchImg && (
                <div className="paint-swatch-canvas-wrap" title="Click to sample a color">
                  <canvas ref={swatchDispRef} className="paint-swatch-canvas" onClick={handleSwatchClick} />
                  <span className="paint-ctrl-label" style={{ marginTop: 4 }}>Click anywhere to sample</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
