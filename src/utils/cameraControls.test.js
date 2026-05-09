import { describe, expect, it } from 'vitest'
import {
  applyOrbitJoystickStep,
  radiusToSlider,
  scaleZoomRadius,
  sliderToRadius,
  ZOOM_MIN,
  ZOOM_MAX,
} from './cameraControls'

describe('cameraControls', () => {
  it('inverts joystick Y relative to drag by applying +joyY to phi', () => {
    const orbit = { theta: 1, phi: 1 }
    // Joystick up reports negative y; phi should decrease.
    const changed = applyOrbitJoystickStep(orbit, 0, -1, 0.1)
    expect(changed).toBe(true)
    expect(orbit.phi).toBeCloseTo(0.9, 6)
    expect(orbit.theta).toBeCloseTo(1, 6)
  })

  it('maps slider->radius->slider consistently', () => {
    const values = [0, 10, 25, 50, 75, 100]
    for (const value of values) {
      const radius = sliderToRadius(value, ZOOM_MIN, ZOOM_MAX)
      const roundTrip = radiusToSlider(radius, ZOOM_MIN, ZOOM_MAX)
      expect(roundTrip).toBeCloseTo(value, 0)
    }
  })

  it('keeps radius bounds sane', () => {
    const nearMin = sliderToRadius(0, ZOOM_MIN, ZOOM_MAX)
    const nearMax = sliderToRadius(100, ZOOM_MIN, ZOOM_MAX)
    expect(nearMin).toBeCloseTo(ZOOM_MIN, 8)
    expect(nearMax).toBeCloseTo(ZOOM_MAX, 8)
  })

  it('clamps scaled zoom radius to configured bounds', () => {
    expect(scaleZoomRadius(1, 0.01, ZOOM_MIN, ZOOM_MAX)).toBeCloseTo(ZOOM_MIN, 8)
    expect(scaleZoomRadius(40, 10, ZOOM_MIN, ZOOM_MAX)).toBeCloseTo(ZOOM_MAX, 8)
    expect(scaleZoomRadius(10, 0.8, ZOOM_MIN, ZOOM_MAX)).toBeCloseTo(8, 8)
  })

  it('applies proportional joystick speed curve', () => {
    const base = { theta: 1, phi: 1 }
    const slow = { ...base }
    const fast = { ...base }

    applyOrbitJoystickStep(slow, 0.5, -0.5, 0.01)
    applyOrbitJoystickStep(fast, 0.5, -0.5, 0.03)

    const slowDelta = Math.abs(slow.theta - base.theta)
    const fastDelta = Math.abs(fast.theta - base.theta)
    expect(fastDelta).toBeGreaterThan(slowDelta)
    expect(fastDelta / slowDelta).toBeCloseTo(3, 5)
  })
})
