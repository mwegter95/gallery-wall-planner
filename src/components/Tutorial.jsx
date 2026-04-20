import { useState, useEffect } from 'react'

/* ═══════════════════════════════════════════════════════════════════
   TUTORIAL + TIPS SYSTEM
   ═══════════════════════════════════════════════════════════════════
   Tutorial:  step-by-step guided tour with spotlight highlight
   Tips:      contextual, non-blocking just-in-time suggestions
   ═══════════════════════════════════════════════════════════════════ */

// Placeholder art image for the demo overlay (Wikimedia public-domain painting)
const DEMO_ART_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ea/Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg/1280px-Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg'

// ── Step definitions ──────────────────────────────────────────────
const STEPS = [
  {
    id: 'welcome',
    target: null,
    title: '👋 Welcome to Gallery Wall Planner',
    desc: 'Plan your perfect gallery wall before putting a single nail in. Calibrate your wall with a photo, add your art pieces, drag them to true scale — then hang with confidence.',
    pos: 'center',
  },
  {
    id: 'account',
    target: '[data-tutorial="header-login"]',
    title: '☁ Save Your Work Across Devices',
    desc: 'Creating an account syncs your walls and layouts to any device — phone, tablet, or desktop. Passwords are hashed and photo uploads are encrypted. Your data stays private.',
    mDesc: 'Tap the profile icon (top-right) to log in. This syncs your walls and layouts securely across all your devices.',
    pos: 'bottom',
  },
  {
    id: 'wall-select',
    target: '[data-tutorial="header-wall-badge"]',
    title: '🏠 Create & Switch Walls',
    desc: 'Click the wall name to open Wall Manager. Create walls for different rooms, switch between them, rename or delete them. Each wall has its own calibrated photo and set of saved layouts.',
    mDesc: 'Tap the wall name to open Wall Manager — create new rooms, switch between them, and each gets its own layouts.',
    pos: 'bottom',
  },
  {
    id: 'calibrate',
    target: '[data-tutorial="header-calibrate"]',
    title: '📐 Calibrate Your Wall',
    desc: 'Click "Calibrate Wall" to upload a straight-on photo of your wall. In the next step you\'ll drag four colored corner handles to the exact wall boundary, then enter the wall\'s width and height in inches. The app corrects the perspective so all pieces display at true real-world scale.',
    mDesc: 'Tap "Calibrate Wall" to upload a photo. Drag the colored dots to match the wall corners, then enter the wall width × height in inches.',
    pos: 'bottom',
  },
  {
    id: 'add-piece',
    target: '[data-tutorial="header-add-piece"]',
    title: '+ Add a Piece of Art',
    desc: 'Click "+ Add Piece" to add art to your wall. Give it a name, enter its real-world width and height in inches, and pick a color — or upload a photo of the actual artwork for a realistic preview.',
    mDesc: 'Tap + to add a piece. Set its name, real-world size in inches, choose a color, or upload a photo.',
    pos: 'bottom',
  },
  {
    id: 'piece-photo',
    target: '[data-tutorial="header-add-piece"]',
    title: '🎨 Piece Photo Editing Tools',
    desc: 'When you upload an art photo, powerful tools help you isolate the piece:\n\n**4-Corner Warp** — drag corners to straighten photos taken at an angle\n**Magic Select** — AI detects and removes the background automatically\n**Manual Brush** — paint to keep (Add mode) or erase (Erase mode) for fine detail\n**Sliders** — adjust brightness, contrast, saturation to match the real piece',
    mDesc: 'After uploading a photo:\n\n**4-Corner Warp** for angled shots\n**Magic Select** for auto background removal\n**Manual Brush** — Add or Erase mode for fine control\n**Sliders** to fine-tune the look',
    pos: 'bottom',
    showDemo: true,   // trigger the demo overlay when modal isn't open
  },
  {
    id: 'drag',
    target: '[data-tutorial="wall-area"]',
    title: '✋ Drag Pieces to Arrange',
    desc: 'Click and drag any piece to position it on the wall. The wall is rendered at true scale based on your calibrated dimensions — the spacing you see is the spacing you\'ll get.\n\nClick a piece to select it. Click the empty wall background to deselect.',
    mDesc: 'Touch and drag pieces to arrange them. The wall is true scale! Tap a piece to select it, tap empty wall to deselect.',
    pos: 'center',
  },
  {
    id: 'save-layout',
    target: '[data-tutorial="header-save"]',
    title: '💾 Save Your Layout',
    desc: 'Click "Save Layout" and give the current arrangement a name. Save multiple layouts per wall to compare ideas — "Option A", "Symmetrical", "Gallery Style". Load and switch between them anytime.',
    mDesc: 'Tap Save Layout to save this arrangement with a name. Create multiple versions to compare ideas.',
    pos: 'bottom',
  },
  {
    id: 'sidebar',
    target: '[data-tutorial="sidebar-toggle"]',
    title: '☰ The Sidebar',
    desc: 'Open the sidebar for deeper controls:\n\n**Pieces** — reorder layers, edit individual pieces, delete them\n**Snap to Grid** — enable snapping with a grid interval for precise placement\n**Layouts** — load, rename, or delete saved arrangements\n**Library** — pieces you\'ve added are saved here so you can reuse them across layouts without re-uploading',
    mDesc: 'Tap ☰ to open the sidebar:\n\n**Pieces** — edit, reorder, delete\n**Snap to Grid** — for precise alignment\n**Layouts** — load saved arrangements\n**Library** — reuse previously added art',
    pos: 'bottom',
  },
  {
    id: 'multiple-walls',
    target: '[data-tutorial="header-wall-badge"]',
    title: '🏠 Multiple Rooms',
    desc: 'You\'re not limited to one wall. Click the wall name to add walls for different rooms — bedroom, living room, hallway, office. Each room gets its own calibrated photo and set of saved layouts. Switch between rooms anytime.',
    mDesc: 'Tap the wall name to manage multiple rooms. Each gets its own photo and layouts. Switch between them freely.',
    pos: 'bottom',
  },
  {
    id: 'grid',
    target: '[data-tutorial="ctrl-grid"]',
    title: '⊞ Grid & Snap to Grid',
    desc: 'Click "Grid" to overlay measurement lines (inches and feet) across your wall — great for checking even spacing between pieces.\n\nFor Snap to Grid, open the sidebar (☰) and enable it there. Pieces snap to a grid interval you choose (e.g. 2″, 4″, 6″) for precise, even placement.',
    mDesc: 'Tap Grid to show measurement lines. To snap pieces to a grid, open the sidebar (☰) and enable Snap to Grid.',
    pos: 'bottom',
  },
  {
    id: 'lock',
    target: '[data-tutorial="ctrl-lock"]',
    title: '🔒 Lock Pieces in Place',
    desc: 'Select any piece on the wall — the Lock button appears here in the controls bar. Click it to lock the piece so it can\'t be accidentally dragged while you arrange other pieces. A 🔒 icon marks locked pieces. Select again and click Lock to unlock.',
    mDesc: 'Select a piece, then tap Lock to prevent accidental moves. Tap Lock again to unlock. A 🔒 appears on locked pieces.',
    pos: 'bottom',
    fallbackTarget: '[data-tutorial="ctrl-undo"]',
    fallbackNote: '→ Select any piece on the wall first — the Lock button appears here when a piece is selected',
  },
  {
    id: 'undo',
    target: '[data-tutorial="ctrl-undo"]',
    title: '↩ Undo',
    desc: 'Click "↩ Undo" to step back through your last 100 actions — adding pieces, moving them, resizing, locking/unlocking, and deleting. History is kept for the current session.',
    mDesc: 'Tap ↩ Undo to step back through recent actions — moves, resizes, adds, deletes, locks (up to 100 steps).',
    pos: 'bottom',
  },
  {
    id: 'done',
    target: null,
    title: '🎉 You\'re Ready!',
    desc: 'That covers everything! Tips will continue to suggest helpful next steps as you work — toggle them with the Tips button in the controls bar. Replay this tutorial anytime using the Tutorial button.\n\nNow go make something beautiful!',
    pos: 'center',
  },
]

