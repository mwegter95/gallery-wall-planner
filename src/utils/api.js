/**
 * Gallery Wall backend client.
 *
 * Dev:        requests go to /api/* → Vite proxy → localhost:5050
 * Production: VITE_API_URL=https://api.michaelwegter.com  →  absolute URLs
 *
 * Auth headers are attached automatically:
 *   - Logged-in users:  Authorization: Bearer <jwt>
 *   - Anonymous:        X-Device-Token: <uuid>   (persistent per browser)
 */

import { syncTokenToParent } from './embedAuth.js'

// In dev this is '' so paths stay relative (Vite proxy handles them).
// In production (VITE_API_URL=https://api.michaelwegter.com) it becomes absolute.
export const BASE = import.meta.env.VITE_API_URL || ''

// ── Device token ─────────────────────────────────────────────────────────────
// Stable UUID per browser; lets anonymous users keep their data without login.
function getDeviceToken() {
  const key = 'gwp-device-token'
  let t = localStorage.getItem(key)
  if (!t) { t = crypto.randomUUID(); localStorage.setItem(key, t) }
  return t
}

// ── JWT helpers ───────────────────────────────────────────────────────────────
// Mirror token changes to the first-party parent shell so an embedded session
// survives Safari evicting this iframe's third-party storage (no-op when not
// embedded). See utils/embedAuth.js + michaelwegter.com AppFrame.jsx.
export const TOKEN_KEY = 'gwp-jwt'
export function getJwt()      { return localStorage.getItem(TOKEN_KEY) }
export function setJwt(token) { localStorage.setItem(TOKEN_KEY, token); syncTokenToParent(token) }
export function clearJwt()    { localStorage.removeItem(TOKEN_KEY); syncTokenToParent(null) }
export function isLoggedIn()  { return Boolean(getJwt()) }
export { getDeviceToken }

/**
 * Decode the stored JWT payload client-side (no server call).
 * Returns a user object { id, email, display_name } or null if no token / expired.
 */
export function getJwtUser() {
  const token = getJwt()
  if (!token) return null
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      clearJwt()
      return null
    }
    if (!payload.sub) return null
    return {
      id:           payload.sub,
      email:        payload.email        || '',
      display_name: payload.display_name || '',
    }
  } catch {
    return null
  }
}

// ── Core fetch ────────────────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const jwt    = getJwt()
  const device = getDeviceToken()

  const headers = {
    'Content-Type': 'application/json',
    'X-Device-Token': device,
    ...(jwt ? { 'Authorization': `Bearer ${jwt}`, 'X-Auth-Token': jwt } : {}),
    ...(options.headers || {}),
  }

  const res = await fetch(`${BASE}${path}`, { ...options, headers })

  if (res.status === 401) {
    clearJwt()
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`API error ${res.status}: ${text}`)
  }
  return res.json()
}

// ── Auth ──────────────────────────────────────────────────────────────────────
export async function authRegister(email, password, displayName) {
  const data = await apiFetch('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, display_name: displayName, device_token: getDeviceToken() }),
  })
  setJwt(data.token)
  return data.user
}

export async function authLogin(email, password) {
  const data = await apiFetch('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password, device_token: getDeviceToken() }),
  })
  setJwt(data.token)
  return data.user
}

export async function authLogout() {
  clearJwt()
}

// authMe is kept for server-side validation when explicitly needed,
// but boot no longer calls it — use getJwtUser() for instant local decode.
export async function authMe() {
  return apiFetch('/auth/me')
}

