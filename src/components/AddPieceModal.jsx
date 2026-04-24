import { useState, useRef, useCallback } from 'react'
import CropModal from './CropModal'
import { BASE as API_BASE } from '../utils/api'

const PALETTE = [
  '#8B7D6B','#6B8E9F','#9E8B6A','#7B9E87','#A08080',
  '#8B9E7B','#7B8B9E','#C4A882','#9E9B7B','#8B7B9E',
  '#7B9B8B','#B5977A','#6A7F8B','#9B8A7B','#7B8B7B',
]

const blobToDataUrl = (blob) => new Promise((res, rej) => {
  const r = new FileReader()
  r.onload  = (e) => res(e.target.result)
  r.onerror = rej
  r.readAsDataURL(blob)
})

const isHeic = (file) =>
  file.type === 'image/heic' ||
  file.type === 'image/heif' ||
  /\.(heic|heif)$/i.test(file.name)

/**
 * Convert any image File to a JPEG data URL using three strategies in sequence:
 *
 * 1. createImageBitmap → Canvas  (zero dependencies; works for standard formats
 *    on all browsers, and HEIC natively on Safari 16+)
 * 2. heic2any WASM  (fallback for HEIC on Chrome/Firefox; loaded dynamically to
 *    avoid Vite pre-bundler breaking the WASM loader)
 * 3. img element → Canvas  (handles formats <img> can decode that
 *    createImageBitmap rejects, e.g. Safari HEIC native, AVIF, TIFF)
 */
async function anyImageToJpeg(file) {
  // ── Strategy 0: server-side sips conversion (dev server, macOS) ──
  // Uses the macOS native HEVC codec via `sips` — handles all HEIC variants
  // that browser-side libraries choke on.
  if (isHeic(file)) {
    try {
      const res = await fetch(`${API_BASE}/api/heic-to-jpeg`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      })
      if (res.ok) {
        const blob = await res.blob()
        return blobToDataUrl(blob)
      }
    } catch (sipsErr) {
      console.warn('[anyImageToJpeg] sips endpoint failed:', sipsErr)
      /* fall through */
    }
  }

  // ── Strategy 1: createImageBitmap → canvas ──────────
  try {
    const bitmap = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    canvas.width  = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d').drawImage(bitmap, 0, 0)
    bitmap.close()
    return canvas.toDataURL('image/jpeg', 0.93)
  } catch (_) { /* fall through */ }

  // ── Strategy 2: heic2any WASM (dynamic import avoids Vite pre-bundle) ──
  if (isHeic(file)) {
    try {
      const mod = await import('heic2any')
      // heic2any is a UMD/CJS module; the function may live on .default or be the module itself
      const heic2any = typeof mod.default === 'function' ? mod.default : mod
      const result = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.93 })
      const blob   = Array.isArray(result) ? result[0] : result
      return blobToDataUrl(blob)
    } catch (heicErr) {
      console.warn('[anyImageToJpeg] heic2any failed:', heicErr)
      /* fall through */
    }
  }

  // ── Strategy 3: img element → canvas ──
  // Catches formats that <img> can decode natively even when
  // createImageBitmap rejects them (Safari HEIC, AVIF, TIFF, etc.).
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
        res(c.toDataURL('image/jpeg', 0.93))
      }
      img.onerror = () => { URL.revokeObjectURL(objUrl); rej(new Error('img decode failed')) }
      img.src = objUrl
    })
    return jpeg
  } catch (_) { /* fall through */ }

  // ── All strategies exhausted ──
  if (isHeic(file)) {
    throw new Error(
      'Could not decode HEIC image on this browser. ' +
      'Open the photo in the Photos app, share/export it as JPEG, then try again.'
    )
  }
  // For other formats, return raw data URL and let the browser attempt it.
  return blobToDataUrl(file)
}