export const TUTORIAL_STEP_COUNT = STEPS.length

// ── Tips definitions ──────────────────────────────────────────────
const TIPS = [
  {
    id: 'no-photo',
    condition: ({ activeWallId, walls, activeWallImage }) =>
      Boolean(activeWallId) && Object.keys(walls).length > 0 && !activeWallImage,
    target: '[data-tutorial="header-calibrate"]',
    title: '📐 Upload a Wall Photo',
    desc: 'Add a photo of your wall so pieces are placed at accurate, real-world scale.',
    mDesc: 'Tap here to upload a wall photo for accurate, to-scale placement.',
    pos: 'bottom',
  },
  {
    id: 'empty-calibrated',
    condition: ({ activeWallImage, pieces }) =>
      Boolean(activeWallImage) && pieces.length === 0,
    target: '[data-tutorial="header-add-piece"]',
    title: '+ Add Your First Piece',
    desc: 'Your wall is calibrated! Click + Add Piece to start arranging your art.',
    mDesc: 'Wall calibrated! Tap + to add your first piece of art.',
    pos: 'bottom',
  },
  {
    id: 'load-layout',
    condition: ({ pieces, wallLayouts }) =>
      pieces.length === 0 && Object.keys(wallLayouts || {}).length > 0,
    target: '[data-tutorial="sidebar-toggle"]',
    title: '📂 You Have Saved Layouts',
    desc: 'Open the sidebar → Layouts tab to load a previously saved arrangement.',
    mDesc: 'Tap ☰ → Layouts to load a saved arrangement for this wall.',
    pos: 'bottom',
  },
  {
    id: 'unsaved',
    condition: ({ pieces, currentLayout, wallLayouts }) => {
      if (pieces.length < 2) return false
      if (!currentLayout) return true
      const saved = (wallLayouts || {})[currentLayout]
      if (!saved || saved.length !== pieces.length) return true
      const map = Object.fromEntries(saved.map(p => [p.id, p]))
      return pieces.some(p => {
        const s = map[p.id]
        return !s || s.x !== p.x || s.y !== p.y || s.width !== p.width || s.height !== p.height
      })
    },
    target: '[data-tutorial="header-save"]',
    title: '💾 You Have Unsaved Changes',
    desc: 'Save your current layout before switching walls or closing the app.',
    mDesc: 'Tap Save Layout to keep your current arrangement.',
    pos: 'bottom',
  },
]

