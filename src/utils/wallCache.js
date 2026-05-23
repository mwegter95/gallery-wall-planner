/**
 * wallCache.js — IndexedDB cache for WPA-12 baked wall textures.
 *
 * Key: cacheKey = `${roomId}|${vertexCount}|${snapshotCount}` (cheap & stable
 * for a given scan + photo set).  Values: array of
 *   {
 *     planeType:  'floor'|'ceiling'|'wall',
 *     normal:     [x, y, z],
 *     offset:     float (plane equation d)
 *     centroid:   [x, y, z],
 *     uAxis:      [x, y, z],
 *     vAxis:      [x, y, z],
 *     uMin/uMax/vMin/vMax: float,
 *     width/height: int (texture pixels),
 *     pngBlob:    Blob (image/png) — the baked photo composite
 *   }
 *
 * Stored as one record per cacheKey: `{ cacheKey, ts, walls: [...] }`
 */

const DB_NAME    = 'wpa12-walls'
const DB_VERSION = 1
const STORE      = 'walls'

let _dbPromise = null

function openDB() {
  if (_dbPromise) return _dbPromise
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'cacheKey' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      _dbPromise = null
      reject(req.error)
    }
  })
  return _dbPromise
}

/**
 * Bake algorithm version — bump this any time the projection shader, gain
 * computation, RANSAC tuning, or anything that changes the visual result is
 * modified.  Old cached blobs become unreachable automatically.
 *   v2: viewRay-based facing, edge feather, photometric per-photo gains.
 *   v3: inlier coverage mask gates unscanned regions; up to 12 walls;
 *       separate floor/ceiling/wall RANSAC thresholds (0.5%/0.3%/1.5%).
 *   v4: per-photo depth maps for occlusion rejection; tighter floor/ceiling
 *       distance threshold (2 cm); walls keep full coverage (depth handles
 *       geometry); WALL_MIN dropped to 0.3 % for small/alcove walls.
 */
const BAKE_VERSION = 4

/**
 * Build a stable-ish cache key for a (room, scan, photoSet) tuple.
 *
 * We deliberately keep the key cheap (no point-cloud hashing) so that loads
 * don't pay a hashing cost.  If the scan changes the vertexCount or the photo
 * count changes the key auto-invalidates; otherwise we trust the bake.
 */
export function makeCacheKey({ roomId, vertexCount, snapshotCount }) {
  return `bv${BAKE_VERSION}|${roomId || 'local'}|v${vertexCount || 0}|s${snapshotCount || 0}`
}

export async function getCachedWalls(cacheKey) {
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(cacheKey)
      req.onsuccess = () => resolve(req.result?.walls || null)
      req.onerror = () => reject(req.error)
    })
  } catch (err) {
    console.warn('[wallCache] read failed:', err)
    return null
  }
}

export async function putCachedWalls(cacheKey, walls) {
  try {
    const db = await openDB()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ cacheKey, ts: Date.now(), walls })
      tx.oncomplete = resolve
      tx.onerror    = () => reject(tx.error)
    })
  } catch (err) {
    console.warn('[wallCache] write failed:', err)
  }
}

export async function clearWallCache() {
  try {
    const db = await openDB()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).clear()
      tx.oncomplete = resolve
      tx.onerror    = () => reject(tx.error)
    })
  } catch (err) {
    console.warn('[wallCache] clear failed:', err)
  }
}
