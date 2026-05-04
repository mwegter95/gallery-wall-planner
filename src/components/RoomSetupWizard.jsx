/**
 * RoomSetupWizard — Multi-step wizard to configure a 3D room.
 *
 * Steps:
 *  0  — Room name + physical dimensions (W × D × H)
 *  1+ — Per-face perspective crop (reuses WallSetup)
 *  final — Review & Save
 *
 * Props:
 *  onSave(room)   — called with the fully-configured room object (including
 *                   per-surface { dataUrl } for server upload)
 *  onClose()      — cancel / close wizard
 *  existingRoom   — optional Room object to edit
 *  unitSystem     — 'imperial' | 'metric'
 */
import { useState, useCallback } from 'react'
import WallSetup from './WallSetup'
import { FACES, FACE_META, createRoom, createSurface, getFaceDimsIn } from '../utils/room3d'
import { inToCmInt, cmToIn } from '../utils/units'

// Ordered face list for the wizard steps
const WIZARD_FACES = ['north', 'south', 'east', 'west', 'floor', 'ceiling']

const DEFAULT_DIMS = { roomWidth: 144, roomHeight: 96, roomDepth: 144 }

function genId() { return Math.random().toString(36).slice(2, 10) }

// ── Step 0: Room dimensions form ─────────────────────────────────────────────
function RoomDimsStep({ draft, setDraft, unitSystem, onNext, onClose }) {
  const toDisplay = v => unitSystem === 'metric' ? inToCmInt(v) : v
  const toInches  = v => unitSystem === 'metric' ? Math.round(cmToIn(Number(v))) : Number(v)

  const [name,  setName]  = useState(draft.name || '')
  const [w,     setW]     = useState(toDisplay(draft.roomWidth))
  const [h,     setH]     = useState(toDisplay(draft.roomHeight))
  const [d,     setD]     = useState(toDisplay(draft.roomDepth))
  const [err,   setErr]   = useState('')

  const unit = unitSystem === 'metric' ? 'cm' : '"'

  const handleNext = () => {
    const trimName = name.trim()
    if (!trimName) { setErr('Enter a room name'); return }
    const wIn = toInches(w), hIn = toInches(h), dIn = toInches(d)
    if (!wIn || !hIn || !dIn || wIn < 10 || hIn < 10 || dIn < 10) {
      setErr(`All dimensions must be at least 10${unit}`); return
    }
    setErr('')
    setDraft(prev => ({
      ...prev,
      name:        trimName,
      roomWidth:   wIn,
      roomHeight:  hIn,
      roomDepth:   dIn,
    }))
    onNext()
  }

  return (
    <div className="rsw-step rsw-step--dims">
      <div className="rsw-step-header">
        <span className="rsw-step-icon">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
            <rect x="2" y="2" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.4" strokeDasharray="3 2"/>
            <path d="M7 15l4-8 4 8" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
          </svg>
        </span>
        <div>
          <h2 className="rsw-title">New 3D Room</h2>
          <p className="rsw-subtitle">Enter the real-world dimensions of your room.</p>
        </div>
      </div>

      <div className="rsw-fields">
        <label className="rsw-field">
          <span>Room name</span>
          <input
            className="rsw-input"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Living Room"
            autoFocus
          />
        </label>

        <div className="rsw-dims-row">
          <label className="rsw-field">
            <span>Width ({unit})</span>
            <input
              className="rsw-input rsw-input--dim"
              type="number" min="10" max="9999"
              value={w}
              onChange={e => setW(e.target.value)}
              placeholder={unitSystem === 'metric' ? '365' : '144'}
            />
          </label>
          <label className="rsw-field">
            <span>Depth ({unit})</span>
            <input
              className="rsw-input rsw-input--dim"
              type="number" min="10" max="9999"
              value={d}
              onChange={e => setD(e.target.value)}
              placeholder={unitSystem === 'metric' ? '365' : '144'}
            />
          </label>
          <label className="rsw-field">
            <span>Height ({unit})</span>
            <input
              className="rsw-input rsw-input--dim"
              type="number" min="10" max="9999"
              value={h}
              onChange={e => setH(e.target.value)}
              placeholder={unitSystem === 'metric' ? '244' : '96'}
            />
          </label>
        </div>

        {/* Visual room diagram */}
        <div className="rsw-diagram">
          <svg viewBox="0 0 160 120" width="160" height="120">
            {/* Floor */}
            <polygon points="30,90 130,90 155,70 55,70" fill="none" stroke="#446688" strokeWidth="1"/>
            {/* Front wall */}
            <polygon points="30,30 30,90 130,90 130,30" fill="none" stroke="#5588aa" strokeWidth="1.2"/>
            {/* Top */}
            <polygon points="30,30 130,30 155,10 55,10" fill="none" stroke="#446688" strokeWidth="1"/>
            {/* Right side */}
            <polygon points="130,30 130,90 155,70 155,10" fill="none" stroke="#446688" strokeWidth="1"/>
            {/* Labels */}
            <text x="80" y="115" textAnchor="middle" fill="#7aafcc" fontSize="10">
              {unitSystem === 'metric' ? `${inToCmInt(draft.roomWidth)}cm` : `${draft.roomWidth}"`} W
            </text>
            <text x="145" y="55" textAnchor="start" fill="#7aafcc" fontSize="10">
              {unitSystem === 'metric' ? `${inToCmInt(draft.roomDepth)}cm` : `${draft.roomDepth}"`} D
            </text>
            <text x="5" y="62" textAnchor="middle" fill="#7aafcc" fontSize="10" transform="rotate(-90 5 62)">
              {unitSystem === 'metric' ? `${inToCmInt(draft.roomHeight)}cm` : `${draft.roomHeight}"`} H
            </text>
          </svg>
        </div>
      </div>

      {err && <p className="rsw-error">{err}</p>}

      <div className="rsw-footer">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={handleNext}>
          Next: Add Surface Photos →
        </button>
      </div>
    </div>
  )
}