export default function AddPieceModal({ piece, onSubmit, onClose }) {
  const isEdit = !!piece
  const [name,   setName]   = useState(piece?.name   || '')
  const [width,  setWidth]  = useState(piece?.width  || 16)
  const [height, setHeight] = useState(piece?.height || 20)
  const [color,  setColor]  = useState(piece?.color  || PALETTE[0])
  const [image,       setImage]       = useState(piece?.image       || null)
  const [transparent, setTransparent] = useState(piece?.transparent || false)
  const [errors, setErrors] = useState({})
  const fileRef = useRef(null)

  const [converting,   setConverting]   = useState(false)
  const [convertError, setConvertError] = useState('')
  const [pendingImage, setPendingImage] = useState(null)
  const [showCrop,     setShowCrop]     = useState(false)

  const validate = () => {
    const e = {}
    if (!name.trim()) e.name = 'Name is required'
    if (!width || width <= 0)  e.width  = 'Must be > 0'
    if (!height || height <= 0) e.height = 'Must be > 0'
    return e
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    const errs = validate()
    if (Object.keys(errs).length) { setErrors(errs); return }
    onSubmit({ name: name.trim(), width: +width, height: +height, color, image, transparent })
  }

  const handleImageUpload = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''   // allow re-selecting the same file later

    setConvertError('')
    setConverting(true)

    try {
      const dataUrl = await anyImageToJpeg(file)
      setConverting(false)
      setPendingImage(dataUrl)
      setShowCrop(true)
    } catch (err) {
      console.error('Image load failed:', err)
      setConverting(false)
      setConvertError('Could not load this image. Make sure it\'s a valid photo file.')
    }
  }, [])

  return (
    <>
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2>{isEdit ? 'Edit Piece' : 'Add New Piece'}</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <form className="modal-body" onSubmit={handleSubmit}>
          {/* Name */}
          <div className="field">
            <label className="field-label">Piece Name</label>
            <input
              className={`text-input ${errors.name ? 'error' : ''}`}
              placeholder="e.g. Landscape Print, Mirror, Shelf…"
              value={name}
              onChange={e => { setName(e.target.value); setErrors(ev => ({ ...ev, name: '' })) }}
              autoFocus
            />
            {errors.name && <span className="field-error">{errors.name}</span>}
          </div>

          {/* Dimensions */}
          <div className="field field-row">
            <div className="field field-half">
              <label className="field-label">Width (inches)</label>
              <input
                type="number"
                className={`text-input ${errors.width ? 'error' : ''}`}
                value={width}
                min={1}
                max={128}
                step={0.5}
                onChange={e => { setWidth(e.target.value); setErrors(ev => ({ ...ev, width: '' })) }}
              />
              {errors.width && <span className="field-error">{errors.width}</span>}
            </div>
            <div className="field field-half">
              <label className="field-label">Height (inches)</label>
              <input
                type="number"
                className={`text-input ${errors.height ? 'error' : ''}`}
                value={height}
                min={1}
                max={95}
                step={0.5}
                onChange={e => { setHeight(e.target.value); setErrors(ev => ({ ...ev, height: '' })) }}
              />
              {errors.height && <span className="field-error">{errors.height}</span>}
            </div>
          </div>

          {/* Size preview */}
          {width > 0 && height > 0 && (
            <div className="size-preview-row">
              <span className="size-preview-label">Preview scale</span>
              <div
                className="size-preview-box"
                style={{
                  width:  Math.min(120, width  * 3),
                  height: Math.min(120, height * 3),
                  backgroundColor: color,
                  backgroundImage: image ? `url(${image})` : undefined,
                  backgroundSize: 'cover',
                }}
              />
              <span className="size-preview-dims">{width}" × {height}"</span>
            </div>
          )}

          {/* Color */}
          <div className="field">
            <label className="field-label">Color (shown when no photo)</label>
            <div className="color-grid">
              {PALETTE.map(c => (
                <button
                  key={c}
                  type="button"
                  className={`color-swatch ${color === c ? 'selected' : ''}`}
                  style={{ backgroundColor: c }}
                  onClick={() => setColor(c)}
                />
              ))}
              <input
                type="color"
                className="color-custom"
                value={color}
                onChange={e => setColor(e.target.value)}
                title="Custom color"
              />
            </div>
          </div>

          {/* Image upload */}
          <div className="field">
            <label className="field-label">Photo (optional)</label>
            <div
              className={`image-upload-area ${converting ? 'loading' : ''}`}
              onClick={() => !converting && fileRef.current?.click()}
            >
              {converting ? (
                <div className="image-placeholder">
                  <span className="upload-icon converting-spin">⏳</span>
                  <span>Converting HEIC…</span>
                  <span className="upload-sub">This only takes a moment</span>
                </div>
              ) : image ? (
                <div className="image-preview-wrap">
                  <img src={image} className="image-preview" alt="piece preview" />
                  <div className="image-actions">
                    <button
                      type="button"
                      className="image-action-btn"
                      title="Re-crop"
                      onClick={(e) => {
                        e.stopPropagation()
                        setPendingImage(image)
                        setShowCrop(true)
                      }}
                    >✂️ Crop</button>
                    <button
                      type="button"
                      className="image-action-btn image-action-remove"
                      title="Remove photo"
                      onClick={(e) => { e.stopPropagation(); setImage(null) }}
                    >✕ Remove</button>
                  </div>
                </div>
              ) : (
                <div className="image-placeholder">
                  <span className="upload-icon">📷</span>
                  <span>Click to upload a photo of this piece</span>
                  <span className="upload-sub">Supported: JPG · PNG · WEBP · HEIC</span>
                </div>
              )}
            </div>
            {convertError && <span className="field-error">{convertError}</span>}
            <input
              ref={fileRef}
              type="file"
              accept="image/*,.heic,.heif"
              style={{ display: 'none' }}
              onChange={handleImageUpload}
            />
          </div>

          {/* Actions */}
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">
              {isEdit ? 'Save Changes' : 'Add to Wall'}
            </button>
          </div>
        </form>
      </div>
    </div>

    {/* Crop modal — renders on top of this modal */}
    {showCrop && pendingImage && (
      <CropModal
        imageUrl={pendingImage}
        onApply={(croppedUrl, opts) => {
          setImage(croppedUrl)
          setTransparent(opts?.transparent ?? false)
          setPendingImage(null)
          setShowCrop(false)
        }}
        onSkip={() => {
          setImage(pendingImage)
          setTransparent(false)
          setPendingImage(null)
          setShowCrop(false)
        }}
      />
    )}
    </>
  )
}
