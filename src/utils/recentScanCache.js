const DB_NAME = 'gwp-recent-scan-cache'
const DB_VERSION = 1
const STORE_NAME = 'scan'
const CACHE_KEY = 'latest'

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }

    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }

    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'))
  })
}

function txGet(store, key) {
  return new Promise((resolve, reject) => {
    const req = store.get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('IndexedDB get failed'))
  })
}

function txPut(store, value, key) {
  return new Promise((resolve, reject) => {
    const req = store.put(value, key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error || new Error('IndexedDB put failed'))
  })
}

export async function loadRecentScanBuffer({ roomId, url, pointCount } = {}) {
  try {
    const db = await openDb()
    if (!db) return null

    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const entry = await txGet(store, CACHE_KEY)
    db.close()

    if (!entry || !(entry.buffer instanceof ArrayBuffer)) return null
    if (roomId && entry.roomId !== roomId) return null
    if (url && entry.url !== url) return null
    if (Number.isFinite(pointCount) && pointCount > 0 && entry.pointCount !== pointCount) return null

    return entry.buffer
  } catch {
    return null
  }
}

export async function saveRecentScanBuffer({ roomId, url, pointCount, buffer } = {}) {
  try {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) return
    const db = await openDb()
    if (!db) return

    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    await txPut(store, {
      roomId: roomId || null,
      url: url || null,
      pointCount: Number.isFinite(pointCount) && pointCount > 0 ? pointCount : null,
      updatedAt: Date.now(),
      buffer,
    }, CACHE_KEY)
    db.close()
  } catch {
    // Ignore cache write failures (private mode/storage pressure).
  }
}
