/**
 * 3D Room data model and geometry helpers.
 *
 * A Room is a rectangular prism (box) with up to 6 decoratable Surfaces:
 * north wall, south wall, east wall, west wall, floor, and ceiling.
 *
 * Coordinate system (Three.js convention):
 *   +X = east   -X = west
 *   +Y = up     -Y = down
 *   +Z = south  -Z = north
 *
 * Camera lives at room center (0, 0, 0) looking in any direction.
 */

// ── Face IDs ────────────────────────────────────────────────────────────────
export const FACES = ['north', 'south', 'east', 'west', 'floor', 'ceiling']

/**
 * Metadata per face:
 *  label     - display name
 *  role      - 'wall' | 'floor' | 'ceiling'
 *  widthKey  - which room dimension is the face's width axis
 *  heightKey - which room dimension is the face's height axis
 *  icon      - emoji for UI
 */
export const FACE_META = {
  north:   { label: 'North Wall', shortLabel: 'N Wall', role: 'wall',    widthKey: 'roomWidth',  heightKey: 'roomHeight', icon: '🧱' },
  south:   { label: 'South Wall', shortLabel: 'S Wall', role: 'wall',    widthKey: 'roomWidth',  heightKey: 'roomHeight', icon: '🧱' },
  east:    { label: 'East Wall',  shortLabel: 'E Wall', role: 'wall',    widthKey: 'roomDepth',  heightKey: 'roomHeight', icon: '🧱' },
  west:    { label: 'West Wall',  shortLabel: 'W Wall', role: 'wall',    widthKey: 'roomDepth',  heightKey: 'roomHeight', icon: '🧱' },
  floor:   { label: 'Floor',      shortLabel: 'Floor',  role: 'floor',   widthKey: 'roomWidth',  heightKey: 'roomDepth',  icon: '⬜' },
  ceiling: { label: 'Ceiling',    shortLabel: 'Ceil',   role: 'ceiling', widthKey: 'roomWidth',  heightKey: 'roomDepth',  icon: '🔲' },
}

const INCH_TO_M = 0.0254

/**
 * Get the physical dimensions (in inches) of a face given the room object.
 */
export function getFaceDimsIn(faceId, room) {
  const meta = FACE_META[faceId]
  return {
    widthIn:  room[meta.widthKey],
    heightIn: room[meta.heightKey],
  }
}

/**
 * Get the Three.js world geometry for a face.
 * Returns { position: [x,y,z], rotX, rotY, wM, hM }
 *
 * Each face is a PlaneGeometry centered at `position`, rotated so its
 * front (+Z normal in local space) faces the interior of the room.
 *
 * Camera at origin (0,0,0) — all faces must face the center.
 */
export function getFaceGeometry(faceId, room) {
  const hw = (room.roomWidth  * INCH_TO_M) / 2  // half-width  (x)
  const hh = (room.roomHeight * INCH_TO_M) / 2  // half-height (y)
  const hd = (room.roomDepth  * INCH_TO_M) / 2  // half-depth  (z)

  const wM = room[FACE_META[faceId].widthKey]  * INCH_TO_M
  const hM = room[FACE_META[faceId].heightKey] * INCH_TO_M

  // face data: [pos_x, pos_y, pos_z, rotX, rotY]
  const GEO = {
    // North wall: at -Z, PlaneGeometry default faces +Z → faces interior ✓
    north:   { position: [ 0,   0,  -hd], rotX: 0,            rotY: 0            },
    // South wall: at +Z, rotate Y 180° so it faces -Z (interior) ✓
    south:   { position: [ 0,   0,  +hd], rotX: 0,            rotY: Math.PI      },
    // East wall:  at +X, rotate Y -90° so it faces -X (interior) ✓
    east:    { position: [+hw,  0,   0 ], rotX: 0,            rotY: -Math.PI / 2 },
    // West wall:  at -X, rotate Y +90° so it faces +X (interior) ✓
    west:    { position: [-hw,  0,   0 ], rotX: 0,            rotY:  Math.PI / 2 },
    // Floor:      at -Y, rotate X +90° so it faces +Y (up, interior) ✓
    floor:   { position: [ 0,  -hh,  0 ], rotX:  Math.PI / 2, rotY: 0            },
    // Ceiling:    at +Y, rotate X -90° so it faces -Y (down, interior) ✓
    ceiling: { position: [ 0,  +hh,  0 ], rotX: -Math.PI / 2, rotY: 0            },
  }

  return { ...GEO[faceId], wM, hM }
}

/**
 * Convert a piece's 2D position on a face to a 3D world position.
 *
 * pieceX, pieceY: top-left corner in inches within the face
 * pieceW, pieceH: piece dimensions in inches
 *
 * Returns { x, y, z, rotX, rotY, pwM, phM } (position & rotation matching the face)
 */
export function pieceToWorld(faceId, pieceX, pieceY, pieceW, pieceH, room) {
  const faceMeta = FACE_META[faceId]
  const faceWIn  = room[faceMeta.widthKey]
  const faceHIn  = room[faceMeta.heightKey]

  // Center of piece in face-local normalized coords (-0.5 to +0.5)
  const u = (pieceX + pieceW / 2) / faceWIn - 0.5
  const v = 0.5 - (pieceY + pieceH / 2) / faceHIn

  const hw = (room.roomWidth  * INCH_TO_M) / 2
  const hh = (room.roomHeight * INCH_TO_M) / 2
  const hd = (room.roomDepth  * INCH_TO_M) / 2

  const faceW = faceWIn * INCH_TO_M
  const faceH = faceHIn * INCH_TO_M
  const lx = u * faceW   // local X offset
  const ly = v * faceH   // local Y offset

  const EPS = 0.002 // 2 mm offset to avoid z-fighting

  // Local (lx, ly) → world (x, y, z) per face
  const worldPos = {
    north:   [ lx,  ly, -hd - EPS],
    south:   [-lx,  ly, +hd + EPS],
    east:    [+hw + EPS,  ly, -lx],
    west:    [-hw - EPS,  ly,  lx],
    floor:   [ lx, -hh - EPS,  ly],
    ceiling: [ lx, +hh + EPS, -ly],
  }

  const { rotX, rotY } = getFaceGeometry(faceId, room)
  const [x, y, z] = worldPos[faceId]
  const pwM = pieceW * INCH_TO_M
  const phM = pieceH * INCH_TO_M

  return { x, y, z, rotX, rotY, pwM, phM }
}

// ── Object factories ────────────────────────────────────────────────────────

/**
 * Create an empty Surface for a given face.
 */
export function createSurface(faceId) {
  return {
    faceId,
    photoUrl:       null,   // original photo (for re-cropping)
    warpedImageUrl: null,   // perspective-corrected image shown in viewer
    warpCorners:    [[0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95]],
    pieces:         [],
    paintLayers:    {},
    enabled:        false,  // false = surface not yet set up
  }
}

/**
 * Create a new Room with default values.
 * roomWidth  = room width  in inches (x axis)
 * roomHeight = room height in inches (y axis, floor-to-ceiling)
 * roomDepth  = room depth  in inches (z axis)
 */
export function createRoom({ id, name, roomWidth = 144, roomHeight = 96, roomDepth = 144 }) {
  const surfaces = {}
  FACES.forEach(fid => { surfaces[fid] = createSurface(fid) })
  return {
    id,
    name,
    roomWidth,
    roomHeight,
    roomDepth,
    surfaces,
    createdAt: Date.now(),
  }
}
