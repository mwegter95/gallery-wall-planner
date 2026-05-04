/** Unit conversion helpers for imperial ↔ metric display.
 *
 * Internal storage is ALWAYS in inches. These helpers only affect
 * what the user sees and types — never the stored data.
 */

export const INCH_TO_CM = 2.54

/** Inches → centimetres (rounded to 1 decimal) */
export const inToCm = (inches) => Math.round(inches * INCH_TO_CM * 10) / 10

/** Centimetres → inches */
export const cmToIn = (cm) => cm / INCH_TO_CM

/** Round cm to the nearest integer for clean display */
export const inToCmInt = (inches) => Math.round(inches * INCH_TO_CM)

// ── Dimension labels ─────────────────────────────────────────────────

/**
 * Format a dimension (stored in inches) for display.
 * Imperial: `16"` · Metric: `41 cm`
 */
export function fmtDim(inches, unit) {
  if (unit === 'metric') return `${inToCmInt(inches)} cm`
  return `${inches}"`
}

/**
 * Format a dimension pair for display.
 * Imperial: `16" × 20"` · Metric: `41 × 51 cm`
 */
export function fmtDimPair(w, h, unit) {
  if (unit === 'metric') return `${inToCmInt(w)} × ${inToCmInt(h)} cm`
  return `${w}" × ${h}"`
}

/**
 * Format wall dimensions including feet/meters shorthand.
 * Imperial: `144" × 96"  (12′ × 8′)`
 * Metric:   `366 × 244 cm  (3.7 × 2.4 m)`
 */
export function fmtWallDims(w, h, unit) {
  if (unit === 'metric') {
    const wCm = inToCmInt(w), hCm = inToCmInt(h)
    const wM  = (wCm / 100).toFixed(1), hM = (hCm / 100).toFixed(1)
    return `${wCm} × ${hCm} cm  (${wM} × ${hM} m)`
  }
  return `${w}" × ${h}"  (${(w/12).toFixed(1)}′ × ${(h/12).toFixed(1)}′)`
}

// ── Ruler labels ─────────────────────────────────────────────────────

/**
 * Compact label for a ruler tick at `inches` from origin.
 * Imperial: `12' 6"` · Metric: `50` (cm, no unit) or `1m` at 100cm multiples
 */
export function fmtRulerLabel(inches, unit) {
  if (unit === 'metric') {
    const cm = inToCmInt(inches)
    if (cm === 0) return '0'
    if (cm % 100 === 0) return `${cm / 100}m`
    return `${cm}`
  }
  const ft = Math.floor(inches / 12)
  const i  = Math.round(inches % 12)
  if (i === 0) return `${ft}'`
  return `${ft}' ${i}"`
}

// ── Grid / snap intervals ─────────────────────────────────────────────

/**
 * Minor grid interval in inches for each unit system.
 * Imperial: 1 inch · Metric: 10 cm
 */
export const MINOR_GRID = { imperial: 1, metric: 2 / INCH_TO_CM }

/**
 * Major grid interval in inches for each unit system.
 * Imperial: 12 inches (1 foot) · Metric: 100 cm (1 metre)
 */
export const MAJOR_GRID = { imperial: 12, metric: 100 / INCH_TO_CM }

/**
 * Ruler tick interval in inches for each unit system.
 * Imperial: 12 inches · Metric: 50 cm
 */
export const RULER_TICK = { imperial: 12, metric: 50 / INCH_TO_CM }

// ── Snap size display / input ─────────────────────────────────────────

/** Display the snap grid size in the current unit (inches or cm, integer). */
export function displayGridSize(gridSizeInches, unit) {
  if (unit === 'metric') return Math.round(gridSizeInches * INCH_TO_CM)
  return gridSizeInches
}

/** Convert a user-typed snap size back to inches for storage. */
export function inputGridSize(value, unit) {
  if (unit === 'metric') return value / INCH_TO_CM
  return value
}

/** Sensible default snap size in inches for each unit system. */
export const DEFAULT_SNAP = { imperial: 4, metric: 10 / INCH_TO_CM }

/** Snap options displayed to the user (in their unit). */
export const SNAP_OPTIONS = {
  imperial: [1, 2, 4, 6, 12],   // inches
  metric:   [2, 5, 10, 20, 50],  // cm
}
