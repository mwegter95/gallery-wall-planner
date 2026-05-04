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
    img.onload = () => res(img)
    img.onerror = rej
    img.src = src
  })
}
function imageToImageData(img, maxPx = 1600) {
  const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale)
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h })
  c.getContext('2d').drawImage(img, 0, 0, w, h)
  return c.getContext('2d').getImageData(0, 0, w, h)
}
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
  return '#' + [rSum, gSum, bSum].map(s => Math.round(s/count).toString(16).padStart(2,'0')).join('')
}

/* ─────────────────────────────────────────────────────────────────────────
   Flood-fill from edges → selects edge-connected region (the wall).
   tolerance 0–80 controls how loosely to accept colour-similar neighbours.
   Returns Uint8ClampedArray where 255 = wall, 0 = object in front.
──────────────────────────────────────────────────────────────────────────── */
function floodFillWall(imageData, tolerance) {
  const { data, width: w, height: h } = imageData
  const n = w * h
  const isWall = new Uint8Array(n)
  const queue  = new Int32Array(n + 4)
  let qHead = 0, qTail = 0
  const enqueue = (idx) => {
    if (idx < 0 || idx >= n || isWall[idx]) return
    isWall[idx] = 1; queue[qTail++] = idx
  }
  for (let x = 0; x < w; x++) { enqueue(x); enqueue((h-1)*w+x) }
  for (let y = 1; y < h-1; y++) { enqueue(y*w); enqueue(y*w+w-1) }
  const thresh = tolerance * 2.55
  while (qHead < qTail) {
    const idx = queue[qHead++]
    const x = idx % w, y = (idx / w) | 0, i4 = idx * 4
    const r = data[i4], g = data[i4+1], b = data[i4+2]
    const tryN = (ni) => {
      if (ni < 0 || ni >= n || isWall[ni]) return
      const n4 = ni * 4, dr = data[n4]-r, dg = data[n4+1]-g, db = data[n4+2]-b
      if (Math.sqrt(dr*dr+dg*dg+db*db) <= thresh) enqueue(ni)
    }
    if (x > 0)   tryN(idx-1)
    if (x < w-1) tryN(idx+1)
    if (y > 0)   tryN(idx-w)
    if (y < h-1) tryN(idx+w)
  }
  const alpha = new Uint8ClampedArray(n)
  for (let i = 0; i < n; i++) alpha[i] = isWall[i] ? 255 : 0
  return alpha
}

