/**
 * seamBlend.js — Worker-based seam-stitching facade.
 *
 * Delegates all heavy OpenCV work (ORB feature detection, RANSAC homography,
 * warpPerspective) to seamBlendWorker.js so the main thread stays responsive.
 *
 * The worker loads opencv.js via importScripts('/opencv.js') — a plain static
 * file served from public/ that bypasses Vite's bundler entirely.
 *
 * Usage:
 *   import { stitchSeams } from '../utils/seamBlend'
 *   const resultMap = await stitchSeams(surfaces, (pct, status) => …)
 *   // resultMap: Map<surfaceId, stitchedDataUrl>
 */

let _worker = null

function getWorker() {
  if (_worker) return _worker
  _worker = new Worker(new URL('./seamBlendWorker.js', import.meta.url))
  _worker.onerror = (e) => {
    console.error('[seamBlend] Worker crashed:', e.message)
    _worker = null   // will be re-created on next call
  }
  return _worker
}

/**
 * Stitch all connected surface pairs.
 * Returns Map<surfaceId, stitchedDataUrl>.
 *
 * @param {Array}    surfaces   – space.surfaces array (each must have .id, .warpedDataUrl, .connections)
 * @param {Function} onProgress – (pct:0-100, status:string) => void
 */
export async function stitchSeams(surfaces, onProgress) {
  // ── Collect connected pairs ──────────────────────────────────────────────────
  const seen = new Set()
  const pairs = []

  for (const surf of surfaces) {
    if (!surf.warpedDataUrl) continue
    for (const [edge, conn] of Object.entries(surf.connections || {})) {
      if (!conn?.surfaceId) continue
      const other = surfaces.find(s => s.id === conn.surfaceId)
      if (!other?.warpedDataUrl) continue
      const key = [surf.id, other.id].sort().join('::')
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push({
        idA:      surf.id,
        dataUrlA: surf.stitchedDataUrl || surf.warpedDataUrl,
        edgeA:    edge,
        idB:      other.id,
        dataUrlB: other.stitchedDataUrl || other.warpedDataUrl,
        edgeB:    conn.edge,
      })
    }
  }

  if (!pairs.length) {
    onProgress?.(100, 'No connected pairs found')
    return new Map()
  }

  // ── Delegate to worker ───────────────────────────────────────────────────────
  return new Promise((resolve, reject) => {
    const worker = getWorker()

    let done = false
    const cleanup = () => {
      worker.onmessage = null
      worker.onerror   = null
    }

    // Safety timeout: if the worker never responds (e.g. a silent async error inside
    // the worker caused an unhandled rejection), kill it and clear the spinner.
    const timer = setTimeout(() => {
      if (done) return
      done = true
      cleanup()
      _worker = null
      worker.terminate()
      reject(new Error('seamBlendWorker timed out after 120 s — killed'))
    }, 120_000)

    worker.onmessage = ({ data }) => {
      switch (data.type) {
        case 'progress':
          onProgress?.(data.pct, data.status)
          break
        case 'warn':
          console.warn('[seamBlend]', data.msg)
          break
        case 'done':
          if (done) break
          done = true; clearTimeout(timer); cleanup()
          onProgress?.(100)
          resolve(new Map(data.results))
          break
        case 'error':
          if (done) break
          done = true; clearTimeout(timer); cleanup()
          _worker = null
          worker.terminate()
          reject(new Error(data.msg || 'Worker error'))
          break
      }
    }

    worker.onerror = (e) => {
      if (done) return
      done = true; clearTimeout(timer); cleanup()
      _worker = null
      reject(new Error('seamBlendWorker crashed: ' + (e.message || 'unknown')))
    }

    worker.postMessage({ type: 'stitch', pairs })
  })
}