// ── Helpers ───────────────────────────────────────────────────────

/** Render text with **bold** and newline support */
function Fmt({ text }) {
  return (
    <>
      {text.split('\n').map((line, i) => {
        if (!line.trim()) return <br key={i} />
        const segs = line.split(/\*\*(.*?)\*\*/g)
        return (
          <p key={i} className="tut-p">
            {segs.map((s, j) => j % 2 === 1 ? <strong key={j}>{s}</strong> : s)}
          </p>
        )
      })}
    </>
  )
}

/**
 * Compute tutorial card position so it never overlaps the spotlight.
 * Strategy: place card BELOW target if target is in the top half,
 * ABOVE target if it's in the bottom half. Clamp to viewport edges.
 */
function cardPos(rect, pos, isMob) {
  const W       = isMob ? Math.min(310, window.innerWidth - 20) : Math.min(420, window.innerWidth - 32)
  const CARD_H  = isMob ? 280 : 320    // generous estimate — prevents overlap
  const GAP     = 16
  const VW      = window.innerWidth
  const VH      = window.innerHeight

  if (!rect || pos === 'center') {
    return { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: W }
  }

  // Decide: place below or above based on which half of screen the target is in
  const spaceBelow = VH - rect.bottom - GAP
  const spaceAbove = rect.top - GAP

  let top
  if (spaceBelow >= spaceAbove) {
    // More room below → place card below the target
    top = rect.bottom + GAP
    if (top + CARD_H > VH - 8) top = rect.top - CARD_H - GAP   // overflow: flip to top
  } else {
    // More room above → place card above the target
    top = rect.top - CARD_H - GAP
    if (top < 8) top = rect.bottom + GAP   // overflow: flip to bottom
  }
  top = Math.max(8, Math.min(top, VH - CARD_H - 8))

  // Horizontally: centre on target, clamp to viewport
  let left = rect.left + rect.width / 2 - W / 2
  left = Math.max(10, Math.min(left, VW - W - 10))

  return { position: 'fixed', top, left, width: W }
}

/** Measure a DOM element, with optional fallback selector */
function measureEl(selector, fallback) {
  const el = selector ? document.querySelector(selector) : null
  if (el) return el.getBoundingClientRect()
  const fb = fallback ? document.querySelector(fallback) : null
  return fb ? fb.getBoundingClientRect() : null
}

// ── Spotlight with pulsing interactive glow ───────────────────────
function Spotlight({ rect, pad = 10, r = 8 }) {
  if (!rect) return null
  return (
    <div
      className="tut-spotlight"
      style={{
        top:    rect.top    - pad,
        left:   rect.left   - pad,
        width:  rect.width  + pad * 2,
        height: rect.height + pad * 2,
        borderRadius: r,
      }}
    />
  )
}

