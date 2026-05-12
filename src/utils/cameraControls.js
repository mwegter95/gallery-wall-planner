export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 80

export function radiusToSlider(radius, min = ZOOM_MIN, max = ZOOM_MAX) {
  return Math.round(
    (Math.log(radius) - Math.log(min)) / (Math.log(max) - Math.log(min)) * 100
  )
}

export function sliderToRadius(value, min = ZOOM_MIN, max = ZOOM_MAX) {
  return Math.exp(Math.log(min) + (value / 100) * (Math.log(max) - Math.log(min)))
}

export function scaleZoomRadius(radius, scale, min = ZOOM_MIN, max = ZOOM_MAX) {
  return Math.max(min, Math.min(max, radius * scale))
}

export function applyOrbitJoystickStep(orbit, joyX, joyY, speed) {
  if (!orbit) return false
  if (!joyX && !joyY) return false
  orbit.theta -= joyX * speed
  orbit.phi   -= joyY * speed   // inverted: joystick-up (joyY<0) → phi increases → look down; user confirmed this feels correct
  return true
}
