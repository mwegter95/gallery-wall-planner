/**
 * SpaceBuilder data model and 3D assembly algorithm.
 *
 * A "Space" is a freeform collection of named surfaces (up to 12) defined by
 * perspective-warp handles on one or more source photos, connected by named
 * edges at user-specified dihedral angles.
 *
 * Assembly: BFS from surface[0], folding connected surfaces around shared edges
 * using the dihedral (interior) angle to compute each child's world transform.
 */

// ── Visual palette ──────────────────────────────────────────────────────────
export const SURFACE_COLORS = [
  '#4a9eff', '#ff6b6b', '#51cf66', '#ffd43b', '#cc5de8',
  '#ff922b', '#20c997', '#f06595', '#74c0fc', '#a9e34b',
  '#e64980', '#94d82d',
]

// ── ID generator ─────────────────────────────────────────────────────────────
export function genId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

// ── Data factories ────────────────────────────────────────────────────────────

/** Create a new Space object */
export function createSpace({ id, name } = {}) {
  return {
    id:       id   || genId(),
    name:     name || 'New Space',
    roomType: 'space',
    photos:   [],  // [PhotoDef]
    surfaces: [],  // [SurfaceDef]
  }
}

/**
 * Create a PhotoDef entry.
 * @param {string} dataUrl    – raw data URL of the photo
 * @param {number} displayW   – display width in canvas pixels
 * @param {number} displayH   – display height in canvas pixels
 * @param {number} index      – order index (for stagger + zIndex)
 */
export function createPhoto({ dataUrl, displayW = 700, displayH = 500, index = 0 } = {}) {
  return {
    id:       genId(),
    dataUrl,
    x:        60 + index * 24,
    y:        60 + index * 24,
    displayW,
    displayH,
    zIndex:   index,
  }
}

/**
 * Create a SurfaceDef.
 * Corners stored as [0-1] fractions of the photo's displayW / displayH.
 *
 * connections: each edge maps to null | { surfaceId, edge, angleDeg }
 *   where angleDeg is the interior dihedral angle (90 = square room corner).
 */
export function createSurfaceDef({ photoId = null, index = 0 } = {}) {
  const m = 0.20
  return {
    id:       genId(),
    name:     `Surface ${index + 1}`,
    photoId,
    widthIn:  96,
    heightIn: 96,
    corners: {
      tl: [m,     m    ],
      tr: [1 - m, m    ],
      bl: [m,     1 - m],
      br: [1 - m, 1 - m],
    },
    warpedDataUrl: null,
    colorIdx:      index % SURFACE_COLORS.length,
    rotYDeg:       0,   // manual 3D rotation around Y axis (degrees)
    connections: {
      top:    null,  // null | { surfaceId, edge, angleDeg }
      bottom: null,
      left:   null,
      right:  null,
    },
  }
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

/**
 * Convert surface corners from fractions to canvas pixel coordinates.
 * photo: { x, y, displayW, displayH }
 */
export function cornersToCanvas(corners, photo) {
  const toAbs = ([fx, fy]) => [
    photo.x + fx * photo.displayW,
    photo.y + fy * photo.displayH,
  ]
  return {
    tl: toAbs(corners.tl),
    tr: toAbs(corners.tr),
    bl: toAbs(corners.bl),
    br: toAbs(corners.br),
  }
}

/** Centroid of a canvas-coord corners object */
export function cornersCentroid(cc) {
  return [
    (cc.tl[0] + cc.tr[0] + cc.bl[0] + cc.br[0]) / 4,
    (cc.tl[1] + cc.tr[1] + cc.bl[1] + cc.br[1]) / 4,
  ]
}

/** Euclidean distance between two 2D points */
function dist2d([ax, ay], [bx, by]) {
  return Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2)
}

/**
 * Find if any corner of any other surface is within `threshold` px of the
 * given surface+corner.  Returns { surfaceId, corner } or null.
 */
