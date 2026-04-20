import { useState, useEffect } from 'react'

/* ═══════════════════════════════════════════════════════════════════
   TUTORIAL + TIPS SYSTEM
   ═══════════════════════════════════════════════════════════════════
   Tutorial:  step-by-step guided tour with spotlight highlight
   Tips:      contextual, non-blocking just-in-time suggestions
   ═══════════════════════════════════════════════════════════════════ */

// Demo art image: Vermeer's "Girl with a Pearl Earring" — public domain, Wikimedia Commons
// Shown with a CSS frame so it looks like a real piece hanging on a wall
const DEMO_ART_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0f/1665_Girl_with_a_Pearl_Earring.jpg/800px-1665_Girl_with_a_Pearl_Earring.jpg'

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
    title: '🎨 Photo Editing Tools',
    desc: 'After uploading a photo two tabs open:\n\n**Perspective Crop** — drag 4 coloured corner handles to flatten perspective on angled shots, then hit Apply Warp\n**Magic Select** — ⚡ Edge Select traces colour from photo borders instantly. Adjust **Tolerance** to grow/shrink the selection. Run ✨ AI Detect for cleaner edges, then fine-tune with **AI Threshold** pip dots\n**Brush** — Smart (edge-aware) or Manual, in Add or Erase mode to paint over any mistakes\n**Sensitivity** — how similarly-coloured neighbouring pixels must be to join the Smart brush selection',
    mDesc: 'After uploading a photo:\n\n**Perspective Crop** — drag corners to flatten perspective\n**Edge Select** — instant colour-boundary tracing, adjust Tolerance\n**AI Detect** — removes the background; use AI Threshold pips to tighten or loosen\n**Brush** — Smart or Manual, Add or Erase mode to clean up edges',
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
    target: '[data-tutorial="sidebar-toggle"]',          // mobile: hamburger button
    desktopTarget: '[data-tutorial="sidebar-tabs"]',     // desktop: the sidebar tabs row (always visible)
    title: '☰ The Sidebar',
    desc: 'The sidebar is always open on the left. Use the tabs to switch between sections:\n\n**Pieces** — reorder layers, edit individual pieces, delete them\n**Snap to Grid** — enable snapping with a grid interval for precise placement\n**Layouts** — load, rename, or delete saved arrangements\n**Library** — pieces you\'ve added are saved here so you can reuse them without re-uploading',
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
    target: '[data-tutorial="snap-setting"]',
    title: '⊞ Grid & Snap to Grid',
    desc: 'The **Settings** tab (now open) has Snap to Grid. Toggle it on and pieces will snap to a grid interval you choose — great for even spacing. You can also click **⊞ Grid** in the controls bar to overlay a measurement grid (inches and feet) across your wall.',
    mDesc: 'In the Settings tab, toggle Snap to Grid on. Pieces snap to a precise interval. Tap ⊞ Grid in the toolbar to show a measurement overlay.',
    pos: 'bottom',
    openSettings: true,  // triggers sidebar → Settings tab on step enter
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
export const TUTORIAL_LOCK_STEP  = STEPS.findIndex(s => s.id === 'lock')

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

/**
 * Measure a DOM element.
 * On desktop, prefers desktopTarget if provided.
 * Falls back through: desktopTarget → selector → fallback.
 */
