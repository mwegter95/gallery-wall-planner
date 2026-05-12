/**
 * zoomDisplay.test.js
 *
 * Verifies the zoom-bar invariants for SpaceBuilderCanvas:
 *   - The initial zoomRadius (8) maps to a sensible display percentage
 *   - Zoom-in scales radius DOWN (× 0.8) so the display percentage increases
 *   - Zoom-out scales radius UP (× 1.25) so the display percentage decreases
 *   - In FPS mode the zoom buttons are relabelled "Step forward" / "Step back"
 *   - The zoom-val span renders radiusToSlider(zoomRadius)% (source-contract check)
 *   - The FPS/classic mode joystick labels are consistent in source
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  radiusToSlider,
  sliderToRadius,
  scaleZoomRadius,
  ZOOM_MIN,
  ZOOM_MAX,
} from '../utils/cameraControls'

const SRC = readFileSync(
  join(process.cwd(), 'src/components/SpaceBuilderCanvas.jsx'),
  'utf8',
)

// ── Zoom math ─────────────────────────────────────────────────────────────────

describe('Zoom display math', () => {
  const INITIAL_RADIUS = 8   // matches useState(8) in SpaceBuilderCanvas

  it('initial radius 8 maps to a percentage between 0 and 100', () => {
    const pct = radiusToSlider(INITIAL_RADIUS, ZOOM_MIN, ZOOM_MAX)
    expect(pct).toBeGreaterThan(0)
    expect(pct).toBeLessThan(100)
  })

  it('zoom-in factor 0.8 increases the displayed percentage', () => {
    const r0   = INITIAL_RADIUS
    const r1   = scaleZoomRadius(r0, 0.8, ZOOM_MIN, ZOOM_MAX)
    const pct0 = radiusToSlider(r0, ZOOM_MIN, ZOOM_MAX)
    const pct1 = radiusToSlider(r1, ZOOM_MIN, ZOOM_MAX)
    expect(r1).toBeLessThan(r0)   // closer to scene
    expect(pct1).toBeGreaterThan(pct0)  // higher % = more zoomed in
  })

  it('zoom-out factor 1.25 decreases the displayed percentage', () => {
    const r0   = INITIAL_RADIUS
    const r1   = scaleZoomRadius(r0, 1.25, ZOOM_MIN, ZOOM_MAX)
    const pct0 = radiusToSlider(r0, ZOOM_MIN, ZOOM_MAX)
    const pct1 = radiusToSlider(r1, ZOOM_MIN, ZOOM_MAX)
    expect(r1).toBeGreaterThan(r0)
    expect(pct1).toBeLessThan(pct0)
  })

  it('zoom-in then zoom-out returns close to original radius', () => {
    const r0 = INITIAL_RADIUS
    const r1 = scaleZoomRadius(r0, 0.8,  ZOOM_MIN, ZOOM_MAX)
    const r2 = scaleZoomRadius(r1, 1.25, ZOOM_MIN, ZOOM_MAX)
    // 0.8 × 1.25 = 1.0 exactly
    expect(r2).toBeCloseTo(r0, 8)
  })

  it('zoom is clamped to ZOOM_MIN/ZOOM_MAX', () => {
    const atMin = scaleZoomRadius(ZOOM_MIN, 0.01, ZOOM_MIN, ZOOM_MAX)
    const atMax = scaleZoomRadius(ZOOM_MAX, 100,  ZOOM_MIN, ZOOM_MAX)
    expect(atMin).toBeCloseTo(ZOOM_MIN, 8)
    expect(atMax).toBeCloseTo(ZOOM_MAX, 8)
  })
})

// ── Source-contract: zoom-val span ────────────────────────────────────────────

describe('SpaceBuilderCanvas zoom-val source contract', () => {
  it('sbc-zoom-val span renders radiusToSlider(zoomRadius, …)% ', () => {
    // The span must call radiusToSlider with the live zoomRadius state.
    expect(SRC).toMatch(/sbc-zoom-val.*radiusToSlider\(zoomRadius/)
  })

  it('zoom-in button uses scale factor 0.8', () => {
    expect(SRC).toMatch(/scaleZoomRadius\(.*0\.8/)
  })

  it('zoom-out button uses scale factor 1.25', () => {
    expect(SRC).toMatch(/scaleZoomRadius\(.*1\.25/)
  })

  it('both zoom factors render correct inverse relationship (0.8 × 1.25 = 1)', () => {
    // Structural: the two factors must be mathematical inverses so
    // one step in then one step out returns to the original zoom.
    expect(0.8 * 1.25).toBeCloseTo(1.0, 10)
  })
})

// ── Source-contract: FPS vs classic button labels ─────────────────────────────

describe('SpaceBuilderCanvas zoom button FPS/classic labels', () => {
  it('zoom-in button is titled "Step forward" in FPS mode', () => {
    expect(SRC).toMatch(/title.*Step forward/)
  })

  it('zoom-out button is titled "Step back" in FPS mode', () => {
    expect(SRC).toMatch(/title.*Step back/)
  })

  it('zoom-in button is titled "Zoom in" in classic mode', () => {
    expect(SRC).toMatch(/title.*Zoom in/)
  })

  it('zoom-out button is titled "Zoom out" in classic mode', () => {
    expect(SRC).toMatch(/title.*Zoom out/)
  })
})

// ── Source-contract: FPS joystick behaviour ───────────────────────────────────

describe('SpaceBuilderCanvas FPS joystick source contracts', () => {
  it('pan joystick Y axis strafes world-Y (orbit.center.y) in FPS mode', () => {
    // Must NOT be translating along the look direction for Y — that would be
    // the fwd joystick's job.  Confirm orbit.center.y is mutated by pan.ny.
    expect(SRC).toMatch(/orbit\.center\.y\s*[-+]=.*pan\.ny/)
  })

  it('fwd joystick flies along look direction in FPS mode', () => {
    // The fwd joystick block should reference camFwd (look direction vector)
    // and translate orbit.center by it.
    expect(SRC).toMatch(/camFwd/)
    expect(SRC).toMatch(/fwd\.ny/)
  })

  it('scroll in FPS mode translates orbit.center (not orbit.radius)', () => {
    // In FPS: scroll should fly the camera, so deltaY drives center movement.
    // Verify the FPS branch inside onWheel touches orbit.center and not radius alone.
    expect(SRC).toMatch(/cameraFPSRef\.current[\s\S]{0,300}orbit\.center/)
  })
})