export async function authForgotPassword(email) {
  return apiFetch('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export async function authResetPassword(token, password) {
  const data = await apiFetch('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  })
  setJwt(data.token)
  return data.user
}

// ── URL helpers ───────────────────────────────────────────────────────────────
// Relative /uploads/... paths need BASE prefix in production.
export function fixUrl(url) {
  if (!url || !url.startsWith('/')) return url
  return `${BASE}${url}`
}

// ── Gallery: full state ───────────────────────────────────────────────────────
export async function loadState() {
  const state = await apiFetch('/api/state')
  // Normalise any relative /uploads/... URLs to absolute
  if (state.walls) {
    for (const w of Object.values(state.walls)) {
      if (w.imageUrl) w.imageUrl = fixUrl(w.imageUrl)
    }
  }
  if (state.library) {
    for (const p of Object.values(state.library)) {
      if (p.image) p.image = fixUrl(p.image)
    }
  }
  if (state.layouts) {
    for (const wallLayouts of Object.values(state.layouts)) {
      for (const layout of Object.values(wallLayouts)) {
        for (const piece of (layout.pieces || [])) {
          if (piece.image) piece.image = fixUrl(piece.image)
        }
      }
    }
  }
  return state
}

// ── Gallery: walls ────────────────────────────────────────────────────────────
export async function putWall(wall) {
  return apiFetch(`/api/walls/${wall.id}`, {
    method: 'PUT',
    body: JSON.stringify(wall),
  })
}

export async function deleteWall(id) {
  return apiFetch(`/api/walls/${id}`, { method: 'DELETE' })
}

export async function uploadWallImage(wallId, dataUrl) {
  const data = await apiFetch(`/api/walls/${wallId}/image`, {
    method: 'POST',
    body: JSON.stringify({ dataUrl }),
  })
  // Append cache-bust timestamp so browsers reload the image after recalibration
  const url = data.url?.startsWith('/') ? `${BASE}${data.url}` : data.url
  return { ...data, url: `${url}?v=${Date.now()}` }
}

/**
 * Upload the content-aware fill (inpaint) result for a wall.
 * Stored as uploads/walls/{wallId}_inpaint.{ext} — separate from the original wall photo.
 */
export async function uploadWallInpaint(wallId, dataUrl) {
  const data = await apiFetch(`/api/walls/${wallId}_inpaint/image`, {
    method: 'POST',
    body: JSON.stringify({ dataUrl }),
  })
  const url = data.url?.startsWith('/') ? `${BASE}${data.url}` : data.url
  return { ...data, url: `${url}?v=${Date.now()}` }
}

// ── Gallery: layouts ──────────────────────────────────────────────────────────
export async function putLayout(wallId, name, pieces, paintLayerIds = []) {
  return apiFetch(`/api/layouts/${wallId}/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ pieces, paintLayerIds }),
  })
}

export async function deleteLayout(wallId, name) {
  return apiFetch(`/api/layouts/${wallId}/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
}

// ── Gallery: piece images ─────────────────────────────────────────────────────
export async function uploadPieceImage(pieceId, dataUrl) {
  const data = await apiFetch(`/api/piece-images/${pieceId}`, {
    method: 'POST',
    body: JSON.stringify({ dataUrl }),
  })
  return { ...data, url: data.url?.startsWith('/') ? `${BASE}${data.url}` : data.url }
}

export async function deletePieceImage(pieceId) {
  return apiFetch(`/api/piece-images/${pieceId}`, { method: 'DELETE' })
}

// ── Gallery: paint layers ─────────────────────────────────────────────────────
export async function putPaintLayer(wallId, layerData) {
  return apiFetch(`/api/paint-layers/${wallId}/${layerData.id}`, {
    method: 'PUT',
    body: JSON.stringify(layerData),
  })
}

export async function deletePaintLayer(wallId, layerId) {
  return apiFetch(`/api/paint-layers/${wallId}/${layerId}`, { method: 'DELETE' })
}

// ── Gallery: library ──────────────────────────────────────────────────────────
export async function putLibraryPiece(piece) {
  return apiFetch(`/api/library/${piece.id}`, {
    method: 'PUT',
    body: JSON.stringify(piece),
  })
}

export async function deleteLibraryPiece(id) {
  return apiFetch(`/api/library/${id}`, { method: 'DELETE' })
}

export async function uploadLibraryImage(libId, dataUrl) {
  const data = await apiFetch(`/api/library/${libId}/image`, {
    method: 'POST',
    body: JSON.stringify({ dataUrl }),
  })
  return { ...data, url: data.url?.startsWith('/') ? `${BASE}${data.url}` : data.url }
}

// ── Gallery: 3D rooms ─────────────────────────────────────────────────────────

export async function loadRooms() {
  const data = await apiFetch('/api/rooms')
  // Fix relative image URLs in surfaces
  for (const room of Object.values(data.rooms || {})) {
    for (const surface of Object.values(room.surfaces || {})) {
      if (surface.warpedImageUrl?.startsWith('/')) surface.warpedImageUrl = fixUrl(surface.warpedImageUrl)
    }
  }
  return data.rooms || {}
}

export async function putRoom(room) {
  return apiFetch(`/api/rooms/${room.id}`, {
    method: 'PUT',
    body: JSON.stringify(room),
  })
}

function toByteView(binary) {
  if (binary instanceof ArrayBuffer) return new Uint8Array(binary)
  if (ArrayBuffer.isView(binary)) {
    return new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength)
  }
  throw new Error('Point cloud upload: unsupported binary payload')
}

/**
 * Upload a raw Float32 binary point cloud blob and return the server URL.
 * Uses XMLHttpRequest so upload.onprogress is available for real progress.
 * @param {string}      roomId
 * @param {ArrayBuffer|ArrayBufferView} binaryPayload — raw point cloud bytes
 * @param {function}    [onProgress] — called with fraction 0-1 during upload
 */
export function uploadPointCloud(roomId, binaryPayload, onProgress) {
  const jwt    = getJwt()
  const device = getDeviceToken()
  const bytes = toByteView(binaryPayload)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    if (onProgress) {
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const { url } = JSON.parse(xhr.responseText)
          // Make relative paths absolute (same as other upload helpers)
          resolve({ url: url?.startsWith('/') ? `${BASE}${url}` : url })
        } catch { resolve({}) }
      } else {
        reject(new Error(`Point cloud upload failed: ${xhr.status}`))
      }
    }
    xhr.onerror  = () => reject(new Error('Point cloud upload: network error'))
    xhr.open('POST', `${BASE}/api/rooms/${roomId}/pointcloud`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader('X-Device-Token', device)
    if (jwt) {
      xhr.setRequestHeader('Authorization', `Bearer ${jwt}`)
      xhr.setRequestHeader('X-Auth-Token', jwt)
    }
    xhr.send(bytes)
  })
}