export function findSnapTarget(surfaces, photos, activeSurfId, activeCorner, threshold = 18) {
  const activeS     = surfaces.find(s => s.id === activeSurfId)
  if (!activeS) return null
  const activePhoto = photos.find(p => p.id === activeS.photoId)
  if (!activePhoto) return null
  const activeCC    = cornersToCanvas(activeS.corners, activePhoto)
  const activePt    = activeCC[activeCorner]

  for (const s of surfaces) {
    if (s.id === activeSurfId) continue
    const photo = photos.find(p => p.id === s.photoId)
    if (!photo) continue
    const cc = cornersToCanvas(s.corners, photo)
    for (const corner of ['tl', 'tr', 'bl', 'br']) {
      if (dist2d(activePt, cc[corner]) < threshold) {
        return { surfaceId: s.id, corner }
      }
    }
  }
  return null
}

// ── Perspective warp ──────────────────────────────────────────────────────────

/**
 * Apply perspective correction to one surface, returning a data URL.
 * Uses the warpPerspectiveAsync function from homography.js.
 *
 * @param {object}   surface       – SurfaceDef (corners as fractions)
 * @param {string}   photoDataUrl  – source photo data URL
 * @param {number}   displayW      – photo display width (fractions are relative to this)
 * @param {number}   displayH      – photo display height
 * @param {Function} warpFn        – warpPerspectiveAsync from homography.js
 * @returns {Promise<string>}       – data URL of the warped image
 */
export function warpSurface(surface, photoDataUrl, displayW, displayH, warpFn) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = async () => {
      const scaleX = img.naturalWidth  / displayW
      const scaleY = img.naturalHeight / displayH
      const c = surface.corners

      // warpPerspectiveAsync expects: [[tl],[tr],[br],[bl]] in source image pixels
      const srcCorners = [
        [c.tl[0] * img.naturalWidth,  c.tl[1] * img.naturalHeight],
        [c.tr[0] * img.naturalWidth,  c.tr[1] * img.naturalHeight],
        [c.br[0] * img.naturalWidth,  c.br[1] * img.naturalHeight],
        [c.bl[0] * img.naturalWidth,  c.bl[1] * img.naturalHeight],
      ]

      const aspect = surface.widthIn / Math.max(1, surface.heightIn)
      const OUT_H  = 600
      const OUT_W  = Math.round(OUT_H * aspect)

      try {
        const dataUrl = await warpFn(img, srcCorners, OUT_W, OUT_H, () => {})
        resolve(dataUrl)
      } catch (e) {
        reject(e)
      }
    }
    img.onerror = reject
    img.src = photoDataUrl
  })
}

// ── 3D Assembly ───────────────────────────────────────────────────────────────

const IN_TO_M = 0.0254
const PI      = Math.PI

/**
 * Right-direction vector of a plane with rotation (rotX=0, rotY).
 * In Three.js, PlaneGeometry's local +X after rotY:
 *   R = (cos(rotY), 0, -sin(rotY))
 */
function rightVec(rotY) {
  return [Math.cos(rotY), 0, -Math.sin(rotY)]
}

/** Normalize an angle to [-PI, PI] */
function normalizeAngle(a) {
  while (a >  PI) a -= 2 * PI
  while (a < -PI) a += 2 * PI
  return a
}

/**
 * Compute the world placement of a child surface given a connection from parent.
 *
 * For horizontal (wall-to-wall) connections:
 *   rotY_child = rotY_parent − dir × (PI − theta)
 *   P_child    = edgeMidpoint + R_child × (cW/2)
 *
 * Interior angle theta: 90° = square room corner, 180° = coplanar, <90° = acute corner.
 *
 * @param {object} parentP   – parent placement { position, rotY, wM, hM }
 * @param {string} parentEdge – 'left'|'right'|'top'|'bottom'
 * @param {object} child      – SurfaceDef
 * @param {string} childEdge  – 'left'|'right'|'top'|'bottom'
 * @param {number} angleDeg   – interior dihedral angle in degrees
 */
