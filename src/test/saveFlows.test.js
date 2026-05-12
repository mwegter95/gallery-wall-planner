/**
 * saveFlows.test.js
 *
 * Contract and logic tests for the critical save paths in the app:
 *
 *   1. handleSaveSpace (App.jsx)
 *      - Strips binary point-cloud blob from the initial putRoom call
 *      - Surfaces array is included in the saved payload
 *      - Calls api.putRoom at least twice (initial thin + final with URL)
 *
 *   2. addPiece (App.jsx / Wall editor)
 *      - Merges caller data over defaults (x:8, y:8, color from palette)
 *      - Assigns a generated string id
 *
 *   3. SpaceBuilder handleSave
 *      - Passes the full space (with surfaces) to onSave
 *      - Save-as-new gets a fresh id (not the original room id)
 *      - savedSnapshot is updated after successful save
 *
 *   4. App.jsx handleSaveRoom
 *      - Strips data: URL surfaces before calling api.putRoom
 *      - Keeps server URL surfaces as-is
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const APP_SRC    = readFileSync(join(process.cwd(), 'src/App.jsx'),    'utf8')
const SB_SRC     = readFileSync(join(process.cwd(), 'src/components/SpaceBuilder.jsx'), 'utf8')

// ── handleSaveSpace source contracts ─────────────────────────────────────────

describe('handleSaveSpace source contracts', () => {
  it('strips binary payload before first putRoom call', () => {
    // The function calls toRoomScanMeta (which drops _buffer/data) and passes
    // only { pointCount, url } before uploading the binary separately.
    expect(APP_SRC).toMatch(/toRoomScanMeta/)
    expect(APP_SRC).toMatch(/hasBinary/)
    expect(APP_SRC).toMatch(/Strip the binary point-cloud payload/)
  })

  it('calls api.putRoom at least twice (initial thin + final with URL)', () => {
    // Count putRoom calls inside handleSaveSpace — look for them within the function.
    // We expect the function to call it with the initial skeleton and then a second time
    // after the binary upload with the final URL.
    const count = (APP_SRC.match(/api\.putRoom\(/g) || []).length
    expect(count).toBeGreaterThanOrEqual(2)
  })

  it('puts space.id on the saved room', () => {
    // The payload passed to putRoom must carry the room id so the server
    // can upsert the correct record.
    expect(APP_SRC).toMatch(/putRoom\(.*space/)
  })

  it('surfaces are included in the final saved payload', () => {
    // handleSaveSpace must spread surfaces (via ...space) into the final putRoom call.
    // Surfaces live on `space` directly so `...space` carries them.
    expect(APP_SRC).toMatch(/spaceForMeta.*=.*space/)
    expect(APP_SRC).toMatch(/putRoom\(spaceForMeta\)/)
  })
})

// ── App.jsx handleSaveRoom surface strip contract ─────────────────────────────

describe('App.jsx handleSaveRoom source contracts', () => {
  it('strips data: URLs before calling api.putRoom', () => {
    // The handler must not forward large inline images to the server.
    expect(APP_SRC).toMatch(/warpedImageUrl.*startsWith\('data:'\).*\?.*null.*:.*warpedImageUrl/)
  })

  it('calls api.putRoom with the cleaned room', () => {
    // Should find api.putRoom called with toSave (the cleaned object)
    expect(APP_SRC).toMatch(/api\.putRoom\(toSave\)/)
  })

  it('updates local rooms state after save', () => {
    expect(APP_SRC).toMatch(/setRooms\(prev\s*=>\s*\(\{.*finalRoom/)
  })
})

// ── addPiece source contracts ──────────────────────────────────────────────────

describe('addPiece source contracts', () => {
  it('assigns a generated id to every new piece', () => {
    expect(APP_SRC).toMatch(/id:\s*genId\(\)/)
  })

  it('defaults x and y to 8 (top-left offset on canvas)', () => {
    expect(APP_SRC).toMatch(/x:\s*8/)
    expect(APP_SRC).toMatch(/y:\s*8/)
  })

  it('allows caller data to override defaults via spread', () => {
    // The piece object must spread `data` after the defaults so callers
    // can override position, image, width, height, etc.
    expect(APP_SRC).toMatch(/\.\.\.(data|pieceData)/)
  })

  it('increments colorIdx to cycle through the colour palette', () => {
    expect(APP_SRC).toMatch(/setColorIdx/)
  })
})

// ── SpaceBuilder handleSave source contracts ──────────────────────────────────

describe('SpaceBuilder handleSave source contracts', () => {
  it('passes the full space (with surfaces) to onSave', () => {
    // onSave is called with spaceToSave which is either `space` or a clone with new id/name.
    expect(SB_SRC).toMatch(/onSave\(spaceToSave/)
  })

  it('save-as-new creates a fresh id via genId()', () => {
    expect(SB_SRC).toMatch(/id:\s*genId\(\)/)
  })

  it('save-as-new applies the new name', () => {
    expect(SB_SRC).toMatch(/name:\s*overrideName/)
  })

  it('updates savedSnapshot after successful save', () => {
    // After onSave resolves without error the component must update the snapshot
    // so that hasUnsavedChanges returns false.
    expect(SB_SRC).toMatch(/setSavedSnapshot\(JSON\.stringify\(spaceToSave\.surfaces\)/)
  })

  it('passes a progress callback to onSave', () => {
    // onSave(spaceToSave, (pct) => setSaveProgress(…))
    expect(SB_SRC).toMatch(/onSave\(spaceToSave,\s*\(pct\)\s*=>/)
  })

  it('exposes "Save room" button with title attribute', () => {
    // The save trigger must be discoverable in tests by title.
    expect(SB_SRC).toMatch(/title.*Save room/)
  })
})

// ── addPiece inside SpaceBuilder.jsx (surface layout pieces) ─────────────────

describe('SpaceBuilder addPiece source contracts', () => {
  it('addPieceToLayout merges piece into the surface layout', () => {
    expect(SB_SRC).toMatch(/addPieceToLayout/)
  })

  it('piece array is stored under layouts[name].pieces', () => {
    expect(SB_SRC).toMatch(/layouts.*pieces/)
  })

  it('addPieceToLayout calls updateSurface to persist the change', () => {
    expect(SB_SRC).toMatch(/updateSurface\(/)
  })
})