/**
 * Stream one live point-cloud chunk while scanning.
 * Chunks must be uploaded in-order for a given uploadId.
 */
export async function uploadPointCloudStreamChunk(roomId, uploadId, chunkIndex, chunkBuffer) {
  const jwt = getJwt()
  const device = getDeviceToken()
  const bytes = toByteView(chunkBuffer)

  const headers = {
    'Content-Type': 'application/octet-stream',
    'X-Device-Token': device,
    'X-Upload-Id': String(uploadId),
    'X-Chunk-Index': String(chunkIndex),
    ...(jwt ? { 'Authorization': `Bearer ${jwt}`, 'X-Auth-Token': jwt } : {}),
  }

  const res = await fetch(`${BASE}/api/rooms/${roomId}/pointcloud/stream-chunk`, {
    method: 'POST',
    headers,
    body: bytes,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Point cloud stream chunk failed ${res.status}: ${text}`)
  }

  return res.json()
}

/**
 * Finalize a live streaming point-cloud upload and trigger mesh build.
 */
export async function finalizePointCloudStream(roomId, uploadId) {
  const jwt = getJwt()
  const device = getDeviceToken()

  const headers = {
    'X-Device-Token': device,
    'X-Upload-Id': String(uploadId),
    ...(jwt ? { 'Authorization': `Bearer ${jwt}`, 'X-Auth-Token': jwt } : {}),
  }

  const res = await fetch(`${BASE}/api/rooms/${roomId}/pointcloud/stream-finalize`, {
    method: 'POST',
    headers,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Point cloud stream finalize failed ${res.status}: ${text}`)
  }

  const data = await res.json()
  return {
    ...data,
    url: data.url?.startsWith('/') ? `${BASE}${data.url}` : data.url,
  }
}

/**
 * Upload a raw point cloud using chunked transfer to improve reliability on large files.
 * Falls back to the legacy single-request upload if the backend chunk endpoint is unavailable.
 */