/* ─────────────────────────────────────────────────────────────────────────
   HSV Color Picker
──────────────────────────────────────────────────────────────────────────── */
function HsvPicker({ color, onChange }) {
  const { h, s, v } = useMemo(() => hexToHsv(color), [color])
  const svRef  = useRef(null)
  const hueRef = useRef(null)
  const draggingSv  = useRef(false)
  const draggingHue = useRef(false)
  const pureHue = hsvToHex(h, 1, 1)

  const updateSv = useCallback((e) => {
    const rect = svRef.current?.getBoundingClientRect(); if (!rect) return
    onChange(hsvToHex(h, Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)), 1-Math.max(0,Math.min(1,(e.clientY-rect.top)/rect.height))))
  }, [h, onChange])
  const updateHue = useCallback((e) => {
    const rect = hueRef.current?.getBoundingClientRect(); if (!rect) return
    onChange(hsvToHex(Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width))*360, s, v))
  }, [s, v, onChange])

  useEffect(() => {
    const move = (e) => {
      if (draggingSv.current) updateSv(e)
      if (draggingHue.current) updateHue(e)
    }
    const up = () => { draggingSv.current = false; draggingHue.current = false }
    const tm = (e) => { if (e.touches[0]) { if (draggingSv.current) updateSv(e.touches[0]); if (draggingHue.current) updateHue(e.touches[0]) } }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    window.addEventListener('touchmove', tm, { passive: true })
    window.addEventListener('touchend', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); window.removeEventListener('touchmove', tm); window.removeEventListener('touchend', up) }
  }, [updateSv, updateHue])

  return (
    <div className="hsv-picker">
      <div ref={svRef} className="hsv-sv-box" style={{ background: pureHue }}
        onMouseDown={e => { draggingSv.current = true; updateSv(e) }}
        onTouchStart={e => { draggingSv.current = true; updateSv(e.touches[0]) }}>
        <div className="hsv-sv-white" />
        <div className="hsv-sv-black" />
        <div className="hsv-dot" style={{ left: `${s*100}%`, top: `${(1-v)*100}%`, background: color }} />
      </div>
      <div ref={hueRef} className="hsv-hue-bar"
        onMouseDown={e => { draggingHue.current = true; updateHue(e) }}
        onTouchStart={e => { draggingHue.current = true; updateHue(e.touches[0]) }}>
        <div className="hsv-hue-thumb" style={{ left: `${(h/360)*100}%` }} />
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
   AI model quality options (same as CropModal)
──────────────────────────────────────────────────────────────────────────── */
const AI_MODELS = [
  { value: 'isnet_quint8', label: 'Fast',     hint: 'Fastest — ~25 MB download' },
  { value: 'isnet_fp16',   label: 'Balanced', hint: 'Balanced — ~40 MB download' },
  { value: 'isnet',        label: 'Best',     hint: 'Best quality — ~170 MB download' },
]

/* ─────────────────────────────────────────────────────────────────────────
   PaintModal
   Phases: loading → idle → edge-computing → edge-select → detecting → ready
──────────────────────────────────────────────────────────────────────────── */
export default function PaintModal({ wallImage, initialColor, initialMask, onApply, onClose }) {
  /* ── Phase / loading ────────────────────────────────────────────────── */
  const [phase,       setPhase]       = useState('loading')
  const [loadMsg,     setLoadMsg]     = useState('')
  const [loadPct,     setLoadPct]     = useState(0)
  const [errorMsg,    setErrorMsg]    = useState('')

  /* ── Detection options ──────────────────────────────────────────────── */
  const [modelQuality,  setModelQuality]  = useState('isnet_fp16')
  const [edgeTolerance, setEdgeTolerance] = useState(35)  // 0-80, live-updates in edge-select phase
  const [aiThreshold,   setAiThreshold]   = useState(5)   // 0-10 pip track for AI sensitivity

  /* ── Color ──────────────────────────────────────────────────────────── */
  const [paintColor, setPaintColor] = useState(initialColor || '#C4875A')
  const [hexInput,   setHexInput]   = useState(initialColor || '#C4875A')
  const [colorTab,   setColorTab]   = useState('picker')

  /* ── Brush ──────────────────────────────────────────────────────────── */
  const [brushMode,   _setBrushMode]   = useState('add')   // add | erase
  const [brushRadius, _setBrushRadius] = useState(28)
  const [smartTol,    _setSmartTol]    = useState(28)       // 0-80 for smart brush
  const [brushType,   _setBrushType]   = useState('smart')  // smart | manual
  const [isSampling,  setIsSampling]   = useState(false)
  const [cursor,      setCursor]       = useState(null)
  const [isPainting,  setIsPainting]   = useState(false)

  /* ── Swatch ─────────────────────────────────────────────────────────── */
  const [swatchImg, setSwatchImg] = useState(null)

  /* ── Refs ────────────────────────────────────────────────────────────── */
  const canvasRef       = useRef(null)
  const wrapRef         = useRef(null)
  const swatchDispRef   = useRef(null)
  const origDataRef     = useRef(null)   // ImageData of wall photo
  const aiMaskRef       = useRef(null)   // ImageData of raw AI mask
  const maskRef         = useRef(null)   // Uint8ClampedArray working mask
  const isPaintingRef   = useRef(false)
  const brushModeRef    = useRef('add')
  const brushRadiusRef  = useRef(28)
  const smartTolRef     = useRef(28)
  const brushTypeRef    = useRef('smart')
  const isSamplingRef   = useRef(false)
  const colorRef        = useRef(paintColor)

  const setBrushMode   = useCallback((v) => { brushModeRef.current = v;  _setBrushMode(v)   }, [])
  const setBrushRadius = useCallback((v) => { brushRadiusRef.current = v; _setBrushRadius(v) }, [])
  const setSmartTol    = useCallback((v) => { smartTolRef.current = v;    _setSmartTol(v)    }, [])
  const setBrushType   = useCallback((v) => { brushTypeRef.current = v;   _setBrushType(v)   }, [])
  useEffect(() => { isSamplingRef.current = isSampling }, [isSampling])
  useEffect(() => { colorRef.current = paintColor }, [paintColor])

  /* ── fitCanvas: scale canvas element to fill wrap div ───────────────── */
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

  /* ── Load wall image on mount ────────────────────────────────────────── */
  useEffect(() => {
    if (!wallImage) { setPhase('error'); setErrorMsg('No wall photo — calibrate your wall first.'); return }
    setPhase('loading')
    loadImage(wallImage)
      .then(img => {
        origDataRef.current = imageToImageData(img, 1600)
        const { width: w, height: h } = origDataRef.current
        if (initialMask) {
          loadImage(initialMask)
            .then(maskImg => {
              const mc = Object.assign(document.createElement('canvas'), { width: w, height: h })
              mc.getContext('2d').drawImage(maskImg, 0, 0, w, h)
              const md = mc.getContext('2d').getImageData(0, 0, w, h)
              const alpha = new Uint8ClampedArray(w * h)
              for (let i = 0; i < w * h; i++) alpha[i] = md.data[i * 4]
              maskRef.current = alpha
              // Pre-loaded mask — go straight to brush
              if (canvasRef.current) { canvasRef.current.width = w; canvasRef.current.height = h }
              renderCanvas()
              setPhase('ready')
            })
            .catch(() => {
              maskRef.current = new Uint8ClampedArray(w * h)
              setPhase('idle')
            })
        } else {
          maskRef.current = new Uint8ClampedArray(w * h)
          setPhase('idle')
        }
      })
      .catch(() => { setPhase('error'); setErrorMsg('Failed to load wall photo.') })
  }, [wallImage]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Canvas render — tinted paint preview ───────────────────────────── */
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current, orig = origDataRef.current, mask = maskRef.current
    if (!canvas || !orig || !mask) return
    const { width: w, height: h } = orig
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.putImageData(orig, 0, 0)
    const { r: pr, g: pg, b: pb } = hexToRgb(colorRef.current)
    const out = ctx.getImageData(0, 0, w, h)
    const od = out.data
    for (let i = 0; i < w * h; i++) {
      const a = mask[i]; if (a === 0) continue
      const i4 = i * 4, strength = (a / 255) * 0.72
      const lum = (0.299 * od[i4] + 0.587 * od[i4+1] + 0.114 * od[i4+2]) / 255
      od[i4]   = Math.round(od[i4]   * (1 - strength) + pr * lum * 2 * strength)
      od[i4+1] = Math.round(od[i4+1] * (1 - strength) + pg * lum * 2 * strength)
      od[i4+2] = Math.round(od[i4+2] * (1 - strength) + pb * lum * 2 * strength)
    }
    ctx.putImageData(out, 0, 0)
    // Edge highlight
    const edgeOut = ctx.getImageData(0, 0, w, h); const ed = edgeOut.data
    for (let y = 1; y < h-1; y++) {
      for (let x = 1; x < w-1; x++) {
        const idx = y*w+x, m = mask[idx] > 128
        if (m !== (mask[(y-1)*w+x]>128) || m !== (mask[(y+1)*w+x]>128) ||
            m !== (mask[y*w+x-1]>128)   || m !== (mask[y*w+x+1]>128)) {
          const i4 = idx*4; ed[i4]=80; ed[i4+1]=160; ed[i4+2]=255; ed[i4+3]=200
        }
      }
    }
    ctx.putImageData(edgeOut, 0, 0)
    requestAnimationFrame(fitCanvas)
  }, [fitCanvas])

  // Re-render when color changes in ready/edge-select phases
  useEffect(() => {
    if (phase === 'ready' || phase === 'edge-select') renderCanvas()
  }, [paintColor, phase, renderCanvas])

  /* ── Live tolerance update in edge-select phase ─────────────────────── */
  useEffect(() => {
    if (phase !== 'edge-select' || !origDataRef.current) return
    maskRef.current = floodFillWall(origDataRef.current, edgeTolerance)
    renderCanvas()
  }, [edgeTolerance, phase, renderCanvas])

  /* ── Live AI threshold update in ready phase (when AI mask exists) ──── */
  useEffect(() => {
    if (phase !== 'ready' || !aiMaskRef.current || !origDataRef.current) return
    const orig = origDataRef.current, aiMask = aiMaskRef.current
    const n = orig.width * orig.height
    const FEATHER = 18
    // thresh maps 0-10 → tight-to-loose (high thresh = tight = only very white pixels)
    const thresh = Math.round((10 - aiThreshold) / 10 * 210 + 20)  // 230 → 20
    const alpha = new Uint8ClampedArray(n)
    for (let i = 0; i < n; i++) {
      const mv = aiMask.data[i * 4]
      // AI mask: 255 = objects (invert for wall), so we work on 255-mv
      const wallV = 255 - mv
      alpha[i] = wallV < thresh - FEATHER ? 0
               : wallV > thresh + FEATHER ? 255
               : Math.round((wallV - (thresh - FEATHER)) / (FEATHER * 2) * 255)
    }
    maskRef.current = alpha
    renderCanvas()
  }, [aiThreshold, phase, renderCanvas])

  /* ── Run edge flood fill → enter edge-select phase ───────────────────── */
  const runEdgeSelect = useCallback(async () => {
    const orig = origDataRef.current; if (!orig) return
    setPhase('edge-computing')
    await new Promise(r => setTimeout(r, 30))  // let spinner render
    const { width: w, height: h } = orig
    maskRef.current = floodFillWall(orig, edgeTolerance)
    if (canvasRef.current) { canvasRef.current.width = w; canvasRef.current.height = h }
    renderCanvas()
    setPhase('edge-select')
  }, [edgeTolerance, renderCanvas])

  /* ── Run AI detection → enter ready phase ───────────────────────────── */
  const runAiDetect = useCallback(async () => {
    const orig = origDataRef.current; if (!orig) return
    setPhase('detecting'); setLoadMsg('Loading AI model…'); setLoadPct(0)
    try {
      const { removeBackground } = await import('@imgly/background-removal')
      // Re-encode origData to blob to avoid any CORS fetch issues
      const { width: w, height: h } = orig
      const mc = Object.assign(document.createElement('canvas'), { width: w, height: h })
      mc.getContext('2d').putImageData(orig, 0, 0)
      const blob = await new Promise(r => mc.toBlob(r, 'image/jpeg', 0.93))

      setLoadMsg('Detecting objects…')
      // Background-removal: white = foreground objects (furniture), black = wall background
      const maskBlob = await removeBackground(blob, {
        model: modelQuality,
        output: { type: 'mask', format: 'image/png' },
        progress: (key, cur, total) => {
          if (total > 0) {
            setLoadPct(Math.round(cur / total * 100))
            if (key.includes('fetch') || key.includes('download')) setLoadMsg('Downloading model…')
            else if (key.includes('run')) setLoadMsg('Analysing scene…')
          }
        },
      })
      setLoadMsg('Applying…')
      const maskObjUrl = URL.createObjectURL(maskBlob)
      const maskImg = await loadImage(maskObjUrl)
      URL.revokeObjectURL(maskObjUrl)
      const maskCanvas = Object.assign(document.createElement('canvas'), { width: w, height: h })
      maskCanvas.getContext('2d').drawImage(maskImg, 0, 0, w, h)
      // Store raw AI mask (white = objects) so threshold slider can re-derive mask
      aiMaskRef.current = maskCanvas.getContext('2d').getImageData(0, 0, w, h)
      // Apply initial threshold
      const FEATHER = 18
      const thresh = Math.round((10 - aiThreshold) / 10 * 210 + 20)
      const alpha = new Uint8ClampedArray(w * h)
      for (let i = 0; i < w * h; i++) {
        const wallV = 255 - aiMaskRef.current.data[i * 4]
        alpha[i] = wallV < thresh - FEATHER ? 0
                 : wallV > thresh + FEATHER ? 255
                 : Math.round((wallV - (thresh - FEATHER)) / (FEATHER * 2) * 255)
      }
      maskRef.current = alpha
      if (canvasRef.current) { canvasRef.current.width = w; canvasRef.current.height = h }
      renderCanvas()
      setPhase('ready')
    } catch (err) {
      console.error('AI detect failed:', err)
      setErrorMsg(`AI detection failed: ${err.message || err}`)
      setPhase('idle')
    } finally {
      setLoadMsg(''); setLoadPct(0)
    }
  }, [modelQuality, aiThreshold, renderCanvas])

  /* ── Advance edge-select → brush phase ──────────────────────────────── */
  const goToBrush = useCallback(() => setPhase('ready'), [])

  /* ── Brush painting ──────────────────────────────────────────────────── */
  const paintManual = useCallback((cssX, cssY) => {
    const canvas = canvasRef.current, orig = origDataRef.current, mask = maskRef.current
    if (!canvas || !orig || !mask) return
    const { width: iw, height: ih } = orig
    const rect = canvas.getBoundingClientRect()
    const ix = cssX * (iw / rect.width), iy = cssY * (ih / rect.height)
    const ir = brushRadiusRef.current * Math.max(iw / rect.width, ih / rect.height)
    const x0 = Math.max(0,Math.floor(ix-ir)), x1 = Math.min(iw-1,Math.ceil(ix+ir))
    const y0 = Math.max(0,Math.floor(iy-ir)), y1 = Math.min(ih-1,Math.ceil(iy+ir))
    const adding = brushModeRef.current === 'add'
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dist = Math.sqrt((x-ix)**2+(y-iy)**2); if (dist > ir) continue
        const str = dist <= ir*0.65 ? 1 : (ir-dist)/(ir*0.35)
        const delta = Math.round(str*255), idx = y*iw+x
        mask[idx] = adding ? Math.min(255,mask[idx]+delta) : Math.max(0,mask[idx]-delta)
      }
    }
    renderCanvas()
  }, [renderCanvas])

  const paintSmart = useCallback((cssX, cssY) => {
    const canvas = canvasRef.current, orig = origDataRef.current, mask = maskRef.current
    if (!canvas || !orig || !mask) return
    const { width: iw, height: ih } = orig
    const rect = canvas.getBoundingClientRect()
    const scaleX = iw / rect.width, scaleY = ih / rect.height
    const ix = Math.round(cssX * scaleX), iy = Math.round(cssY * scaleY)
    if (ix < 0 || ix >= iw || iy < 0 || iy >= ih) return
    const ir = brushRadiusRef.current * Math.max(scaleX, scaleY), ir2 = ir*ir
    const thr = smartTolRef.current * 3.0
    const adding = brushModeRef.current === 'add'
    const si = (iy*iw+ix)*4
    const sr = orig.data[si], sg = orig.data[si+1], sb = orig.data[si+2]
    const visited = new Uint8Array(iw*ih), queue = new Int32Array(iw*ih)
    let qHead = 0, qTail = 0
    const enq = (x, y) => {
      if (x<0||x>=iw||y<0||y>=ih) return
      const idx = y*iw+x; if (visited[idx]) return
      const dx = x-ix, dy = y-iy; if (dx*dx+dy*dy > ir2) return
      const p = idx*4, dr = orig.data[p]-sr, dg = orig.data[p+1]-sg, db = orig.data[p+2]-sb
      if (Math.sqrt(dr*dr+dg*dg+db*db) > thr) return
      visited[idx]=1; queue[qTail++]=idx
    }
    enq(ix, iy)
    while (qHead < qTail) {
      const idx = queue[qHead++]
      mask[idx] = adding ? 255 : 0
      const x = idx%iw, y = (idx/iw)|0
      enq(x-1,y); enq(x+1,y); enq(x,y-1); enq(x,y+1)
    }
    renderCanvas()
  }, [renderCanvas])

  const doPaint = useCallback((cssX, cssY) => {
    if (brushTypeRef.current === 'smart') paintSmart(cssX, cssY)
    else paintManual(cssX, cssY)
  }, [paintSmart, paintManual])

  /* ── Pointer / touch handlers ────────────────────────────────────────── */
  const getXY = (e) => {
    const cr = canvasRef.current?.getBoundingClientRect()
    return cr ? { x: e.clientX - cr.left, y: e.clientY - cr.top } : null
  }

  const onPointerDown = useCallback((e) => {
    if (e.button !== 0 || isSamplingRef.current) return
    isPaintingRef.current = true; setIsPainting(true)
    const pos = getXY(e); if (pos) doPaint(pos.x, pos.y)
  }, [doPaint]) // eslint-disable-line react-hooks/exhaustive-deps
  const onPointerMove = useCallback((e) => {
    const pos = getXY(e); if (!pos) return
    setCursor({ x: e.clientX - (wrapRef.current?.getBoundingClientRect().left || 0), y: e.clientY - (wrapRef.current?.getBoundingClientRect().top || 0) })
    if (isPaintingRef.current) doPaint(pos.x, pos.y)
  }, [doPaint]) // eslint-disable-line react-hooks/exhaustive-deps
  const onPointerUp = useCallback(() => { isPaintingRef.current = false; setIsPainting(false) }, [])

  const handleCanvasClick = useCallback((e) => {
    if (!isSamplingRef.current) return
    const orig = origDataRef.current; if (!orig) return
    const rect = canvasRef.current?.getBoundingClientRect(); if (!rect) return
    const px = Math.round((e.clientX-rect.left)*(orig.width/rect.width))
    const py = Math.round((e.clientY-rect.top)*(orig.height/rect.height))
    const hex = sampleColor(orig, px, py, 8)
    setColor(hex); setIsSampling(false)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const c = canvasRef.current; if (!c) return
    const opts = { passive: false }
    const ots = (e) => { e.preventDefault(); isPaintingRef.current=true; setIsPainting(true); const t=e.touches[0]; const cr=c.getBoundingClientRect(); doPaint(t.clientX-cr.left,t.clientY-cr.top) }
    const otm = (e) => { e.preventDefault(); if(!isPaintingRef.current||!e.touches[0])return; const t=e.touches[0]; const cr=c.getBoundingClientRect(); doPaint(t.clientX-cr.left,t.clientY-cr.top) }
    const ote = () => { isPaintingRef.current=false; setIsPainting(false) }
    c.addEventListener('touchstart',ots,opts)
    c.addEventListener('touchmove',otm,opts)
    c.addEventListener('touchend',ote)
    return () => { c.removeEventListener('touchstart',ots); c.removeEventListener('touchmove',otm); c.removeEventListener('touchend',ote) }
  }, [doPaint])

  /* ── Mask ops ────────────────────────────────────────────────────────── */
  const clearMask = useCallback(() => {
    const orig = origDataRef.current; if (!orig) return
    aiMaskRef.current = null   // also clear AI mask so threshold resets
    maskRef.current = new Uint8ClampedArray(orig.width * orig.height)
    renderCanvas()
  }, [renderCanvas])
  const invertMask = useCallback(() => {
    const mask = maskRef.current; if (!mask) return
    for (let i = 0; i < mask.length; i++) mask[i] = 255 - mask[i]
    renderCanvas()
  }, [renderCanvas])

  /* ── Swatch upload ───────────────────────────────────────────────────── */
  const handleSwatchUpload = useCallback((e) => {
    const file = e.target.files?.[0]; if (!file) return
    const url = URL.createObjectURL(file)
    loadImage(url).then(img => {
      const scale = Math.min(1, 300/Math.max(img.naturalWidth,img.naturalHeight))
      const w = Math.round(img.naturalWidth*scale), h = Math.round(img.naturalHeight*scale)
      const c = Object.assign(document.createElement('canvas'),{width:w,height:h})
      c.getContext('2d').drawImage(img,0,0,w,h)
      const id = c.getContext('2d').getImageData(0,0,w,h)
      setSwatchImg({imageData:id,w,h})
      URL.revokeObjectURL(url)
      setTimeout(() => { const dc=swatchDispRef.current; if(!dc)return; dc.width=w; dc.height=h; dc.getContext('2d').putImageData(id,0,0) }, 0)
    })
    e.target.value = ''
  }, [])
  const handleSwatchClick = useCallback((e) => {
    const si = swatchImg; if (!si) return
    const dc = swatchDispRef.current; if (!dc) return
    const rect = dc.getBoundingClientRect()
    const px = Math.round((e.clientX-rect.left)*(si.w/rect.width))
    const py = Math.round((e.clientY-rect.top)*(si.h/rect.height))
    setColor(sampleColor(si.imageData,px,py,6))
  }, [swatchImg]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Color helpers ───────────────────────────────────────────────────── */
  const setColor = useCallback((hex) => {
    const h = hex.startsWith('#') ? hex : `#${hex}`
    if (/^#[0-9a-fA-F]{6}$/.test(h)) { const lc = h.toLowerCase(); setPaintColor(lc); setHexInput(lc) }
  }, [])

  /* ── Export mask + apply ─────────────────────────────────────────────── */
  const handleApply = useCallback(() => {
    const orig = origDataRef.current, mask = maskRef.current
    if (!orig || !mask) { onApply(paintColor, null); return }
    const { width: w, height: h } = orig
    const mc = Object.assign(document.createElement('canvas'),{width:w,height:h})
    const ctx = mc.getContext('2d'), id = ctx.createImageData(w, h)
    for (let i = 0; i < w*h; i++) { id.data[i*4]=id.data[i*4+1]=id.data[i*4+2]=mask[i]; id.data[i*4+3]=255 }
    ctx.putImageData(id, 0, 0)
    onApply(paintColor, mc.toDataURL('image/png'))
  }, [paintColor, onApply])

  /* ── Escape ──────────────────────────────────────────────────────────── */
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])

  /* ── Derived ─────────────────────────────────────────────────────────── */
  const isCanvasPhase = phase === 'edge-select' || phase === 'ready'
  const tolLabel = edgeTolerance < 20 ? 'Tight' : edgeTolerance > 55 ? 'Loose' : 'Balanced'

  /* ── Render ──────────────────────────────────────────────────────────── */
  return (
    <div className="paint-modal-fullscreen" role="dialog" aria-modal="true">

      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="paint-header">
        <div className="paint-header-left">
          <span className="paint-header-title">Paint Wall</span>
          {isCanvasPhase && (
            <>
              <div className="paint-tool-group">
                <button className={`paint-tool-btn ${brushType==='smart'&&!isSampling?'active':''}`}
                  onClick={() => { setBrushType('smart'); setIsSampling(false) }} title="Smart brush — traces colour edges">
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 10.5C3 9.5 4 8 6 7L9.5 3.5l-.5-.5L5 7C3.5 8 2.5 9.5 2 11z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="currentColor" fillOpacity="0.2"/><circle cx="9.5" cy="3.5" r="1.5" stroke="currentColor" strokeWidth="1.2"/></svg>
                  Smart
                </button>
                <button className={`paint-tool-btn ${brushType==='manual'&&!isSampling?'active':''}`}
                  onClick={() => { setBrushType('manual'); setIsSampling(false) }} title="Manual soft brush">
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M9 2.5l1.5 1.5-7 7H2v-1.5l7-7z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
                  Manual
                </button>
                <button className={`paint-tool-btn ${brushMode==='add'?'active':''}`} onClick={() => setBrushMode('add')}>＋ Add</button>
                <button className={`paint-tool-btn ${brushMode==='erase'?'active':''}`} onClick={() => setBrushMode('erase')}>✕ Erase</button>
              </div>
              <button className={`paint-tool-btn ${isSampling?'active':''}`}
                style={{ border:'1px solid var(--border)', borderRadius:6 }}
                onClick={() => setIsSampling(s => !s)} title="Sample color from photo">
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M8.5 2l2.5 2.5-5.5 5.5L3.5 9l-.5-1.5L8.5 2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><path d="M2 11l1.5-1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                Pick Color
              </button>
              <div className="paint-brush-size">
                <span className="paint-ctrl-label">Size</span>
                <input type="range" min={5} max={100} value={brushRadius}
                  onChange={e => setBrushRadius(Number(e.target.value))} className="paint-range" style={{width:70}} />
                <span className="paint-ctrl-label">{brushRadius}px</span>
              </div>
              {brushType === 'smart' && (
                <div className="paint-brush-size">
                  <span className="paint-ctrl-label">Sensitivity</span>
                  <input type="range" min={0} max={80} value={smartTol}
                    onChange={e => setSmartTol(Number(e.target.value))} className="paint-range" style={{width:70}} />
                  <span className="paint-ctrl-label">{smartTol < 20 ? 'Precise' : smartTol > 55 ? 'Loose' : 'Balanced'}</span>
                </div>
              )}
            </>
          )}
        </div>
        <div className="paint-header-right">
          {isCanvasPhase && (
            <>
              <button className="btn btn-ghost btn-sm" onClick={invertMask}>Invert</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { clearMask(); setPhase('idle') }}>Reset</button>
            </>
          )}
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={handleApply} disabled={phase==='loading'||phase==='detecting'||phase==='edge-computing'}>
            Apply Paint
          </button>
        </div>
      </div>

      {/* ── Body ──────────────────────────────────────────────────────── */}
      <div className="paint-body">

        {/* ── Left: canvas / idle / loading ─────────────────────────── */}
        <div className="paint-canvas-panel">

          {/* LOADING */}
          {phase === 'loading' && (
            <div className="paint-canvas-wrap"><div className="paint-canvas-loading">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="spin"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeDasharray="6 4"/></svg>
              Loading wall photo…
            </div></div>
          )}

          {/* ERROR */}
          {phase === 'error' && (
            <div className="paint-canvas-wrap"><div className="paint-canvas-loading">{errorMsg}</div></div>
          )}

          {/* IDLE — choose method */}
          {phase === 'idle' && (
            <div className="paint-canvas-wrap">
              <div className="paint-idle">
                <div className="paint-idle-icon">
                  <svg width="40" height="40" viewBox="0 0 40 40" fill="none"><path d="M6 34c2-3 5-7 11-10L28 12l-2-2L15 21C9 24 7 28 6 34z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="currentColor" fillOpacity="0.15"/><circle cx="28" cy="12" r="4" stroke="currentColor" strokeWidth="1.5"/></svg>
                </div>
                <h3 className="paint-idle-title">Select the wall area</h3>
                <p className="paint-idle-sub">Choose how to select which parts of the photo get painted.</p>

                {errorMsg && <p className="paint-idle-error">{errorMsg}</p>}

                {/* Edge select option */}
                <div className="paint-idle-option">
                  <div className="paint-idle-option-header">
                    <span className="paint-idle-option-title">⚡ Edge Select</span>
                    <span className="paint-idle-option-hint">Instant — works best for uniform walls</span>
                  </div>
                  <div className="paint-idle-option-controls">
                    <span className="ms-ctrl-label">Looseness</span>
                    <input type="range" min={0} max={80} value={edgeTolerance}
                      onChange={e => setEdgeTolerance(Number(e.target.value))}
                      className="paint-range" style={{flex:1,minWidth:80}} />
                    <span className="ms-ctrl-val">{tolLabel}</span>
                  </div>
                  <button className="btn btn-primary paint-idle-btn" onClick={runEdgeSelect}>
                    ⚡ Edge Select
                  </button>
                </div>

                <div className="paint-idle-divider"><span>or use AI</span></div>

                {/* AI option */}
                <div className="paint-idle-option">
                  <div className="paint-idle-option-header">
                    <span className="paint-idle-option-title">✨ AI Detect</span>
                    <span className="paint-idle-option-hint">Detects furniture & objects — paints the rest</span>
                  </div>
                  <div className="paint-idle-option-controls">
                    <span className="ms-ctrl-label">Quality</span>
                    {AI_MODELS.map(({value, label, hint}) => (
                      <button key={value}
                        className={`ms-mode-btn ${modelQuality === value ? 'ms-mode-add' : ''}`}
                        onClick={() => setModelQuality(value)}
                        title={hint}
                      >{label}</button>
                    ))}
                  </div>
                  <button className="btn btn-ghost paint-idle-btn" onClick={runAiDetect}>
                    ✨ AI Detect Wall
                  </button>
                </div>

                <button className="paint-idle-skip" onClick={() => setPhase('ready')}>
                  Skip — go straight to brush
                </button>
              </div>
            </div>
          )}

          {/* COMPUTING */}
          {(phase === 'edge-computing') && (
            <div className="paint-canvas-wrap"><div className="paint-canvas-loading">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="spin"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeDasharray="6 4"/></svg>
              Computing edge selection…
            </div></div>
          )}

          {/* DETECTING (AI) */}
          {phase === 'detecting' && (
            <div className="paint-canvas-wrap"><div className="paint-canvas-loading">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="spin"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeDasharray="6 4"/></svg>
              <span>{loadMsg}</span>
              {loadPct > 0 && (
                <div className="ms-load-bar" style={{width:200}}>
                  <div className="ms-load-fill" style={{width:`${loadPct}%`}} />
                </div>
              )}
              {loadPct > 0 && <span className="paint-ctrl-label">{loadPct}%</span>}
            </div></div>
          )}

          {/* CANVAS (edge-select + brush) */}
          {isCanvasPhase && (
            <div
              ref={wrapRef}
              className={`paint-canvas-wrap ${isSampling?'cursor-eyedropper':brushMode==='erase'?'cursor-erase':'cursor-brush'}`}
              style={{ cursor: isCanvasPhase && !isSampling ? 'none' : undefined }}
              onMouseDown={onPointerDown}
              onMouseMove={onPointerMove}
              onMouseUp={onPointerUp}
              onMouseLeave={() => { isPaintingRef.current=false; setIsPainting(false); setCursor(null) }}
              onClick={handleCanvasClick}
            >
              <canvas ref={canvasRef} className="paint-canvas" />
              {cursor && !isSampling && (
                <div className="ms-brush-cursor" style={{
                  left: cursor.x, top: cursor.y,
                  width: brushRadius*2, height: brushRadius*2,
                  borderColor: brushMode==='add' ? '#4ade80' : '#f87171',
                  opacity: isPainting ? 0.5 : 0.85,
                }} />
              )}
            </div>
          )}

          {/* Bottom bar */}
          {phase === 'edge-select' && (
            <div className="paint-bottom-bar">
              <div className="paint-detect-controls">
                <span className="ms-ctrl-label" title="How loosely the fill grows from the photo borders">Looseness</span>
                <input type="range" min={0} max={80} value={edgeTolerance}
                  onChange={e => setEdgeTolerance(Number(e.target.value))}
                  className="paint-range" style={{width:100}} />
                <span className="ms-ctrl-val">{tolLabel}</span>
              </div>
              <button className="btn btn-primary btn-sm" onClick={goToBrush}>
                Refine with Brush →
              </button>
            </div>
          )}

          {phase === 'ready' && aiMaskRef.current && (
            <div className="paint-bottom-bar">
              <span className="ms-ctrl-label ms-ctrl-label--highlight" title="Adjusting recomputes mask from AI result. Higher = more of the wall included.">AI Threshold</span>
              <div className="ms-sens-track">
                {Array.from({length:11},(_,i) => (
                  <div key={i} className={`ms-sens-pip ${i<=aiThreshold?'active':''}`}
                    onClick={() => setAiThreshold(i)} />
                ))}
              </div>
              <span className="ms-ctrl-val">{aiThreshold<4?'Tight':aiThreshold>7?'Loose':'Balanced'}</span>
            </div>
          )}
        </div>

        {/* ── Right: color panel ──────────────────────────────────── */}
        <div className="paint-color-panel">
          <div className="paint-color-preview" style={{ background: paintColor }}>
            <span className="paint-preview-hex">{paintColor}</span>
          </div>

          <div className="paint-color-tabs">
            <button className={`paint-color-tab ${colorTab==='picker'?'active':''}`}  onClick={() => setColorTab('picker')}>Picker</button>
            <button className={`paint-color-tab ${colorTab==='palette'?'active':''}`} onClick={() => setColorTab('palette')}>Palette</button>
            <button className={`paint-color-tab ${colorTab==='swatch'?'active':''}`}  onClick={() => setColorTab('swatch')}>Swatch</button>
          </div>

          {colorTab === 'picker' && (
            <div className="paint-tab-content">
              <HsvPicker color={paintColor} onChange={setColor} />
              <div className="paint-hex-row">
                <span className="paint-ctrl-label">#</span>
                <input type="text" className="text-input paint-hex-input"
                  value={hexInput.replace('#','')}
                  onChange={e => { setHexInput(e.target.value); const h=`#${e.target.value}`; if(/^#[0-9a-fA-F]{6}$/.test(h)) setColor(h) }}
                  onBlur={() => setHexInput(paintColor)}
                  maxLength={6} placeholder="rrggbb" />
              </div>
            </div>
          )}

          {colorTab === 'palette' && (
            <div className="paint-tab-content">
              <div className="paint-palette-grid">
                {PAINT_PALETTE.map(({name,hex}) => (
                  <button key={hex} className={`paint-palette-swatch ${paintColor===hex?'active':''}`}
                    style={{background:hex}} title={name} onClick={() => setColor(hex)} />
                ))}
              </div>
            </div>
          )}

          {colorTab === 'swatch' && (
            <div className="paint-tab-content">
              <p className="paint-swatch-hint-text">Upload a paint chip, fabric, or any image. Click any pixel to sample its color.</p>
              <label className="paint-swatch-upload-btn">
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" className="btn-icon"><path d="M6.5 1.5v7M3.5 5.5l3-4 3 4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 9.5v1.5h9V9.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Upload Image
                <input type="file" accept="image/*" onChange={handleSwatchUpload} style={{display:'none'}} />
              </label>
              {swatchImg && (
                <div className="paint-swatch-canvas-wrap">
                  <canvas ref={swatchDispRef} className="paint-swatch-canvas" onClick={handleSwatchClick} />
                  <span className="paint-ctrl-label" style={{marginTop:4}}>Click to sample a color</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