function measureEl(selector, fallback, desktopTarget, isMob) {
  const primary = (!isMob && desktopTarget) ? desktopTarget : selector
  const el = primary ? document.querySelector(primary) : null
  if (el) return el.getBoundingClientRect()
  // Try the other one as a secondary fallback
  const alt = primary !== selector ? document.querySelector(selector) : null
  if (alt) return alt.getBoundingClientRect()
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
// Shows a realistic mock of the Magic Select "brush" phase — the state
// AFTER edge-detection has run, so the user can see the actual controls
// they'll use to refine the selection.
function DemoPiecePhotoOverlay({ isMob, tutorialStep, onNext, onBack, onSkip }) {
  const pct = ((tutorialStep + 1) / STEPS.length) * 100
  const W   = isMob ? Math.min(340, window.innerWidth - 16) : 520

  // Simulate interactive AI Threshold pip dots
  const [thresh, setThresh] = useState(6)

  return (
    <div className="tut-demo-backdrop">
      <div className="tut-demo-modal" style={{ width: W }}>
        {/* Progress bar */}
        <div className="tut-prog-track">
          <div className="tut-prog-fill" style={{ width: `${pct}%` }} />
        </div>

        <div className="tut-card-inner">
          {/* Header row */}
          <div className="tut-demo-header-row">
            <div className="tut-step-num">{tutorialStep + 1} / {STEPS.length}</div>
            <span className="tut-demo-badge">📽 Demo</span>
          </div>
          <h3 className="tut-title">🎨 Photo Editing Tools</h3>

          {/* Mock CropModal tab bar */}
          <div className="tut-demo-cm-tabs">
            <button className="tut-demo-cm-tab">✂️ Perspective Crop</button>
            <button className="tut-demo-cm-tab tut-demo-cm-tab--active">✨ Magic Select</button>
          </div>

          {/* Canvas: checkerboard bg + framed painting with masked edges
              Simulates "after Edge Select / AI detection" phase            */}
          <div className="tut-demo-canvas-wrap">
            {/* Checkerboard shows transparency around removed background */}
            <div className="tut-demo-checker">
              {/* CSS frame around the artwork */}
              <div className="tut-demo-art-frame">
                <img
                  src={DEMO_ART_URL}
                  alt="Vermeer — Girl with a Pearl Earring"
                  className="tut-demo-art-img"
                />
              </div>
              {/* Simulated green "Add" brush cursor */}
              <div className="tut-demo-brush-cursor" />
            </div>
            <div className="tut-demo-canvas-caption">
              After detection — checkerboard = transparent background
            </div>
          </div>

          {/* Brush controls: accurate match to real MagicSelect UI */}
          <div className="tut-demo-brush-panel">

            {/* Row 1: brush type + mode */}
            <div className="tut-demo-brush-row">
              <button className="tut-demo-mb tut-demo-mb--smart">🪄 Smart</button>
              <button className="tut-demo-mb">✏️ Manual</button>
              <div className="tut-demo-mb-sep" />
              <button className="tut-demo-mb tut-demo-mb--add">＋ Add</button>
              <button className="tut-demo-mb">✕ Erase</button>
              <div style={{ flex: 1 }} />
              <button className="tut-demo-mb">⇄ Invert</button>
            </div>

            {/* Row 2: brush size */}
            <div className="tut-demo-ctrl-row">
              <span className="tut-demo-ctrl-lbl">Size</span>
              <input type="range" className="tut-demo-slider" min={5} max={100} defaultValue={28} readOnly />
              <span className="tut-demo-ctrl-val">28px</span>
            </div>

            {/* Row 3: sensitivity (smart brush — colour match tolerance) */}
            <div className="tut-demo-ctrl-row">
              <span className="tut-demo-ctrl-lbl" title="How similarly-coloured neighbouring pixels must be to join the selection">Sensitivity</span>
              <input type="range" className="tut-demo-slider" min={0} max={80} defaultValue={28} readOnly />
              <span className="tut-demo-ctrl-val">Balanced</span>
            </div>

            {/* Row 4: edge-detect Tolerance */}
            <div className="tut-demo-ctrl-row">
              <span className="tut-demo-ctrl-lbl" title="How loosely the edge flood-fill grows from photo borders">Tolerance</span>
              <input type="range" className="tut-demo-slider" min={0} max={80} defaultValue={35} readOnly />
              <span className="tut-demo-ctrl-val">Balanced</span>
            </div>

            {/* Row 5: AI Threshold pip dots (interactive in demo!) */}
            <div className="tut-demo-ctrl-row">
              <span className="tut-demo-ctrl-lbl" title="How strictly to apply the AI background mask">AI Threshold</span>
              <div className="tut-demo-pips">
                {Array.from({ length: 11 }, (_, i) => (
                  <div
                    key={i}
                    className={`tut-demo-pip ${i <= thresh ? 'tut-demo-pip--on' : ''}`}
                    onClick={() => setThresh(i)}
                    title={`Set threshold to ${i}`}
                  />
                ))}
              </div>
              <span className="tut-demo-ctrl-val">
                {thresh < 4 ? 'Tight' : thresh > 7 ? 'Loose' : 'Balanced'}
              </span>
            </div>
          </div>

          {/* Explanation */}
          <div className="tut-demo-explain">
            <strong>Perspective Crop</strong> tab: drag 4 coloured corners to straighten angled photos, then <em>Apply Warp</em>.
            {' '}<strong>Magic Select</strong> tab: <em>⚡ Edge Select</em> traces colour from photo borders—adjust <strong>Tolerance</strong> to grow or shrink the selection.
            Run <em>✨ AI Detect</em> for cleaner edges, then use <strong>AI Threshold</strong> and the <strong>brush</strong> to refine.
            Paint in <em>Add</em> or <em>Erase</em> mode with Smart (edge-aware) or Manual brush.
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
  onSidebarSection, // (section: string) => void — open sidebar to a tab
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

    // If this step requires a specific sidebar tab, open it first then measure
    // after a short delay so the DOM renders the revealed content
    if (step.openSettings && onSidebarSection) {
      onSidebarSection('settings')
      let measureFn = null
      const t = setTimeout(() => {
        measureFn = () => setSpotRect(measureEl(step.target, step.fallbackTarget, step.desktopTarget, isMob))
        measureFn()
        const activeTarget = (!isMob && step.desktopTarget) ? step.desktopTarget : step.target
        if (activeTarget) {
          const el = document.querySelector(activeTarget)
          el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
        }
        window.addEventListener('resize', measureFn)
      }, 350)
      return () => {
        clearTimeout(t)
        if (measureFn) window.removeEventListener('resize', measureFn)
      }
    }

    const measure = () => setSpotRect(measureEl(step.target, step.fallbackTarget, step.desktopTarget, isMob))
    measure()

    // Scroll the target into view so it's visible under the spotlight
    const activeTarget = (!isMob && step.desktopTarget) ? step.desktopTarget : step.target
    if (activeTarget) {
      const el = document.querySelector(activeTarget)
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
                {isMob ? 'Tap to try it' : 'Click to try it'}
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
