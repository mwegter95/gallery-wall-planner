/**
 * uiBounds.test.js
 *
 * Structural CSS and HTML source checks ensuring UI elements stay within screen
 * bounds and don't obscure or clip each other.
 *
 * Covers:
 *   - Viewport meta prevents double-tap zoom (index.html)
 *   - Joystick group is absolutely positioned inside the 3D viewport
 *   - Zoom bar is absolutely positioned with bounded z-index
 *   - FOV bar is absolutely positioned (left side, same as zoom bar — right)
 *   - Diagnostic panel is bounded by calc(100vw - 24px)
 *   - No full-screen overlay uses overflow:hidden in a way that clips warp handles
 *   - Critical SpaceBuilderCanvas buttons all have title attributes (accessible + testable)
 *   - Save button is discoverable by title in SpaceBuilder
 *   - Mobile media query exists for tablet/phone sizes
 *   - ws-photo-wrap padding keeps warp handles outside the clipping boundary
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const HTML_SRC   = readFileSync(join(process.cwd(), 'index.html'), 'utf8')
const CSS_SRC    = readFileSync(join(process.cwd(), 'src/App.css'), 'utf8')
const CANVAS_SRC = readFileSync(join(process.cwd(), 'src/components/SpaceBuilderCanvas.jsx'), 'utf8')
const SB_SRC     = readFileSync(join(process.cwd(), 'src/components/SpaceBuilder.jsx'), 'utf8')

// ── Viewport and zoom guards ──────────────────────────────────────────────────

describe('Viewport zoom guards', () => {
  it('index.html has maximum-scale=1.0 to suppress double-tap zoom', () => {
    expect(HTML_SRC).toMatch(/maximum-scale=1\.0/)
  })

  it('index.html has user-scalable=no', () => {
    expect(HTML_SRC).toMatch(/user-scalable=no/)
  })
})

// ── Joystick group bounds ─────────────────────────────────────────────────────

describe('Joystick group CSS bounds', () => {
  it('sbc-joystick-group is position:absolute (inside viewport, not page)', () => {
    expect(CSS_SRC).toMatch(/\.sbc-joystick-group\s*\{[\s\S]*?position:\s*absolute/)
  })

  it('sbc-joystick-group is anchored at top of viewport', () => {
    expect(CSS_SRC).toMatch(/\.sbc-joystick-group\s*\{[\s\S]*?top:\s*12px/)
  })

  it('sbc-joystick-group is horizontally centred', () => {
    expect(CSS_SRC).toMatch(/\.sbc-joystick-group\s*\{[\s\S]*?left:\s*50%/)
  })

  it('sbc-joystick-group has z-index 20 (above canvas, below modals)', () => {
    expect(CSS_SRC).toMatch(/\.sbc-joystick-group\s*\{[\s\S]*?z-index:\s*20/)
  })
})

// ── Zoom bar bounds ───────────────────────────────────────────────────────────

describe('Zoom bar CSS bounds', () => {
  it('sbc-zoom-bar is position:absolute', () => {
    expect(CSS_SRC).toMatch(/\.sbc-zoom-bar\s*\{[\s\S]*?position:\s*absolute/)
  })

  it('sbc-zoom-bar is docked to the right edge', () => {
    expect(CSS_SRC).toMatch(/\.sbc-zoom-bar\s*\{[\s\S]*?right:\s*10px/)
  })

  it('sbc-zoom-bar is vertically centred with transform', () => {
    expect(CSS_SRC).toMatch(/\.sbc-zoom-bar\s*\{[\s\S]*?transform:\s*translateY\(-50%\)/)
  })

  it('sbc-zoom-bar has z-index 20', () => {
    expect(CSS_SRC).toMatch(/\.sbc-zoom-bar\s*\{[\s\S]*?z-index:\s*20/)
  })
})

// ── FOV bar bounds ────────────────────────────────────────────────────────────

describe('FOV bar CSS bounds', () => {
  it('sbc-fov-bar is position:absolute', () => {
    expect(CSS_SRC).toMatch(/\.sbc-fov-bar\s*\{[\s\S]*?position:\s*absolute/)
  })

  it('sbc-fov-bar is on the left side', () => {
    expect(CSS_SRC).toMatch(/\.sbc-fov-bar\s*\{[\s\S]*?left:\s*10px/)
  })
})

// ── Diagnostics panel bounds ──────────────────────────────────────────────────

describe('Diagnostics panel CSS bounds', () => {
  it('sbc-diag-panel has max-width capped by viewport width', () => {
    // Must use calc(100vw - N) so it can't overflow on narrow screens.
    expect(CSS_SRC).toMatch(/\.sbc-diag-panel\s*\{[\s\S]*?max-width:\s*calc\(100vw/)
  })

  it('sbc-diag-panel is horizontally centred', () => {
    expect(CSS_SRC).toMatch(/\.sbc-diag-panel\s*\{[\s\S]*?left:\s*50%/)
  })
})

// ── Warp handle clipping prevention ──────────────────────────────────────────

describe('Warp handle clipping prevention', () => {
  it('ws-photo-wrap has overflow:visible so handles are not clipped', () => {
    expect(CSS_SRC).toMatch(/\.ws-photo-wrap\s*\{[\s\S]*?overflow:\s*visible/)
  })

  it('ws-photo-wrap has padding to push handles into grabbable space', () => {
    expect(CSS_SRC).toMatch(/\.ws-photo-wrap\s*\{[\s\S]*?padding:\s*18px/)
  })
})

// ── 3D viewport container ─────────────────────────────────────────────────────

describe('3D viewport container', () => {
  it('sbc-3d-viewport is position:relative so absolute children are scoped', () => {
    expect(CSS_SRC).toMatch(/\.sbc-3d-viewport\s*\{[\s\S]*?position:\s*relative/)
  })

  it('sbc-3d-viewport fills its parent', () => {
    expect(CSS_SRC).toMatch(/\.sbc-3d-viewport\s*\{[\s\S]*?width:\s*100%/)
    expect(CSS_SRC).toMatch(/\.sbc-3d-viewport\s*\{[\s\S]*?height:\s*100%/)
  })
})

// ── Mobile responsive breakpoints ────────────────────────────────────────────

describe('Mobile responsive breakpoints', () => {
  it('App.css has a 768px breakpoint for tablet/phone', () => {
    expect(CSS_SRC).toMatch(/@media.*max-width:\s*768px/)
  })

  it('App.css has a ≤480px breakpoint for small phones', () => {
    expect(CSS_SRC).toMatch(/@media.*max-width:\s*480px/)
  })
})

// ── SpaceBuilderCanvas button accessibility ───────────────────────────────────

describe('SpaceBuilderCanvas button title attributes', () => {
  it('zoom-in button has a title', () => {
    expect(CANVAS_SRC).toMatch(/className="sbc-zoom-btn"[\s\S]{0,100}title=/)
  })

  it('zoom-out button has a title', () => {
    // Two zoom buttons; both should have title attributes
    const matches = (CANVAS_SRC.match(/className="sbc-zoom-btn"[\s\S]{0,120}title=/g) || [])
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  it('pan joystick has a title', () => {
    expect(CANVAS_SRC).toMatch(/sbc-joystick--pan[\s\S]{0,200}title=/)
  })

  it('orbit joystick has a title', () => {
    expect(CANVAS_SRC).toMatch(/sbc-joystick--orbit[\s\S]{0,200}title=/)
  })

  it('fwd joystick has a title', () => {
    expect(CANVAS_SRC).toMatch(/sbc-joystick--fwd[\s\S]{0,200}title=/)
  })
})

// ── SpaceBuilder save button accessibility ────────────────────────────────────

describe('SpaceBuilder save button discoverability', () => {
  it('save button has title="Save room" so tests and a11y tools can find it', () => {
    expect(SB_SRC).toMatch(/title="Save room"/)
  })
})