function computeChildPlacement(parentP, parentEdge, child, childEdge, angleDeg) {
  const theta  = (angleDeg ?? 90) * PI / 180
  const [px, py, pz] = parentP.position
  const pRotY  = parentP.rotY
  const pW     = parentP.wM
  const pH     = parentP.hM
  const cW     = child.widthIn  * IN_TO_M
  const cH     = child.heightIn * IN_TO_M
  const Rp     = rightVec(pRotY)

  let cx = px, cy = py, cz = pz, cRotY = pRotY

  if ((parentEdge === 'right' && childEdge === 'left') ||
      (parentEdge === 'left'  && childEdge === 'right')) {
    const dir = parentEdge === 'right' ? 1 : -1
    // Edge midpoint in world space
    const ex = px + Rp[0] * dir * pW / 2
    const ez = pz + Rp[2] * dir * pW / 2
    // Fold child: each CW step reduces rotY by (PI - theta)
    cRotY = normalizeAngle(pRotY - dir * (PI - theta))
    const Rc  = rightVec(cRotY)
    const cDir = childEdge === 'left' ? 1 : -1
    cx = ex + Rc[0] * cDir * cW / 2
    cz = ez + Rc[2] * cDir * cW / 2
    cy = py

  } else if ((parentEdge === 'bottom' && childEdge === 'top') ||
             (parentEdge === 'top'    && childEdge === 'bottom')) {
    // Vertical: floor/ceiling connections
    const dir = parentEdge === 'bottom' ? -1 : 1
    cy = py + dir * pH / 2 + dir * cH / 2
    cx = px; cz = pz
    cRotY = pRotY
  }

  return {
    surfaceId:     child.id,
    name:          child.name,
    warpedDataUrl: child.warpedDataUrl,
    colorIdx:      child.colorIdx,
    position:      [cx, cy, cz],
    rotX:          0,
    rotY:          cRotY,
    wM:            cW,
    hM:            cH,
  }
}

/**
 * Assemble all surfaces into 3D placements for the Three.js viewer.
 *
 * Returns: Array<{
 *   surfaceId, name, warpedDataUrl, colorIdx,
 *   position: [x,y,z], rotX, rotY, wM, hM
 * }>
 */
export function assembleSurfaces(surfaces) {
  if (!surfaces.length) return []

  const placements = new Map()
  const visited    = new Set()

  // ── Place first surface at origin, facing +Z ──────────────────────────────
  const first = surfaces[0]
  const p0 = {
    surfaceId:     first.id,
    name:          first.name,
    warpedDataUrl: first.warpedDataUrl,
    colorIdx:      first.colorIdx,
    position:      [0, 0, 0],
    rotX:          0,
    rotY:          (first.rotYDeg ?? 0) * PI / 180,
    wM:            first.widthIn  * IN_TO_M,
    hM:            first.heightIn * IN_TO_M,
  }
  placements.set(first.id, p0)
  visited.add(first.id)

  // ── BFS through connections ───────────────────────────────────────────────
  const queue = [first.id]
  while (queue.length) {
    const parentId = queue.shift()
    const parentP  = placements.get(parentId)
    const parent   = surfaces.find(s => s.id === parentId)
    if (!parent) continue

    for (const [parentEdge, conn] of Object.entries(parent.connections)) {
      if (!conn || visited.has(conn.surfaceId)) continue
      const child = surfaces.find(s => s.id === conn.surfaceId)
      if (!child) continue
      const childP = computeChildPlacement(
        parentP, parentEdge, child, conn.edge, conn.angleDeg ?? 90
      )
      placements.set(child.id, childP)
      visited.add(child.id)
      queue.push(child.id)
    }
  }

  // ── Float unconnected surfaces in a row behind first ─────────────────────
  let rowX = 0
  for (const p of placements.values()) rowX = Math.max(rowX, p.position[0] + p.wM / 2)
  rowX += 0.4

  for (const s of surfaces) {
    if (visited.has(s.id)) continue
    const wM = s.widthIn  * IN_TO_M
    const hM = s.heightIn * IN_TO_M
    placements.set(s.id, {
      surfaceId:     s.id,
      name:          s.name,
      warpedDataUrl: s.warpedDataUrl,
      colorIdx:      s.colorIdx,
      position:      [rowX + wM / 2, 0, 0],
      rotX:          0,
      rotY:          (s.rotYDeg ?? 0) * PI / 180,
      wM,
      hM,
    })
    rowX += wM + 0.15
  }

  return Array.from(placements.values())
}