// ── Pulsing ring for tips ─────────────────────────────────────────
function TipRing({ rect }) {
  if (!rect) return null
  return (
    <div
      className="tut-tip-ring"
      style={{
        top:    rect.top    - 5,
        left:   rect.left   - 5,
        width:  rect.width  + 10,
        height: rect.height + 10,
      }}
    />
  )
}

// ── Demo overlay for the piece-photo step ────────────────────────
function DemoPiecePhotoOverlay({ isMob, tutorialStep, onNext, onBack, onSkip }) {
  const pct = ((tutorialStep + 1) / STEPS.length) * 100
  const W   = isMob ? Math.min(340, window.innerWidth - 16) : 540

  return (
    <div className="tut-demo-backdrop">
      <div className="tut-demo-modal" style={{ width: W }}>
        {/* Progress bar */}
        <div className="tut-prog-track">
          <div className="tut-prog-fill" style={{ width: `${pct}%` }} />
        </div>

        <div className="tut-card-inner">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <div className="tut-step-num">{tutorialStep + 1} / {STEPS.length}</div>
            <span className="tut-demo-badge">📽 Demo mode</span>
          </div>
          <h3 className="tut-title">🎨 Piece Photo Editing Tools</h3>

          {/* Demo image canvas area */}
          <div className="tut-demo-canvas-wrap">
            <img
              src={DEMO_ART_URL}
              alt="Demo artwork — Van Gogh Starry Night"
              className="tut-demo-img"
              crossOrigin="anonymous"
            />
            {/* Simulated corner-warp handles */}
            <div className="tut-demo-handle tut-demo-handle--tl" title="Top-left corner — drag to warp" />
            <div className="tut-demo-handle tut-demo-handle--tr" title="Top-right corner" />
            <div className="tut-demo-handle tut-demo-handle--bl" title="Bottom-left corner" />
            <div className="tut-demo-handle tut-demo-handle--br" title="Bottom-right corner" />
            <div className="tut-demo-canvas-label">← Drag corners to straighten (4-Corner Warp)</div>
          </div>

          {/* Tool descriptions */}
          <div className="tut-demo-tools">
            <div className="tut-demo-tool">
              <span className="tut-demo-tool-icon">⬡</span>
              <div>
                <div className="tut-demo-tool-name">4-Corner Warp</div>
                <div className="tut-demo-tool-desc">Drag the colored corner dots to straighten photos taken at an angle</div>
              </div>
            </div>
            <div className="tut-demo-tool">
              <span className="tut-demo-tool-icon">✨</span>
              <div>
                <div className="tut-demo-tool-name">Magic Select</div>
                <div className="tut-demo-tool-desc">AI automatically detects and removes the background from around your art</div>
              </div>
            </div>
            <div className="tut-demo-tool">
              <span className="tut-demo-tool-icon">🖌</span>
              <div>
                <div className="tut-demo-tool-name">Manual Brush</div>
                <div className="tut-demo-tool-desc">Switch between Add and Erase mode to paint fine detail into the selection</div>
              </div>
            </div>
            <div className="tut-demo-tool">
              <span className="tut-demo-tool-icon">◐</span>
              <div>
                <div className="tut-demo-tool-name">Sliders</div>
                <div className="tut-demo-tool-desc">Fine-tune brightness, contrast, and saturation to match the real piece</div>
              </div>
            </div>
          </div>

          {/* Navigation */}
          <div className="tut-nav">
            <button className="tut-exit-btn" onClick={onSkip}>Exit tour</button>
            <div className="tut-nav-right">
              <button className="btn btn-ghost btn-sm" onClick={onBack}>← Back</button>
              <button className="btn btn-primary btn-sm" onClick={onNext}>Next →</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────
export default function Tutorial({
  tutorialStep,     // null = inactive, 0..N-1 = active
  onNext, onBack, onSkip,
  tipsEnabled,
  showAddModal,     // true when AddPieceModal is open
  // App state for tips
  pieces, walls,
  activeWallId, activeWallImage,
  currentLayout, wallLayouts,
}) {
  const [spotRect, setSpotRect] = useState(null)
  const [tipRect,  setTipRect]  = useState(null)
  const [dismissed, setDismissed] = useState({})

  const isMob = window.innerWidth <= 768
  const isActive = tutorialStep !== null

  /* ── Spotlight for tutorial ────────────────────────────────── */
  useEffect(() => {
    if (!isActive) { setSpotRect(null); return }
    const step = STEPS[tutorialStep]
    if (!step) { setSpotRect(null); return }

    // For piece-photo demo, no spotlight needed (demo modal takes over)
    if (step.showDemo && !showAddModal) { setSpotRect(null); return }

    const measure = () => setSpotRect(measureEl(step.target, step.fallbackTarget))
    measure()

    // Scroll the target into view so it's visible under the spotlight
    if (step.target) {
      const el = document.querySelector(step.target)
      el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    }

    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [isActive, tutorialStep, showAddModal])

  /* ── Active tip ────────────────────────────────────────────── */
  const appState = { pieces, walls, activeWallId, activeWallImage, currentLayout, wallLayouts }
  const activeTip = !isActive && tipsEnabled
    ? TIPS.find(t => !dismissed[t.id] && t.condition(appState))
    : null

  useEffect(() => {
    if (!activeTip?.target) { setTipRect(null); return }
    const measure = () => {
      const el = document.querySelector(activeTip.target)
      setTipRect(el ? el.getBoundingClientRect() : null)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [activeTip?.id])   // re-run when the active tip changes

  /* ═══════════════════════════════════════════════════════════
     TUTORIAL OVERLAY
     ═══════════════════════════════════════════════════════════ */
  if (isActive) {
    const step = STEPS[tutorialStep]
    if (!step) return null

    // Demo mode: piece-photo step without AddPieceModal open
    if (step.showDemo && !showAddModal) {
      return (
        <DemoPiecePhotoOverlay
          isMob={isMob}
          tutorialStep={tutorialStep}
          onNext={onNext}
          onBack={onBack}
          onSkip={onSkip}
        />
      )
    }

    const desc  = isMob && step.mDesc ? step.mDesc : step.desc
    const style = cardPos(spotRect, step.pos, isMob)
    const pct   = ((tutorialStep + 1) / STEPS.length) * 100
    const isFirst = tutorialStep === 0
    const isLast  = tutorialStep === STEPS.length - 1
    const hasTarget = Boolean(step.target) && Boolean(spotRect)

    return (
      <>
        {/* Spotlight highlight ring — no backdrop, nothing is dimmed */}
        <Spotlight rect={spotRect} />

        {/* Step card — positioned above or below the target, never on top of it */}
        <div className="tut-card" style={style} role="dialog" aria-modal="false">
          {/* Progress bar */}
          <div className="tut-prog-track">
            <div className="tut-prog-fill" style={{ width: `${pct}%` }} />
          </div>

          <div className="tut-card-inner">
            <div className="tut-step-num">{tutorialStep + 1} / {STEPS.length}</div>
            <h3 className="tut-title">{step.title}</h3>
            <div className="tut-desc">
              <Fmt text={desc} />
              {step.fallbackNote && !spotRect && (
                <p className="tut-fallback-note">{step.fallbackNote}</p>
              )}
            </div>

            {/* "Try it" prompt when there's an interactive target */}
            {hasTarget && (
              <div className="tut-try-hint">
                <span className="tut-try-arrow">↑</span>
                {isMob ? 'Tap' : 'Click'} the highlighted button to try it, or hit{' '}
                <strong>Next →</strong> to continue
              </div>
            )}

            <div className="tut-nav">
              <button className="tut-exit-btn" onClick={onSkip}>Exit tour</button>
              <div className="tut-nav-right">
                {!isFirst && (
                  <button className="btn btn-ghost btn-sm" onClick={onBack}>← Back</button>
                )}
                <button className="btn btn-primary btn-sm" onClick={onNext}>
                  {isLast ? '✓ Done' : 'Next →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </>
    )
  }

  /* ═══════════════════════════════════════════════════════════
     TIPS OVERLAY
     ═══════════════════════════════════════════════════════════ */
  if (activeTip) {
    const desc    = isMob && activeTip.mDesc ? activeTip.mDesc : activeTip.desc
    const style   = cardPos(tipRect, activeTip.pos, isMob)
    const dismiss = () => setDismissed(p => ({ ...p, [activeTip.id]: true }))

    return (
      <>
        <TipRing rect={tipRect} />

        <div className="tut-tip-card" style={style}>
          <button className="tut-tip-x" onClick={dismiss} aria-label="Dismiss tip">✕</button>
          <span className="tut-tip-badge">💡 Tip</span>
          <div className="tut-tip-title">{activeTip.title}</div>
          <p className="tut-tip-body">{isMob && activeTip.mDesc ? activeTip.mDesc : activeTip.desc}</p>
          <button className="tut-tip-ok btn btn-ghost btn-sm" onClick={dismiss}>Got it</button>
        </div>
      </>
    )
  }

  return null
}
