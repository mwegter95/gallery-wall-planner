// All requests go through Vite's proxy → http://localhost:3001

async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}

/** Load all persisted walls and layouts from backend */
export async function loadState() {
  return apiFetch('/api/state');
}

/** Upsert wall metadata (id, name, width, height, createdAt) */
export async function putWall(wall) {
  return apiFetch(`/api/walls/${wall.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(wall),
  });
}

/** Delete a wall (metadata + image + layouts) */
export async function deleteWall(id) {
  return apiFetch(`/api/walls/${id}`, { method: 'DELETE' });
}

/**
 * Upload a wall image as a dataUrl.
 * Returns { url } where url is like "/uploads/walls/{id}.jpg"
 */
export async function uploadWallImage(wallId, dataUrl) {
  return apiFetch(`/api/walls/${wallId}/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
}

/**
 * Upload a piece image as a dataUrl.
 * Returns { url } where url is like "/uploads/pieces/{id}.jpg"
 */
export async function uploadPieceImage(pieceId, dataUrl) {
  return apiFetch(`/api/piece-images/${pieceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
}

/** Delete a piece image from disk */
export async function deletePieceImage(pieceId) {
  return apiFetch(`/api/piece-images/${pieceId}`, { method: 'DELETE' });
}

/**
 * Save (upsert) a named layout for a wall.
 * pieces should already have server URLs (not data: URLs).
 */
export async function putLayout(wallId, name, pieces) {
  return apiFetch(`/api/layouts/${wallId}/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pieces }),
  });
}

/** Delete a named layout for a wall */
export async function deleteLayout(wallId, name) {
  return apiFetch(`/api/layouts/${wallId}/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

/** Upload a library piece image. Returns { url } */
export async function uploadLibraryImage(libId, dataUrl) {
  return apiFetch(`/api/library/${libId}/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
}

/** Upsert a library piece entry */
export async function putLibraryPiece(piece) {
  return apiFetch(`/api/library/${piece.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(piece),
  });
}

/** Remove a library piece entry */
export async function deleteLibraryPiece(id) {
  return apiFetch(`/api/library/${id}`, { method: 'DELETE' });
}
