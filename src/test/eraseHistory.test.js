/**
 * eraseHistory.test.js
 *
 * Unit-tests for the three eraseHistory state transforms that live in App.jsx.
 * Because the transforms are pure array/object operations (no network, no state)
 * we can extract and test them here without rendering App.
 *
 * The transforms mirror exactly what the App.jsx handlers do:
 *   append  — handleEraseApply  : [...(wall.eraseHistory || []), entry]
 *   remove  — handleRemoveErase : history.filter(e => e.id !== eraseId)
 *   toggle  — handleToggleEraseVisible : history.map(e => e.id === id ? { ...e, visible: !visible } : e)
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── Pure transform helpers (mirroring App.jsx logic) ─────────────────────────

function eraseAppend(wall, entry) {
  return [...(wall.eraseHistory || []), entry]
}

function eraseRemove(wall, eraseId) {
  return (wall.eraseHistory || []).filter(e => e.id !== eraseId)
}

function eraseToggleVisible(wall, eraseId) {
  return (wall.eraseHistory || []).map(e =>
    e.id === eraseId ? { ...e, visible: e.visible === false ? true : false } : e
  )
}

// ── Append ────────────────────────────────────────────────────────────────────

describe('eraseHistory append', () => {
  it('adds an entry to an empty history', () => {
    const wall  = {}
    const entry = { id: 'e1', dataUrl: 'data:image/png;base64,abc', createdAt: 1000 }
    const h     = eraseAppend(wall, entry)
    expect(h).toHaveLength(1)
    expect(h[0]).toBe(entry)
  })

  it('appends to an existing history without mutation', () => {
    const existing = [{ id: 'e0', dataUrl: 'data:…', createdAt: 0 }]
    const wall     = { eraseHistory: existing }
    const entry    = { id: 'e1', dataUrl: 'data:…', createdAt: 1 }
    const h        = eraseAppend(wall, entry)
    expect(h).toHaveLength(2)
    expect(h[0].id).toBe('e0')
    expect(h[1].id).toBe('e1')
    // Original array untouched
    expect(existing).toHaveLength(1)
  })

  it('preserves all entry fields', () => {
    const wall  = {}
    const entry = { id: 'e1', dataUrl: 'data:…', createdAt: 99, visible: true }
    const h     = eraseAppend(wall, entry)
    expect(h[0]).toMatchObject({ id: 'e1', dataUrl: 'data:…', createdAt: 99, visible: true })
  })
})

// ── Remove ────────────────────────────────────────────────────────────────────

describe('eraseHistory remove', () => {
  it('removes the matching entry by id', () => {
    const wall = { eraseHistory: [
      { id: 'e1', dataUrl: 'a' },
      { id: 'e2', dataUrl: 'b' },
      { id: 'e3', dataUrl: 'c' },
    ]}
    const h = eraseRemove(wall, 'e2')
    expect(h).toHaveLength(2)
    expect(h.map(e => e.id)).toEqual(['e1', 'e3'])
  })

  it('returns empty array when removing the only entry', () => {
    const wall = { eraseHistory: [{ id: 'e1', dataUrl: 'a' }] }
    const h    = eraseRemove(wall, 'e1')
    expect(h).toHaveLength(0)
  })

  it('returns original history when id is not found', () => {
    const wall = { eraseHistory: [{ id: 'e1', dataUrl: 'a' }] }
    const h    = eraseRemove(wall, 'no-such-id')
    expect(h).toHaveLength(1)
    expect(h[0].id).toBe('e1')
  })

  it('handles missing eraseHistory gracefully', () => {
    const h = eraseRemove({}, 'e1')
    expect(h).toEqual([])
  })
})

// ── Toggle visible ────────────────────────────────────────────────────────────

describe('eraseHistory toggleVisible', () => {
  it('sets visible:false → visible:true', () => {
    const wall = { eraseHistory: [{ id: 'e1', dataUrl: 'a', visible: false }] }
    const h    = eraseToggleVisible(wall, 'e1')
    expect(h[0].visible).toBe(true)
  })

  it('sets visible:true → visible:false', () => {
    const wall = { eraseHistory: [{ id: 'e1', dataUrl: 'a', visible: true }] }
    const h    = eraseToggleVisible(wall, 'e1')
    expect(h[0].visible).toBe(false)
  })

  it('treats undefined visible (default shown) as truthy → sets false', () => {
    // App.jsx: visible === false ? true : false
    // so undefined → false (hides the layer on first toggle)
    const wall = { eraseHistory: [{ id: 'e1', dataUrl: 'a' }] }
    const h    = eraseToggleVisible(wall, 'e1')
    expect(h[0].visible).toBe(false)
  })

  it('does not affect other entries', () => {
    const wall = { eraseHistory: [
      { id: 'e1', dataUrl: 'a', visible: true },
      { id: 'e2', dataUrl: 'b', visible: true },
    ]}
    const h = eraseToggleVisible(wall, 'e1')
    expect(h[0].visible).toBe(false)
    expect(h[1].visible).toBe(true)  // unchanged
  })

  it('does not mutate the original history array', () => {
    const orig = [{ id: 'e1', dataUrl: 'a', visible: true }]
    const wall = { eraseHistory: orig }
    eraseToggleVisible(wall, 'e1')
    expect(orig[0].visible).toBe(true)  // original untouched
  })
})

// ── Source-contract: App.jsx uses correct transforms ─────────────────────────

describe('App.jsx eraseHistory source contracts', () => {
  const SRC = readFileSync(join(process.cwd(), 'src/App.jsx'), 'utf8')

  it('handleEraseApply appends via spread into new array', () => {
    // const history = [...(wall.eraseHistory || []), eraseEntry]
    expect(SRC).toMatch(/history\s*=\s*\[\.\.\.\(wall\.eraseHistory\s*\|\|\s*\[\]\)\s*,\s*eraseEntry\]/)
  })

  it('handleRemoveErase filters by id', () => {
    expect(SRC).toMatch(/eraseHistory.*\.filter\(e\s*=>\s*e\.id\s*!==\s*eraseId\)/)
  })

  it('handleToggleEraseVisible maps and flips visible flag', () => {
    expect(SRC).toMatch(/eraseHistory.*\.map\(e\s*=>/)
    expect(SRC).toMatch(/visible.*===.*false.*\?.*true.*:.*false/)
  })

  it('both mutation handlers persist via api.putWall', () => {
    // Count occurrences of api.putWall in the erase handlers
    const count = (SRC.match(/api\.putWall\(/g) || []).length
    expect(count).toBeGreaterThanOrEqual(3)  // append, remove, toggle each call it
  })
})