// ── Step 1+: Face selection + photo crop ─────────────────────────────────────
function FacePickerStep({ draft, setDraft, faceIndex, setFaceIndex, unitSystem, onSave, onClose, isSaving }) {
  // Which face are we currently configuring (null = showing picker)
  const [editingFace, setEditingFace] = useState(null)

  // Summary: count how many faces have photos
  const photoCount = WIZARD_FACES.filter(f => draft.surfaces[f]?.warpedImageUrl).length

  const handleFaceApply = useCallback((faceId, dataUrl, corners, dims) => {
    setDraft(prev => {
      const surface = {
        ...createSurface(faceId),
        ...(prev.surfaces[faceId] || {}),
        warpedImageUrl: dataUrl,   // data URL — will be uploaded on save
        warpCorners:    corners,
        enabled:        true,
      }
      return { ...prev, surfaces: { ...prev.surfaces, [faceId]: surface } }
    })
    setEditingFace(null)
  }, [setDraft])

  const handleFaceClear = (faceId) => {
    setDraft(prev => ({
      ...prev,
      surfaces: {
        ...prev.surfaces,
        [faceId]: { ...createSurface(faceId), enabled: false },
      },
    }))
  }

  // If we're cropping a specific face, hand off to WallSetup
  if (editingFace) {
    const meta    = FACE_META[editingFace]
    const { widthIn, heightIn } = getFaceDimsIn(editingFace, draft)
    const existing = draft.surfaces[editingFace]?.warpedImageUrl || null
    return (
      <WallSetup
        wallName={meta.label}
        wallWidth={widthIn}
        wallHeight={heightIn}
        existingImageUrl={existing}
        unitSystem={unitSystem}
        onApply={(previewUrl, corners) => handleFaceApply(editingFace, previewUrl, corners)}
        onClose={() => setEditingFace(null)}
      />
    )
  }

  return (
    <div className="rsw-step rsw-step--faces">
      <div className="rsw-step-header">
        <span className="rsw-step-icon">📷</span>
        <div>
          <h2 className="rsw-title">{draft.name}</h2>
          <p className="rsw-subtitle">
            Add a photo for each surface. Drag the 4 corner handles to correct perspective.
            You can skip any surface and add photos later.
          </p>
        </div>
      </div>

      <div className="rsw-face-grid">
        {WIZARD_FACES.map(faceId => {
          const surface  = draft.surfaces[faceId]
          const hasPhoto = Boolean(surface?.warpedImageUrl)
          const meta     = FACE_META[faceId]
          const { widthIn, heightIn } = getFaceDimsIn(faceId, draft)
          const unitLabel = unitSystem === 'metric'
            ? `${inToCmInt(widthIn)} × ${inToCmInt(heightIn)} cm`
            : `${widthIn}" × ${heightIn}"`

          return (
            <div key={faceId} className={`rsw-face-card ${hasPhoto ? 'rsw-face-card--done' : ''}`}>
              {hasPhoto ? (
                <div
                  className="rsw-face-preview"
                  style={{ backgroundImage: `url(${surface.warpedImageUrl})` }}
                />
              ) : (
                <div className="rsw-face-placeholder">
                  <span>{meta.icon}</span>
                </div>
              )}
              <div className="rsw-face-info">
                <span className="rsw-face-label">{meta.label}</span>
                <span className="rsw-face-dims">{unitLabel}</span>
              </div>
              <div className="rsw-face-actions">
                <button
                  className="btn btn-sm btn-outline"
                  onClick={() => setEditingFace(faceId)}
                >
                  {hasPhoto ? 'Re-crop' : '+ Photo'}
                </button>
                {hasPhoto && (
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => handleFaceClear(faceId)}
                    title="Remove photo"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="rsw-footer rsw-footer--space">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <div className="rsw-footer-right">
          {photoCount > 0 && (
            <span className="rsw-photo-count">{photoCount} surface{photoCount !== 1 ? 's' : ''} ready</span>
          )}
          <button
            className="btn btn-primary"
            onClick={onSave}
            disabled={isSaving || photoCount === 0}
          >
            {isSaving
              ? <><span className="btn-spinner" /> Saving…</>
              : `Save Room${photoCount === 0 ? ' (add at least 1 photo)' : ''}`
            }
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main wizard ──────────────────────────────────────────────────────────────
export default function RoomSetupWizard({
  onSave,
  onClose,
  existingRoom    = null,
  initialRoomName = '',
  unitSystem      = 'imperial',
}) {
  const isEditing = Boolean(existingRoom)

  const [draft, setDraft] = useState(() => {
    if (existingRoom) return JSON.parse(JSON.stringify(existingRoom))
    return createRoom({ id: genId(), name: initialRoomName, ...DEFAULT_DIMS })
  })
  const [step,     setStep]     = useState(isEditing ? 1 : 0)  // skip dims step if editing
  const [faceIndex, setFaceIndex] = useState(0)
  const [isSaving,  setIsSaving]  = useState(false)
  const [saveError, setSaveError] = useState('')

  const handleSave = async () => {
    setIsSaving(true)
    setSaveError('')
    try {
      await onSave(draft)
    } catch (err) {
      setSaveError(err.message || 'Save failed')
      setIsSaving(false)
    }
  }

  return (
    <div className="rsw-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="rsw-modal">
        {/* Step indicator */}
        <div className="rsw-steps-bar">
          <div className={`rsw-step-dot ${step === 0 ? 'active' : step > 0 ? 'done' : ''}`}>1</div>
          <div className="rsw-step-line" />
          <div className={`rsw-step-dot ${step === 1 ? 'active' : ''}`}>2</div>
        </div>

        {saveError && <p className="rsw-error rsw-error--top">{saveError}</p>}

        {step === 0 ? (
          <RoomDimsStep
            draft={draft}
            setDraft={setDraft}
            unitSystem={unitSystem}
            onNext={() => setStep(1)}
            onClose={onClose}
          />
        ) : (
          <FacePickerStep
            draft={draft}
            setDraft={setDraft}
            faceIndex={faceIndex}
            setFaceIndex={setFaceIndex}
            unitSystem={unitSystem}
            onSave={handleSave}
            onClose={onClose}
            isSaving={isSaving}
          />
        )}
      </div>
    </div>
  )
}