export async function uploadPointCloudChunked(roomId, binaryPayload, onProgress, options = {}) {
  const bytes = toByteView(binaryPayload)
  const totalBytes = bytes.byteLength || 0
  if (totalBytes <= 0) throw new Error('Point cloud upload: empty payload')

  const chunkSize = Math.max(512 * 1024, options.chunkSize || (4 * 1024 * 1024))
  if (totalBytes <= chunkSize) {
    return uploadPointCloud(roomId, bytes, onProgress)
  }

  const jwt = getJwt()
  const device = getDeviceToken()
  const uploadId = crypto.randomUUID()
  const totalChunks = Math.ceil(totalBytes / chunkSize)

  let completedBytes = 0

  const sendChunk = (chunkBuffer, chunkIndex) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return
        onProgress(Math.min(1, (completedBytes + e.loaded) / totalBytes))
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const body = JSON.parse(xhr.responseText || '{}')
          resolve(body)
        } catch {
          resolve({})
        }
      } else {
        const err = new Error(`Point cloud chunk upload failed: ${xhr.status}`)
        err.status = xhr.status
        reject(err)
      }
    }
    xhr.onerror = () => reject(new Error('Point cloud chunk upload: network error'))
    xhr.open('POST', `${BASE}/api/rooms/${roomId}/pointcloud/chunk`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader('X-Device-Token', device)
    xhr.setRequestHeader('X-Upload-Id', uploadId)
    xhr.setRequestHeader('X-Chunk-Index', String(chunkIndex))
    xhr.setRequestHeader('X-Chunk-Total', String(totalChunks))
    if (jwt) {
      xhr.setRequestHeader('Authorization', `Bearer ${jwt}`)
      xhr.setRequestHeader('X-Auth-Token', jwt)
    }
    xhr.send(chunkBuffer)
  })

  try {
    let finalUrl = null
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const start = chunkIndex * chunkSize
      const end = Math.min(totalBytes, start + chunkSize)
      const chunk = bytes.subarray(start, end)
      const body = await sendChunk(chunk, chunkIndex)
      completedBytes = end
      if (onProgress) onProgress(Math.min(1, completedBytes / totalBytes))
      if (body?.url) finalUrl = body.url
    }
    if (!finalUrl) throw new Error('Point cloud chunk upload failed: missing final URL')
    return { url: finalUrl?.startsWith('/') ? `${BASE}${finalUrl}` : finalUrl }
  } catch (err) {
    // Backward compatibility: if server does not expose chunk endpoint yet, use legacy upload.
    if (err?.status === 404 || err?.status === 405) {
      return uploadPointCloud(roomId, bytes, onProgress)
    }
    throw err
  }
}

export async function deleteRoom(roomId) {
  return apiFetch(`/api/rooms/${roomId}`, { method: 'DELETE' })
}

/** Fetch full room data for a single room (lazy-loaded after init). */
export async function getRoom(roomId) {
  return apiFetch(`/api/rooms/${roomId}`)
}

/**
 * Upload one snapshot during scanning (incremental upload).
 * snapshot: { jpeg, c2w, K, fw, fh }
 */
export async function uploadSnapshot(roomId, index, snapshot) {
  return apiFetch(`/api/rooms/${roomId}/snapshots/${index}`, {
    method: 'POST',
    body: JSON.stringify({ snapshot }),
  })
}

/**
 * Download the pre-colored point cloud binary for 3-D viewing.
 * Returns an ArrayBuffer of interleaved Float32 [x,y,z,r,g,b …].
 */
export async function downloadPointCloud(roomId) {
  const jwt    = getJwt()
  const device = getDeviceToken()
  const resp = await fetch(`${BASE}/api/rooms/${roomId}/pointcloud/download`, {
    headers: {
      'X-Device-Token': device,
      'Accept-Encoding': 'gzip',
      ...(jwt ? { 'Authorization': `Bearer ${jwt}`, 'X-Auth-Token': jwt } : {}),
    },
  })
  if (!resp.ok) throw new Error(`Point cloud download failed: ${resp.status}`)
  return resp.arrayBuffer()
}

/**
 * Fetch snapshot metadata for a room (URL + camera matrices) for projective texturing.
 */
export async function getSnapshots(roomId) {
  return apiFetch(`/api/rooms/${roomId}/snapshots`)
}

/**
 * Upload snapshot bundles (fallback path for older native builds).
 * snapshots: Array<{ jpeg, c2w, K, fw, fh }>
 */
export async function uploadSnapshots(roomId, snapshots) {
  if (!snapshots?.length) return { count: 0 }
  return apiFetch(`/api/rooms/${roomId}/snapshots`, {
    method: 'POST',
    body: JSON.stringify({ snapshots }),
  })
}

/**
 * Upload a perspective-warped surface image and return the server URL.
 * Stores under uploads/walls/<roomId>_<faceId>.<ext>
 */
export async function uploadSurfaceImage(roomId, faceId, dataUrl) {
  const data = await apiFetch(`/api/rooms/${roomId}/surfaces/${faceId}/image`, {
    method: 'POST',
    body: JSON.stringify({ dataUrl }),
  })
  const url = data.url?.startsWith('/') ? `${BASE}${data.url}` : data.url
  return { ...data, url: `${url}?v=${Date.now()}` }
}
