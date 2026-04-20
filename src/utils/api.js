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
export function getJwt()      { return localStorage.getItem('gwp-jwt') }
export function setJwt(token) { localStorage.setItem('gwp-jwt', token) }
export function clearJwt()    { localStorage.removeItem('gwp-jwt') }
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
      for (const pieces of Object.values(wallLayouts)) {
        for (const piece of pieces) {
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
  const data = await apiFetch(`/api/piece-images/${pieceId}`, {
    method: 'POST',
    body: JSON.stringify({ dataUrl }),
  })
  return { ...data, url: data.url?.startsWith('/') ? `${BASE}${data.url}` : data.url }
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
  const data = await apiFetch(`/api/library/${libId}/image`, {
    method: 'POST',
    body: JSON.stringify({ dataUrl }),
  })
  return { ...data, url: data.url?.startsWith('/') ? `${BASE}${data.url}` : data.url }
}
