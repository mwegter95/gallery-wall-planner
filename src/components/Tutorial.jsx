import { useState, useEffect, useRef, useCallback } from 'react'

/* ═══════════════════════════════════════════════════════════════════
   TUTORIAL + TIPS SYSTEM
   ═══════════════════════════════════════════════════════════════════
   Tutorial:  step-by-step guided tour with spotlight highlight
   Tips:      contextual, non-blocking just-in-time suggestions
   ═══════════════════════════════════════════════════════════════════ */

// Demo artwork — drawn as inline SVG so it never has a broken-image state.
// Scene: a still-life painting (flowers in a vase on a draped table) in a golden frame.
// Clear foreground/background separation makes the edge and AI demos visually obvious.
const ART_W = 160, ART_H = 200

function DemoArtSVG({ style, className }) {
  return (
    <svg viewBox="0 0 160 200" xmlns="http://www.w3.org/2000/svg"
         style={{ display: 'block', ...style }} className={className}>
      {/* Frame */}
      <rect width="160" height="200" fill="#7A5810" rx="3"/>
      <rect x="4" y="4" width="152" height="192" fill="#C49A2A" rx="2"/>
      <rect x="8" y="8" width="144" height="184" fill="#6A4E0E" rx="1"/>
      {/* Painting background: deep studio blue */}
      <rect x="11" y="11" width="138" height="178" fill="#1B2B4A"/>
      {/* Table surface */}
      <rect x="11" y="128" width="138" height="61" fill="#4A3B2A"/>
      {/* White cloth on table */}
      <path d="M 28 128 L 28 189 L 132 189 L 132 128 Q 110 120 80 118 Q 50 120 28 128 Z" fill="#F0EBE0"/>
      <path d="M 28 128 Q 50 120 80 118 Q 110 120 132 128" fill="none" stroke="#D8D0C0" strokeWidth="1"/>
      {/* Table edge highlight */}
      <rect x="11" y="124" width="138" height="7" fill="#6A5540" rx="1"/>
      {/* Vase — blue ceramic */}
      <path d="M 68 128 Q 63 112 66 99 Q 68 88 80 86 Q 92 88 94 99 Q 97 112 92 128 Z" fill="#4A6E9A"/>
      <ellipse cx="80" cy="86" rx="15" ry="5" fill="#608BB8"/>
      <ellipse cx="80" cy="128" rx="13" ry="4" fill="#3A5E88"/>
      <path d="M 67 110 Q 80 106 93 110" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5"/>
      {/* Flower stems */}
      <line x1="80" y1="86" x2="66" y2="62" stroke="#4A7A28" strokeWidth="2.5"/>
      <line x1="80" y1="86" x2="80" y2="55" stroke="#4A7A28" strokeWidth="2.5"/>
      <line x1="80" y1="86" x2="94" y2="60" stroke="#4A7A28" strokeWidth="2.5"/>
      <line x1="80" y1="86" x2="58" y2="70" stroke="#4A7A28" strokeWidth="2"/>
      <line x1="80" y1="86" x2="102" y2="68" stroke="#4A7A28" strokeWidth="2"/>
      {/* Red rose left */}
      <circle cx="66" cy="60" r="10" fill="#A01020"/>
      <circle cx="66" cy="60" r="7"  fill="#C82030"/>
      <circle cx="66" cy="60" r="4"  fill="#E84050"/>
      {/* White daisy centre */}
      <circle cx="80" cy="53" r="9"  fill="#F8F4EC"/>
      <circle cx="80" cy="53" r="5"  fill="#FFD700"/>
      {/* Orange flower right */}
      <circle cx="94" cy="58" r="10" fill="#CC6000"/>
      <circle cx="94" cy="58" r="6"  fill="#FF8C20"/>
      {/* Small purple left */}
      <circle cx="58" cy="68" r="7"  fill="#7B2D8B"/>
      <circle cx="58" cy="68" r="4"  fill="#B060C8"/>
      {/* Small green right */}
      <circle cx="102" cy="66" r="7" fill="#1E7840"/>
      <circle cx="102" cy="66" r="4" fill="#38B060"/>
      {/* Leaves */}
      <ellipse cx="63" cy="78" rx="9" ry="4" fill="#386820" transform="rotate(-28 63 78)"/>
      <ellipse cx="97" cy="76" rx="9" ry="4" fill="#386820" transform="rotate(22 97 76)"/>
    </svg>
  )
}

