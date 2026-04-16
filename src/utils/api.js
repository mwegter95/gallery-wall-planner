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

// In dev this is '' so paths stay relative (Vite proxy handles them).
// On Netlify set VITE_API_URL in the build environment.
const BASE = import.meta.env.VITE_API_URL || ''

// ── Device token ─────────────────────────────────────────────────────────────
// Stable UUID per browser; lets anonymous users keep their data without login.
function getDeviceToken() {
  const key = 'gwp-device-token'
  let t = localStorage.getItem(key)
  if (!t) { t = crypto.randomUUID(); localStorage.setItem(key, t) }
  return t
}

// ── JWT helpers ───────────────────────────────────────────────────────────────
export function getJwt()      { return localStorage.getItem('gwp-jwt') }
export function setJwt(token) { localStorage.setItem('gwp-jwt', token) }
export function clearJwt()    { localStorage.removeItem('gwp-jwt') }
export function isLoggedIn()  { return Boolean(getJwt()) }
export { getDeviceToken }

// ── Core fetch ────────────────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const jwt    = getJwt()
  const device = getDeviceToken()

  const headers = {
    'Content-Type': 'application/json',
    'X-Device-Token': device,
    ...(jwt ? { 'Authorization': `Bearer ${jwt}` } : {}),
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

export async function authMe() {
  return apiFetch('/auth/me')
}

// ── Gallery: full state ───────────────────────────────────────────────────────
export async function loadState() {
  return apiFetch('/api/state')
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
  return apiFetch(`/api/walls/${wallId}/image`, {
    method: 'POST',
    body: JSON.stringify({ dataUrl }),
  })
}

// ── Gallery: layouts ──────────────────────────────────────────────────────────
export async function putLayout(wallId, name, pieces) {
  return apiFetch(`/api/layouts/${wallId}/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ pieces }),
  })
}

export async function deleteLayout(wallId, name) {
  return apiFetch(`/api/layouts/${wallId}/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
}

// ── Gallery: piece images ─────────────────────────────────────────────────────
export async function uploadPieceImage(pieceId, dataUrl) {
  return apiFetch(`/api/piece-images/${pieceId}`, {
    method: 'POST',
    body: JSON.stringify({ dataUrl }),
  })
}

export async function deletePieceImage(pieceId) {
  return apiFetch(`/api/piece-images/${pieceId}`, { method: 'DELETE' })
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
  return apiFetch(`/api/library/${libId}/image`, {
    method: 'POST',
    body: JSON.stringify({ dataUrl }),
  })
}
