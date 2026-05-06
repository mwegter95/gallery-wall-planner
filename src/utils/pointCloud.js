/**
 * pointCloud.js — Utilities for accumulating and serializing a colored 3D
 * point cloud captured via WebXR depth-sensing + camera-access.
 *
 * Points are stored as interleaved Float32Arrays: [x, y, z, r, g, b, ...]
 * where r/g/b are 0-1 floats.
 */

const FLOATS_PER_POINT = 6  // x, y, z, r, g, b

/** Mutable accumulator — grows a typed array block by block. */
export class PointCloudBuffer {
  constructor(initialCapacity = 200_000) {
    this._cap  = initialCapacity
    this._len  = 0   // number of POINTS currently stored
    this._data = new Float32Array(initialCapacity * FLOATS_PER_POINT)
  }

  get pointCount() { return this._len }

  /** Add a single point (world-space XYZ + RGB 0-1). */
  addPoint(x, y, z, r, g, b) {
    if (this._len >= this._cap) this._grow()
    const base = this._len * FLOATS_PER_POINT
    this._data[base]   = x
    this._data[base+1] = y
    this._data[base+2] = z
    this._data[base+3] = r
    this._data[base+4] = g
    this._data[base+5] = b
    this._len++
  }

  _grow() {
    this._cap *= 2
    const next = new Float32Array(this._cap * FLOATS_PER_POINT)
    next.set(this._data)
    this._data = next
  }

  /** Return a view of only the filled portion. */
  toFloat32Array() {
    return this._data.slice(0, this._len * FLOATS_PER_POINT)
  }

  /** Serialise to a plain object safe for JSON / IndexedDB. */
  toJSON() {
    // Base64-encode the binary for compact JSON storage
    const filled = this.toFloat32Array()
    const bytes = new Uint8Array(filled.buffer)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
    return {
      pointCount: this._len,
      data: btoa(binary),
    }
  }

  /** Restore from the plain object returned by toJSON(). */
  static fromJSON({ pointCount, data }) {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const buf = new PointCloudBuffer(pointCount)
    buf._data = new Float32Array(bytes.buffer)
    buf._len  = pointCount
    buf._cap  = pointCount
    return buf
  }
}

/**
 * Unproject one depth sample from camera-space to world-space.
 *
 * @param {number} u       – normalised X (0-1, left-to-right)
 * @param {number} v       – normalised Y (0-1, top-to-bottom)
 * @param {number} depth   – depth in metres (from XRDepthInformation.getDepthInMeters)
 * @param {XRView} view    – the XRView for this frame
 * @returns {[number,number,number]} world-space [x, y, z]
 */
export function unprojectDepthSample(u, v, depth, view) {
  // NDC: x in [-1,1], y in [1,-1] (WebGL convention: y up)
  const ndcX =  u * 2 - 1
  const ndcY = -v * 2 + 1

  // Invert the projection matrix to go from NDC → camera space
  const proj = view.projectionMatrix     // Float32Array, column-major
  // For a perspective projection, x_cam = ndcX * depth / proj[0]
  //                               y_cam = ndcY * depth / proj[5]
  //                               z_cam = -depth  (camera looks down -Z in WebXR)
  const xCam = (ndcX / proj[0]) * depth
  const yCam = (ndcY / proj[5]) * depth
  const zCam = -depth

  // view.transform.matrix is the camera-to-world matrix (column-major Float32Array)
  const m = view.transform.matrix
  const xW = m[0]*xCam + m[4]*yCam + m[8]*zCam  + m[12]
  const yW = m[1]*xCam + m[5]*yCam + m[9]*zCam  + m[13]
  const zW = m[2]*xCam + m[6]*yCam + m[10]*zCam + m[14]
  return [xW, yW, zW]
}

/**
 * Sample color from a WebXR camera image at normalised (u, v).
 * Reads from a 2D canvas that has the camera texture drawn onto it.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} u – 0-1
 * @param {number} v – 0-1
 * @returns {[number, number, number]} r, g, b each 0-1
 */
export function sampleCameraColor(ctx, u, v) {
  const { width: w, height: h } = ctx.canvas
  const px = Math.min(w - 1, Math.round(u * w))
  const py = Math.min(h - 1, Math.round(v * h))
  const d = ctx.getImageData(px, py, 1, 1).data
  return [d[0] / 255, d[1] / 255, d[2] / 255]
}

/**
 * Detect axis-aligned room planes from the XRPlane set returned by a frame.
 * Returns an array of plane descriptors usable to build room geometry.
 *
 * @param {XRFrame} frame
 * @param {XRReferenceSpace} refSpace
 * @returns {Array<{normal:[number,number,number], vertices:Float32Array, orientation:'horizontal'|'vertical', pose:{x,y,z}}>}
 */
export function extractPlanes(frame, refSpace) {
  if (!frame.detectedPlanes) return []
  const planes = []
  frame.detectedPlanes.forEach(plane => {
    const planePose = frame.getPose(plane.planeSpace, refSpace)
    if (!planePose) return
    const m = planePose.transform.matrix
    // Normal is the local Y axis of the plane, transformed to world space
    const nx = m[4], ny = m[5], nz = m[6]
    // Classify by dominant normal component
    const absX = Math.abs(nx), absY = Math.abs(ny), absZ = Math.abs(nz)
    const orientation = absY > absX && absY > absZ ? 'horizontal' : 'vertical'
    // Polygon vertices in world space
    const verts = []
    for (const v of plane.polygon) {
      verts.push(
        m[0]*v.x + m[4]*v.y + m[8]*v.z  + m[12],
        m[1]*v.x + m[5]*v.y + m[9]*v.z  + m[13],
        m[2]*v.x + m[6]*v.y + m[10]*v.z + m[14],
      )
    }
    planes.push({
      normal:      [nx, ny, nz],
      orientation,
      pose:        { x: m[12], y: m[13], z: m[14] },
      vertices:    new Float32Array(verts),
    })
  })
  return planes
}

/** Serialise a planes array to JSON (vertices → base64). */
export function planesToJSON(planes) {
  return planes.map(p => ({
    ...p,
    vertices: (() => {
      const bytes = new Uint8Array(p.vertices.buffer)
      let bin = ''; for (const b of bytes) bin += String.fromCharCode(b)
      return btoa(bin)
    })(),
  }))
}

/** Restore planes from JSON. */
export function planesFromJSON(arr) {
  return arr.map(p => ({
    ...p,
    vertices: (() => {
      const bin = atob(p.vertices)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new Float32Array(bytes.buffer)
    })(),
  }))
}