/** Convert (clientX, clientY) to canvas pixel coords, accounting for display scaling */
function canvasEventPos(e, canvas) {
  const rect = canvas.getBoundingClientRect()
  const pt   = e.touches ? e.touches[0] : e
  return {
    x: (pt.clientX - rect.left) * (canvas.width  / rect.width),
    y: (pt.clientY - rect.top)  * (canvas.height / rect.height),
  }
}

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
    desc: 'Creating an account syncs your walls and layouts to any device — phone, tablet, or desktop. Your password is hashed and never stored in plain text, photo uploads are encrypted at rest, and your walls are only accessible to you — no one else can view your data.',
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
    id: 'piece-photo-warp',
    target: '[data-tutorial="header-add-piece"]',
    title: '📐 Perspective Warp',
    desc: 'After uploading a photo, the **Perspective Crop** tab opens. Drag the four coloured corner handles to align exactly with the edges of the artwork in the photo. This flattens any camera angle or wall lean. Click **Apply Warp** when aligned — or **Skip warp** to use the photo as-is.',
    mDesc: 'Drag the 4 coloured corners to align with the artwork edges, then Apply Warp. Skip warp uses the photo as-is.',
    pos: 'bottom',
    showDemo: true,
    demoType: 'warp',
  },
  {
    id: 'piece-photo-edge',
    target: '[data-tutorial="header-add-piece"]',
    title: '✂️ Edge Selection',
    desc: 'Switch to the **Magic Select** tab if your artwork has an irregular shape — oval frame, cut-out, or non-rectangular piece. Click **⚡ Edge Select** to flood-fill from the photo borders inward. Adjust **Tolerance** to grow or shrink the selection, then paint with the brush in **Add** or **Erase** mode to clean up any missed spots.',
    mDesc: 'In Magic Select, ⚡ Edge Select traces from the borders. Adjust Tolerance, then brush to clean up.',
    pos: 'bottom',
    showDemo: true,
    demoType: 'edge',
  },
  {
    id: 'piece-photo-ai',
    target: '[data-tutorial="header-add-piece"]',
    title: '🤖 AI Background Removal',
    desc: 'Click **✨ AI Detect** to automatically remove the background using AI. Adjust **AI Threshold** — lower means more aggressive removal (might clip the subject), higher is more conservative (may keep some background). Fine-tune remaining edges with the brush. The checkerboard areas will be transparent on the wall.',
    mDesc: 'Tap ✨ AI Detect to auto-remove backgrounds. Adjust AI Threshold, then brush-fix any edges.',
    pos: 'bottom',
    showDemo: true,
    demoType: 'ai',
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
export const TUTORIAL_GRID_STEP  = STEPS.findIndex(s => s.id === 'grid')

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

// ── Shared demo modal shell ───────────────────────────────────────
function DemoShell({ W, tutorialStep, title, badge = '📽 Interactive', children, onNext, onBack, onSkip }) {
  const pct     = ((tutorialStep + 1) / STEPS.length) * 100
  const isFirst = tutorialStep === 0
  const isLast  = tutorialStep === STEPS.length - 1
  return (
    <div className="tut-demo-backdrop">
      <div className="tut-demo-modal" style={{ width: W }}>
        <div className="tut-prog-track">
          <div className="tut-prog-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="tut-card-inner">
          <div className="tut-demo-header-row">
            <div className="tut-step-num">{tutorialStep + 1} / {STEPS.length}</div>
            <span className="tut-demo-badge">{badge}</span>
          </div>
          <h3 className="tut-title">{title}</h3>
          {children}
          <div className="tut-nav">
            <button className="tut-exit-btn" onClick={onSkip}>Exit tour</button>
            <div className="tut-nav-right">
              {!isFirst && <button className="btn btn-ghost btn-sm" onClick={onBack}>← Back</button>}
              <button className="btn btn-primary btn-sm" onClick={onNext}>{isLast ? '✓ Done' : 'Next →'}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Demo Step 1: Perspective Warp ─────────────────────────────────
// Four draggable corner handles with a dashed outline, clip-path updates
// live. "Apply Warp" shows the corrected result; "Reset" restores skew.
const INIT_CORNERS = {
  tl: { x: 18, y: 24 },
  tr: { x: 148, y: 11 },
  br: { x: 153, y: 193 },
  bl: { x:  9, y: 184 },
}
const CORNER_COLORS = { tl: '#FF6B6B', tr: '#FFD93D', br: '#6BCB77', bl: '#4D96FF' }

function DemoWarpStep({ W, isMob, tutorialStep, onNext, onBack, onSkip }) {
  const [corners, setCorners]   = useState(() => ({ ...INIT_CORNERS, tl: { ...INIT_CORNERS.tl }, tr: { ...INIT_CORNERS.tr }, br: { ...INIT_CORNERS.br }, bl: { ...INIT_CORNERS.bl } }))
  const [dragging, setDragging] = useState(null)
  const [warped, setWarped]     = useState(false)
  const wrapRef = useRef(null)

  const toLocal = useCallback((e) => {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    const pt = e.touches ? e.touches[0] : e
    const scaleX = ART_W / rect.width
    const scaleY = ART_H / rect.height
    return {
      x: Math.round(Math.max(0, Math.min(ART_W, (pt.clientX - rect.left) * scaleX))),
      y: Math.round(Math.max(0, Math.min(ART_H, (pt.clientY - rect.top)  * scaleY))),
    }
  }, [])

  const onMove = useCallback((e) => {
    if (!dragging) return
    e.preventDefault()
    setCorners(c => ({ ...c, [dragging]: toLocal(e) }))
  }, [dragging, toLocal])

  const onUp = useCallback(() => setDragging(null), [])

  const { tl, tr, br, bl } = corners
  const clipPoly = `polygon(${tl.x}px ${tl.y}px, ${tr.x}px ${tr.y}px, ${br.x}px ${br.y}px, ${bl.x}px ${bl.y}px)`
  const outlinePts = `${tl.x},${tl.y} ${tr.x},${tr.y} ${br.x},${br.y} ${bl.x},${bl.y}`

  return (
    <DemoShell W={W} tutorialStep={tutorialStep} title="📐 Step 1: Perspective Warp"
               onNext={onNext} onBack={onBack} onSkip={onSkip}>
      <p className="tut-demo-explain" style={{ margin: '0 0 10px' }}>
        {warped
          ? '✓ Perspective corrected — the painting is now viewed straight-on.'
          : 'Drag the coloured corner handles to align with the edges of the artwork. The clip updates live so you can see the correction.'}
      </p>
      <div className="tut-demo-two-col">
        {/* Image area */}
        <div ref={wrapRef} className="tut-demo-img-wrap"
             style={{ width: ART_W, height: ART_H, cursor: dragging ? 'grabbing' : 'default' }}
             onMouseMove={onMove}  onTouchMove={onMove}
             onMouseUp={onUp}      onTouchEnd={onUp}
             onMouseLeave={onUp}>
          <DemoArtSVG style={{ width: ART_W, height: ART_H, clipPath: warped ? 'none' : clipPoly }} />
          {/* Dashed outline connecting corners */}
          {!warped && (
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
                 viewBox={`0 0 ${ART_W} ${ART_H}`} preserveAspectRatio="none">
              <polygon points={outlinePts} fill="none"
                       stroke="rgba(255,255,255,0.7)" strokeWidth="1.5" strokeDasharray="5,3"/>
            </svg>
          )}
          {/* Corner handles */}
          {!warped && Object.entries(corners).map(([key, pt]) => (
            <div key={key} className="tut-demo-corner-handle"
                 style={{ left: pt.x - 8, top: pt.y - 8, background: CORNER_COLORS[key] }}
                 onMouseDown={e => { e.preventDefault(); setDragging(key) }}
                 onTouchStart={e => { e.preventDefault(); setDragging(key) }} />
          ))}
          {warped && <div className="tut-demo-warp-badge">✓ Perspective corrected</div>}
        </div>
        {/* Controls */}
        <div className="tut-demo-ctrl-panel">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {!warped
              ? <button className="btn btn-primary btn-sm" onClick={() => setWarped(true)}>✓ Apply Warp</button>
              : <button className="btn btn-ghost btn-sm" onClick={() => { setCorners({ tl:{...INIT_CORNERS.tl}, tr:{...INIT_CORNERS.tr}, br:{...INIT_CORNERS.br}, bl:{...INIT_CORNERS.bl} }); setWarped(false) }}>↺ Reset demo</button>
            }
            <button className="cm-skip-link" style={{ textAlign: 'left' }} onClick={onNext}>Skip warp →</button>
          </div>
          <p className="tut-demo-hint">
            {warped
              ? 'Apply Warp flattens the perspective for accurate scale on the wall.'
              : 'Drag any coloured dot to a corner of the artwork, then Apply Warp.'}
          </p>
        </div>
      </div>
    </DemoShell>
  )
}

// ── Demo Step 2: Edge Selection ───────────────────────────────────
// Real <canvas> overlay on top of the painting SVG. Tolerance slider
// redraws the initial edge-flood mask. User can actually paint on the
// canvas in Add (green) or Erase mode to refine the selection.
function DemoEdgeStep({ W, isMob, tutorialStep, onNext, onBack, onSkip }) {
  const canvasRef    = useRef(null)
  const drawingRef   = useRef(false)
  const [mode, setMode]               = useState('add')
  const [brushType, setBrushType]     = useState('smart')
  const [brushSize, setBrushSize]     = useState(22)
  const [tolerance, setTolerance]     = useState(28)
  const [sensitivity, setSensitivity] = useState(25)

  // Redraw initial selection mask whenever tolerance changes
  const drawMask = useCallback((tol) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const cW = canvas.width, cH = canvas.height
    ctx.clearRect(0, 0, cW, cH)
    // How far the edge flood-fill has grown inward from each border
    const thick = Math.round((tol / 80) * 36) + 5
    ctx.fillStyle = 'rgba(72, 199, 116, 0.50)'
    ctx.fillRect(0, 0, cW, thick)                          // top
    ctx.fillRect(0, cH - thick, cW, thick)                 // bottom
    ctx.fillRect(0, thick, thick, cH - thick * 2)          // left
    ctx.fillRect(cW - thick, thick, thick, cH - thick * 2) // right
  }, [])

  useEffect(() => { drawMask(tolerance) }, [tolerance, drawMask])

  const paint = useCallback((e) => {
    if (!drawingRef.current) return
    e.preventDefault()
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const pos = canvasEventPos(e, canvas)
    ctx.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over'
    ctx.fillStyle = 'rgba(72, 199, 116, 0.55)'
    ctx.beginPath()
    ctx.arc(pos.x, pos.y, brushSize / 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
  }, [mode, brushSize])

  return (
    <DemoShell W={W} tutorialStep={tutorialStep} title="✂️ Step 2: Edge Selection"
               onNext={onNext} onBack={onBack} onSkip={onSkip}>
      <p className="tut-demo-explain" style={{ margin: '0 0 10px' }}>
        <strong>⚡ Edge Select</strong> floods from the photo borders inward — green shows what's selected.
        Drag <strong>Tolerance</strong> to see the mask grow/shrink. Then <strong>paint directly on the image</strong> to add or erase.
      </p>
      <div className="tut-demo-two-col">
        {/* Canvas area */}
        <div className="tut-demo-img-wrap" style={{ position: 'relative', width: ART_W, height: ART_H, flexShrink: 0 }}>
          <DemoArtSVG style={{ width: ART_W, height: ART_H, display: 'block' }} />
          <canvas ref={canvasRef} width={ART_W} height={ART_H}
                  className="tut-demo-edge-canvas"
                  style={{ cursor: mode === 'erase' ? 'cell' : 'crosshair', touchAction: 'none' }}
                  onMouseDown={e => { drawingRef.current = true; paint(e) }}
                  onMouseMove={paint}
                  onMouseUp={() => { drawingRef.current = false }}
                  onMouseLeave={() => { drawingRef.current = false }}
                  onTouchStart={e => { drawingRef.current = true; paint(e) }}
                  onTouchMove={paint}
                  onTouchEnd={() => { drawingRef.current = false }} />
        </div>
        {/* Controls */}
        <div className="tut-demo-ctrl-panel">
          {/* Brush type */}
          <div className="tut-demo-brush-row">
            <button className={`tut-demo-mb ${brushType === 'smart'  ? 'tut-demo-mb--smart'  : ''}`} onClick={() => setBrushType('smart')}>🪄 Smart</button>
            <button className={`tut-demo-mb ${brushType === 'manual' ? 'tut-demo-mb--smart'  : ''}`} onClick={() => setBrushType('manual')}>✏️ Manual</button>
          </div>
          {/* Add / Erase */}
          <div className="tut-demo-brush-row" style={{ marginTop: 4 }}>
            <button className={`tut-demo-mb ${mode === 'add'   ? 'tut-demo-mb--add'   : ''}`} onClick={() => setMode('add')}>＋ Add</button>
            <button className={`tut-demo-mb ${mode === 'erase' ? 'tut-demo-mb--erase' : ''}`} onClick={() => setMode('erase')}>✕ Erase</button>
          </div>
          {/* Size */}
          <div className="tut-demo-ctrl-row" style={{ marginTop: 6 }}>
            <span className="tut-demo-ctrl-lbl">Size</span>
            <input type="range" className="tut-demo-slider" min={8} max={60} value={brushSize}
                   onChange={e => setBrushSize(Number(e.target.value))} />
            <span className="tut-demo-ctrl-val">{brushSize}px</span>
          </div>
          {/* Sensitivity */}
          <div className="tut-demo-ctrl-row">
            <span className="tut-demo-ctrl-lbl" title="How similarly-coloured adjacent pixels must be to join the Smart brush stroke">Sensitivity</span>
            <input type="range" className="tut-demo-slider" min={0} max={80} value={sensitivity}
                   onChange={e => setSensitivity(Number(e.target.value))} />
            <span className="tut-demo-ctrl-val">{sensitivity}</span>
          </div>
          {/* Tolerance — affects the initial mask */}
          <div className="tut-demo-ctrl-row">
            <span className="tut-demo-ctrl-lbl" title="How far Edge Select floods inward from the photo borders">Tolerance</span>
            <input type="range" className="tut-demo-slider" min={0} max={80} value={tolerance}
                   onChange={e => setTolerance(Number(e.target.value))} />
            <span className="tut-demo-ctrl-val">{tolerance}</span>
          </div>
          <p className="tut-demo-hint" style={{ marginTop: 4 }}>
            Green = selected area. Drag Tolerance to see the edge grow. Paint on the image to add or erase selection.
          </p>
        </div>
      </div>
    </DemoShell>
  )
}

// ── Demo Step 3: AI Background Removal ───────────────────────────
// Painting shown on a checkerboard background with a CSS mask-image.
// AI Threshold pips change the mask size — lower = more removed.
function aiMaskCSS(thresh) {
  // thresh 0–10. Lower = more aggressive = smaller visible ellipse.
  const sz = 38 + thresh * 4  // 38–78 %
  const soft = thresh < 3 ? 6 : thresh < 7 ? 14 : 20
  return `radial-gradient(ellipse ${sz}% ${sz + 8}% at 50% 52%, black ${sz - soft}%, transparent ${sz + soft}%)`
}
function aiLabel(t) {
  if (t <= 1) return 'Very tight — may clip the subject'
  if (t <= 3) return 'Tight'
  if (t <= 6) return 'Balanced ✓'
  if (t <= 8) return 'Loose — may keep background'
  return 'Very loose — little removed'
}

function DemoAIStep({ W, isMob, tutorialStep, onNext, onBack, onSkip }) {
  const [thresh, setThresh] = useState(6)
  const mask = thresh >= 10 ? 'none' : aiMaskCSS(thresh)
  return (
    <DemoShell W={W} tutorialStep={tutorialStep} title="🤖 Step 3: AI Background Removal"
               onNext={onNext} onBack={onBack} onSkip={onSkip}>
      <p className="tut-demo-explain" style={{ margin: '0 0 10px' }}>
        <strong>✨ AI Detect</strong> auto-removes backgrounds. Click the <strong>AI Threshold</strong> dots
        below to see how aggressiveness changes the mask — lower removes more, higher keeps more.
        Checkerboard = transparent.
      </p>
      <div className="tut-demo-two-col">
        {/* Image on checkerboard with CSS mask */}
        <div className="tut-demo-img-wrap" style={{ position: 'relative', width: ART_W, height: ART_H, flexShrink: 0 }}>
          <div className="tut-demo-checker" style={{ position: 'absolute', inset: 0, borderRadius: 4 }} />
          <DemoArtSVG style={{
            width: ART_W, height: ART_H, display: 'block',
            position: 'relative', zIndex: 1,
            WebkitMaskImage: mask,
            maskImage: mask,
          }} />
        </div>
        {/* Controls */}
        <div className="tut-demo-ctrl-panel">
          <div className="tut-demo-ctrl-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
            <span className="tut-demo-ctrl-lbl" style={{ marginBottom: 2 }}>AI Threshold</span>
            <div className="tut-demo-pips">
              {Array.from({ length: 11 }, (_, i) => (
                <div key={i}
                     className={`tut-demo-pip ${i <= thresh ? 'tut-demo-pip--on' : ''}`}
                     onClick={() => setThresh(i)}
                     title={`Threshold ${i}`} />
              ))}
            </div>
            <span className="tut-demo-ctrl-val" style={{ fontSize: 11 }}>{aiLabel(thresh)}</span>
          </div>
          <p className="tut-demo-hint" style={{ marginTop: 8 }}>
            {thresh <= 3 && <><strong>⚠</strong> Very tight — might cut into the subject. Try raising to 5–7.<br/></>}
            {thresh > 3 && thresh <= 7 && <><strong>✓</strong> Good balance. Use the brush to touch up any edges AI missed.<br/></>}
            {thresh > 7 && <><strong>⚠</strong> Loose — some background kept. Lower threshold or use Edge Select.<br/></>}
            After AI Detect, switch to the brush in Edge Selection to fix any remaining imperfections.
          </p>
        </div>
      </div>
    </DemoShell>
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

    // Demo mode: photo-editing steps when AddPieceModal is not open
    if (step.showDemo && !showAddModal) {
      const W     = isMob ? Math.min(360, window.innerWidth - 12) : 520
      const props = { W, isMob, tutorialStep, onNext, onBack, onSkip }
      if (step.demoType === 'warp') return <DemoWarpStep  {...props} />
      if (step.demoType === 'edge') return <DemoEdgeStep  {...props} />
      if (step.demoType === 'ai')   return <DemoAIStep    {...props} />
      return null
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
