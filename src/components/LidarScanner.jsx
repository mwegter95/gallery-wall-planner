/**
 * LidarScanner.jsx
 *
 * Full-screen WebXR AR scanning session.
 * Requires Safari iOS 16+ on a LiDAR-equipped device.
 *
 * Features used:
 *   - depth-sensing    : raw LiDAR depth per frame
 *   - camera-access    : RGB camera feed for colorising the point cloud
 *   - plane-detection  : auto-detect walls / floor / ceiling
 *
 * When the user taps "Done", we call onComplete({ pointCloud, planes }) with
 * serialised data ready to be stored in the Space.
 *
 * If WebXR is unavailable (Chrome, desktop, unsupported device) we show a
 * clear explanation and a "Close" button.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  PointCloudBuffer,
  unprojectDepthSample,
  extractPlanes,
  planesToJSON,
} from '../utils/pointCloud'

// How many depth samples to take per frame (spread across the depth image).
// Higher = denser cloud but heavier CPU/memory.
const SAMPLES_PER_FRAME_BASE = 1200
const SAMPLES_PER_FRAME_FAST = 650
const MAX_LINEAR_SPEED = 1.1
const MAX_ANGULAR_SPEED = 3.2

// Minimum depth (m) to accept — filters out noise from very close surfaces
const MIN_DEPTH = 0.15
// Maximum depth (m) — ignore beyond this (large open spaces, windows to sky)
const MAX_DEPTH = 12

export default function LidarScanner({ onComplete, onCancel, onSnapshot = null }) {
  const [status,    setStatus]    = useState('checking') // checking | unsupported | starting | scanning | processing | error
  const [progress,  setProgress]  = useState(0)   // 0-100 while scanning
  const [pointCount, setPointCount] = useState(0)
  const [errorMsg,  setErrorMsg]  = useState('')
  const [directUrl, setDirectUrl] = useState('')   // tappable "open here" URL
  const [isReady,   setIsReady]   = useState(false) // user tapped Start
  const [retryCount, setRetryCount] = useState(0)  // bump to re-run XR check

  const sessionRef    = useRef(null)
  const rafRef        = useRef(null)
  const bufferRef     = useRef(null)
  const nativeBufRef  = useRef(null)  // accumulates streaming chunks from native bridge
  const planesRef     = useRef([])
  const camCtxRef     = useRef(null)  // 2D canvas ctx for sampling camera color
  const glRef         = useRef(null)  // WebGL context
  const refSpaceRef   = useRef(null)
  const motionRef     = useRef({ t: 0, x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1 })

  /* ── Check availability (native bridge OR WebXR) ─────────────────────── */
  useEffect(() => {
    setStatus('checking')
    setErrorMsg('')
    setDirectUrl('')

    // ── Native StageAR wrapper detected ──────────────────────────────────────
    // The Swift app injects window.__stageARNative = true at document start.
    // When present we skip WebXR entirely and use the ARKit bridge instead.
    if (window.__stageARNative) {
      // Set up the global callback the Swift side will call.
      window.onStageARResult = (result) => {
        if (result.error) {
          setStatus('error')
          setErrorMsg(result.error)
          return
        }
        if (result.status === 'scanning') {
          setStatus('scanning')
          nativeBufRef.current = new PointCloudBuffer(2_000_000)  // reduce expensive growth copies on long scans
          return
        }
        // ── Real-time chunk from Swift ──────────────────────────────────────
        // Swift streams each batch (~2 000 pts, ~48 KB base64) as it is captured.
        // We decode and accumulate into nativeBufRef so "done" requires no transfer.
        if (result.status === 'chunk') {
          if (!nativeBufRef.current) nativeBufRef.current = new PointCloudBuffer(2_000_000)
          const decoded = atob(result.data)
          const bytes = new Uint8Array(decoded.length)
          for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i)
          nativeBufRef.current.addChunk(new Float32Array(bytes.buffer))
          const n = nativeBufRef.current.pointCount
          setPointCount(n)
          // Drive the scanning-phase progress bar (caps at 99 so "done" feels like a bump)
          setProgress(Math.min(99, Math.round((n / 500_000) * 80)))
          return
        }
        if (result.status === 'snapshot') {
          const snap = result.snapshot
          if (snap && onSnapshot) {
            onSnapshot(snap, Number.isFinite(result.index) ? result.index : undefined)
          }
          return
        }
        if (result.status === 'progress') {
          // Legacy progress events (older Swift builds without chunk streaming)
          setPointCount(result.pointCount)
          setProgress(Math.min(99, Math.round((result.pointCount / 100_000) * 100)))
          return
        }
        if (result.status === 'done') {
          setStatus('processing')
          setProgress(0)

          const buf = nativeBufRef.current

          if (buf && buf.pointCount > 0) {
            // ── Fast path: all data already received via 'chunk' events ──────
            // Pass the PointCloudBuffer directly as _buffer so SpaceBuilderCanvas
            // can render it without any serialization overhead.
            setProgress(100)
            const pointCloud = { pointCount: buf.pointCount, _buffer: buf }
            nativeBufRef.current = null
            onComplete({ pointCloud, planes: [], capturedAt: result.capturedAt,
                         snapshots: result.snapshots || [] })

          } else if (result.data) {
            // ── Fallback: old Swift build sent full blob in 'done' ────────────
            const b64     = result.data
            const decoded = atob(b64)
            const byteLen = decoded.length
            const bytes   = new Uint8Array(byteLen)
            const CHUNK   = 32768
            let i = 0
            const decodeStep = () => {
              const end = Math.min(i + CHUNK, byteLen)
              for (; i < end; i++) bytes[i] = decoded.charCodeAt(i)
              setProgress(Math.round((i / byteLen) * 90))
              if (i < byteLen) {
                setTimeout(decodeStep, 0)
              } else {
                const arr      = new Float32Array(bytes.buffer)
                const fallback = PointCloudBuffer.fromFloat32Array(arr, result.pointCount)
                setProgress(100)
                const pointCloud = { pointCount: result.pointCount, _buffer: fallback }
                onComplete({ pointCloud, planes: [], capturedAt: result.capturedAt,
                             snapshots: result.snapshots || [] })
              }
            }
            setTimeout(decodeStep, 0)
          } else {
            setStatus('error')
            setErrorMsg('No point cloud data received.')
          }
        }
      }
      setStatus('ready')
      return () => { window.onStageARResult = null }
    }

    const inIframe     = window.self !== window.top
    const isSecure     = window.isSecureContext
    const ua           = navigator.userAgent

    const isIOS        = /iP(hone|ad|od)/.test(ua)
    const isSafari     = /Safari/.test(ua) && !/Chrome|CriOS|FxiOS|EdgA/.test(ua)
    const isWebXRViewer = /WebXRViewer|webxrviewer/i.test(ua)
    const iosVer       = ua.match(/OS (\d+)_(\d+)/)?.[1]

    const buildDiag = (extra = '') => [
      `HTTPS:        ${isSecure       ? '✅ yes'     : '❌ NO — needs https://'}`,
      `navigator.xr: ${navigator.xr   ? '✅ present' : '❌ missing'}`,
      `Frame:        ${inIframe        ? '⚠️ iframe'  : '🟢 top-level'}`,
      `Browser:      ${isWebXRViewer   ? '✅ WebXR Viewer' : isSafari ? 'Safari' : 'other'} / ${isIOS ? `iOS ${iosVer ?? '?'}` : 'non-iOS'}`,
      extra,
      `UA: ${ua}`,
    ].filter(Boolean).join('\n')

    // ── iOS: WebXR AR is not available via any browser in 2026 ───────────────
    // Apple has never shipped WebXR in Safari. Mozilla WebXR Viewer v2 was
    // archived July 2024 and is broken on iOS 18+/iPhone 17 hardware —
    // navigator.xr is never injected despite the polyfill claim.
    // The only viable path on iPhone is a native ARKit app.
    if (isIOS) {
      setStatus('ios-unavailable')
      return
    }

    // ── Not HTTPS / not secure context ───────────────────────────────────────
    if (!isSecure) {
      setStatus('unsupported')
      const alreadyHttps = window.location.href.startsWith('https://')
      const directAppUrl = alreadyHttps
        ? window.location.href
        : window.location.href.replace(/^http:\/\//, 'https://')
      setDirectUrl(directAppUrl)
      setErrorMsg(buildDiag(
        inIframe && alreadyHttps
          ? `WebXR cannot access AR inside an embedded iframe — open the app directly.`
          : `The page loaded over HTTP — switch to HTTPS.`
      ))
      return
    }

    // ── Poll for navigator.xr (Android / Chrome / non-iOS) ───────────────────
    let attempts = 0
    const POLL_MS      = 500
    const MAX_SECS     = 10
    const MAX_ATTEMPTS = (MAX_SECS * 1000) / POLL_MS

    const checkXR = () => {
      attempts++
      const hasXR = !!navigator.xr

      if (!hasXR && attempts < MAX_ATTEMPTS) {
        const elapsed = Math.round((attempts * POLL_MS) / 1000)
        setErrorMsg(`Waiting for WebXR… (${elapsed}s)\n\nUA: ${ua}`)
      }

      if (hasXR) {
        navigator.xr.isSessionSupported('immersive-ar').then(supported => {
          if (supported) {
            setStatus('ready')
          } else {
            setStatus('unsupported')
            setErrorMsg(buildDiag(`immersive-ar not supported. Use Chrome on Android.`))
          }
        }).catch(err => {
          setStatus('unsupported')
          setErrorMsg(buildDiag(`isSessionSupported() threw: ${err.name}: ${err.message}`))
        })
        return
      }

      if (attempts >= MAX_ATTEMPTS) {
        setStatus('unsupported')
        setErrorMsg(buildDiag(`navigator.xr not found after ${MAX_SECS}s.\nUse Chrome on Android for WebXR AR.`))
        return
      }

      pollTimer = setTimeout(checkXR, POLL_MS)
    }

    let pollTimer = setTimeout(checkXR, POLL_MS)
    return () => clearTimeout(pollTimer)
  }, [retryCount])

  /* ── Start the AR session ─────────────────────────────────────────────── */
  const startScan = useCallback(async () => {
    setStatus('starting')
    setErrorMsg('')

    // ── Native ARKit bridge ───────────────────────────────────────────────────
    if (window.__stageARNative) {
      window.webkit.messageHandlers.stageAR.postMessage({ action: 'startScan' })
      return
    }

    // Canvas for the WebGL session
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:9000;touch-action:none;'
    document.body.appendChild(canvas)

    // 2D canvas for reading back camera pixels
    const camCanvas = document.createElement('canvas')
    camCanvas.width  = 256
    camCanvas.height = 256
    const camCtx = camCanvas.getContext('2d', { willReadFrequently: true })
    camCtxRef.current = camCtx

    try {
      const gl = canvas.getContext('webgl', { xrCompatible: true })
      glRef.current = gl

      const requiredFeatures = ['local-floor']
      const optionalFeatures = ['depth-sensing', 'camera-access', 'plane-detection']

      const depthConfig = {
        depthSensing: {
          usagePreference: ['cpu-optimized'],
          dataFormatPreference: ['luminance-alpha'],
        },
      }

      const session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures,
        optionalFeatures,
        ...depthConfig,
      })
      sessionRef.current = session

      await gl.makeXRCompatible()
      const baseLayer = new XRWebGLLayer(session, gl)
      await session.updateRenderState({ baseLayer })

      const refSpace = await session.requestReferenceSpace('local-floor')
      refSpaceRef.current = refSpace

      bufferRef.current = new PointCloudBuffer(2_000_000)
      planesRef.current = []
      motionRef.current = { t: 0, x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1 }

      session.addEventListener('end', () => {
        document.body.removeChild(canvas)
        setStatus('scanning') // keep scanning UI visible for "done" button
      })

      setStatus('scanning')
      setIsReady(true)

      /* ── Per-frame callback ─────────────────────────────────────────── */
      const onXRFrame = (time, frame) => {
        if (!frame) { rafRef.current = session.requestAnimationFrame(onXRFrame); return }

        const pose = frame.getViewerPose(refSpace)
        if (!pose) { rafRef.current = session.requestAnimationFrame(onXRFrame); return }

        // ── Extract depth + sample points ──────────────────────────────
        for (const view of pose.views) {
          let depthInfo = null
          try { depthInfo = frame.getDepthInformation(view) } catch { /* optional */ }

          const mat = view.transform?.matrix
          let linearSpeed = 0
          let angularSpeed = 0
          let samplesPerFrame = SAMPLES_PER_FRAME_BASE
          if (mat?.length === 16) {
            const x = mat[12], y = mat[13], z = mat[14]
            let fx = -mat[8], fy = -mat[9], fz = -mat[10]
            const fl = Math.hypot(fx, fy, fz) || 1
            fx /= fl; fy /= fl; fz /= fl

            const last = motionRef.current
            if (last.t > 0) {
              const dt = Math.max(1e-3, (time - last.t) / 1000)
              linearSpeed = Math.hypot(x - last.x, y - last.y, z - last.z) / dt
              const dot = Math.max(-1, Math.min(1, fx * last.fx + fy * last.fy + fz * last.fz))
              angularSpeed = Math.acos(dot) / dt
            }

            motionRef.current = { t: time, x, y, z, fx, fy, fz }

            if (linearSpeed > MAX_LINEAR_SPEED || angularSpeed > MAX_ANGULAR_SPEED) {
              continue
            }
            if (linearSpeed > 0.75 || angularSpeed > 2.1) {
              samplesPerFrame = SAMPLES_PER_FRAME_FAST
            }
          }

          // Sample camera image for colors
          let hasCameraColor = false
          let camData = null
          let camStride = 0
          try {
            const cameraImage = frame.getCameraImage?.(view)
            if (cameraImage) {
              // Draw camera frame into the 2D canvas at reduced resolution
              camCtx.drawImage(cameraImage, 0, 0, camCanvas.width, camCanvas.height)
              const imgData = camCtx.getImageData(0, 0, camCanvas.width, camCanvas.height)
              camData = imgData.data
              camStride = camCanvas.width * 4
              hasCameraColor = true
            }
          } catch { /* optional */ }

          if (depthInfo) {
            const dw = depthInfo.width
            const dh = depthInfo.height
            // Random stratified sampling across the depth image
            for (let s = 0; s < samplesPerFrame; s++) {
              const u = Math.random()
              const v = Math.random()
              const depth = depthInfo.getDepthInMeters(u, v)
              if (depth < MIN_DEPTH || depth > MAX_DEPTH) continue

              const [wx, wy, wz] = unprojectDepthSample(u, v, depth, view)

              let r = 0.4, g = 0.7, b = 1.0  // default blue-ish
              if (hasCameraColor && camData) {
                const px = Math.min(camCanvas.width  - 1, Math.round(u * camCanvas.width))
                const py = Math.min(camCanvas.height - 1, Math.round(v * camCanvas.height))
                const i4 = py * camStride + px * 4
                r = camData[i4] / 255
                g = camData[i4 + 1] / 255
                b = camData[i4 + 2] / 255
              }

              bufferRef.current.addPoint(wx, wy, wz, r, g, b)
            }
          }
        }

        // ── Extract detected planes ────────────────────────────────────
        try {
          const newPlanes = extractPlanes(frame, refSpace)
          if (newPlanes.length > 0) planesRef.current = newPlanes
        } catch { /* optional */ }

        const count = bufferRef.current.pointCount
        // Update UI every ~30 points to avoid too-frequent renders
        if (count % 300 === 0) {
          setPointCount(count)
          // Rough progress based on denser target coverage (~250k points = 100%).
          setProgress(Math.min(99, Math.round((count / 250_000) * 100)))
        }

        rafRef.current = session.requestAnimationFrame(onXRFrame)
      }

      rafRef.current = session.requestAnimationFrame(onXRFrame)
    } catch (err) {
      document.body.removeChild(canvas)
      setStatus('error')
      setErrorMsg(`Could not start AR session: ${err.message}`)
    }
  }, [])

  /* ── Done scanning → stop session, package data ─────────────────────── */
  const finishScan = useCallback(async () => {
    setStatus('processing')

    // ── Native ARKit bridge ───────────────────────────────────────────────────
    if (window.__stageARNative) {
      // Swift side packages the data and calls window.onStageARResult({ status:'done', … })
      window.webkit.messageHandlers.stageAR.postMessage({ action: 'stopScan' })
      return
    }

    // Stop the RAF loop
    if (rafRef.current && sessionRef.current) {
      try { sessionRef.current.cancelAnimationFrame(rafRef.current) } catch { }
    }
    // End the XR session (removes the canvas it attached)
    if (sessionRef.current) {
      try { await sessionRef.current.end() } catch { }
      sessionRef.current = null
    }

    const buf = bufferRef.current
    if (!buf || buf.pointCount < 10) {
      setStatus('error')
      setErrorMsg('Not enough depth data captured. Try scanning again in a well-lit room.')
      return
    }

    // Serialise
    const pointCloud = buf.toJSON()
    const planes = planesToJSON(planesRef.current)

    setStatus('done')
    onComplete({ pointCloud, planes, capturedAt: Date.now() })
  }, [onComplete])

  /* ── Cancel ──────────────────────────────────────────────────────────── */
  const cancel = useCallback(async () => {
    if (rafRef.current && sessionRef.current) {
      try { sessionRef.current.cancelAnimationFrame(rafRef.current) } catch { }
    }
    if (sessionRef.current) {
      try { await sessionRef.current.end() } catch { }
      sessionRef.current = null
    }
    onCancel()
  }, [onCancel])

  /* ── Cleanup on unmount ───────────────────────────────────────────────── */
  useEffect(() => {
    return () => {
      if (rafRef.current && sessionRef.current) {
        try { sessionRef.current.cancelAnimationFrame(rafRef.current) } catch { }
      }
      if (sessionRef.current) {
        try { sessionRef.current.end() } catch { }
      }
    }
  }, [])

  /* ── UI ──────────────────────────────────────────────────────────────── */

  if (status === 'checking') {
    return (
      <div className="lidar-overlay">
        <div className="lidar-card">
          <div className="lidar-spinner" />
          <p className="lidar-status-text">Checking WebXR…</p>
          {errorMsg ? (
            <p className="lidar-desc lidar-desc--diag lidar-desc--checking">{errorMsg}</p>
          ) : (
            <p className="lidar-hint">Waiting for WebXR to initialise…</p>
          )}
        </div>
      </div>
    )
  }

  // ── iOS: honest dead-end screen ─────────────────────────────────────────────
  if (status === 'ios-unavailable') {
    return (
      <div className="lidar-overlay">
        <div className="lidar-card">
          {/* iPhone icon with strikethrough */}
          <svg className="lidar-warn-icon" viewBox="0 0 48 48" fill="none">
            <rect x="13" y="4" width="22" height="40" rx="4" stroke="#f97316" strokeWidth="2"/>
            <circle cx="24" cy="38" r="2" fill="#f97316" opacity="0.5"/>
            <line x1="8" y1="8" x2="40" y2="40" stroke="#f97316" strokeWidth="2.5" strokeLinecap="round"/>
          </svg>
          <h2 className="lidar-title">LiDAR Not Available on iOS</h2>
          <p className="lidar-desc">
            Apple has not shipped WebXR in Safari, and the only third-party iOS WebXR
            app (Mozilla WebXR Viewer) was abandoned in 2024 and no longer works on
            iOS 18 / iPhone 17 hardware.
          </p>
          <p className="lidar-desc" style={{ marginTop: 0, opacity: 0.7, fontSize: '13px' }}>
            LiDAR room scanning via web browser is not currently possible on iPhone.
            A native iOS app (using ARKit) would be required to access depth data.
          </p>
          <div className="lidar-ios-divider" />
          <p className="lidar-desc" style={{ fontSize: '12px', opacity: 0.55 }}>
            On Android, Chrome supports WebXR AR natively — LiDAR scanning works there.
          </p>
          <button className="lidar-btn lidar-btn--ghost" onClick={onCancel}>Close</button>
        </div>
      </div>
    )
  }

  if (status === 'unsupported') {
    return (
      <div className="lidar-overlay">
        <div className="lidar-card">
          <svg className="lidar-warn-icon" viewBox="0 0 48 48" fill="none">
            <circle cx="24" cy="24" r="22" stroke="#f97316" strokeWidth="2"/>
            <path d="M24 14v14" stroke="#f97316" strokeWidth="2.5" strokeLinecap="round"/>
            <circle cx="24" cy="33" r="1.5" fill="#f97316"/>
          </svg>
          <h2 className="lidar-title">LiDAR Not Available</h2>
          <p className="lidar-desc lidar-desc--diag">{errorMsg}</p>
          {directUrl && (
            /* No target="_blank" — WKWebView crashes trying to open new windows.
               Navigate in-place; the user is already in WebXR Viewer. */
            <a className="lidar-direct-url" href={directUrl}>
              {directUrl}
            </a>
          )}
          <div className="lidar-btn-row">
            <button className="lidar-btn lidar-btn--ghost" onClick={onCancel}>Close</button>
            <button className="lidar-btn lidar-btn--primary" onClick={() => setRetryCount(c => c + 1)}>Retry</button>
          </div>
        </div>
      </div>
    )
  }

  if (status === 'ready') {
    return (
      <div className="lidar-overlay">
        <div className="lidar-card">
          {/* Perspective scan icon */}
          <svg className="lidar-scan-icon" viewBox="0 0 80 80" fill="none">
            <rect x="8" y="8" width="64" height="64" rx="6" stroke="rgba(52,211,153,0.3)" strokeWidth="1.5"/>
            {/* corner brackets */}
            <path d="M8 24 L8 8 L24 8" stroke="#34d399" strokeWidth="2" strokeLinecap="round"/>
            <path d="M56 8 L72 8 L72 24" stroke="#34d399" strokeWidth="2" strokeLinecap="round"/>
            <path d="M72 56 L72 72 L56 72" stroke="#34d399" strokeWidth="2" strokeLinecap="round"/>
            <path d="M24 72 L8 72 L8 56" stroke="#34d399" strokeWidth="2" strokeLinecap="round"/>
            {/* Scan lines */}
            <line x1="8" y1="30" x2="72" y2="30" stroke="#34d399" strokeWidth="0.75" opacity="0.4"/>
            <line x1="8" y1="40" x2="72" y2="40" stroke="#34d399" strokeWidth="1" opacity="0.6"/>
            <line x1="8" y1="50" x2="72" y2="50" stroke="#34d399" strokeWidth="0.75" opacity="0.4"/>
            {/* Depth dots (perspective) */}
            <circle cx="22" cy="40" r="1.5" fill="#34d399" opacity="0.9"/>
            <circle cx="33" cy="36" r="1.5" fill="#22d3ee" opacity="0.9"/>
            <circle cx="40" cy="40" r="2" fill="#34d399"/>
            <circle cx="50" cy="38" r="1.5" fill="#a78bfa" opacity="0.9"/>
            <circle cx="58" cy="40" r="1.5" fill="#34d399" opacity="0.9"/>
          </svg>
          <h2 className="lidar-title">LiDAR Room Scan</h2>
          <p className="lidar-desc">
            Point your camera at the room and slowly pan across all walls, the floor, and the ceiling.
            The more you move, the denser the point cloud.
          </p>
          <ul className="lidar-tips">
            <li>📱 Hold phone upright, move slowly</li>
            <li>💡 Good lighting gives better colors</li>
            <li>🔄 Scan all four walls + floor + ceiling</li>
            <li>⏱️ 20–40 seconds for a good scan</li>
          </ul>
          <div className="lidar-btn-row">
            <button className="lidar-btn lidar-btn--ghost" onClick={onCancel}>Cancel</button>
            <button className="lidar-btn lidar-btn--primary" onClick={startScan}>
              Start Scanning
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (status === 'starting') {
    return (
      <div className="lidar-overlay">
        <div className="lidar-card">
          <div className="lidar-spinner" />
          <p className="lidar-status-text">Starting AR session…</p>
          <p className="lidar-hint">Grant camera permission when prompted</p>
        </div>
      </div>
    )
  }

  if (status === 'scanning') {
    // When running inside the native StageAR wrapper the full-screen ARSCNView
    // takes over — this web HUD is hidden behind it. Show a minimal screen just
    // in case the native view hasn't appeared yet, or for non-native WebXR path.
    if (window.__stageARNative) {
      // Native scan view is on top — just render nothing (blank behind it).
      return null
    }
    return (
      <div className="lidar-hud">
        <div className="lidar-hud-stats">
          <div className="lidar-hud-label">
            <span className="lidar-pts">{pointCount.toLocaleString()}</span>
            <span className="lidar-pts-unit">points</span>
          </div>
        </div>

        <p className="lidar-hud-tip">
          Pan slowly across all walls, floor &amp; ceiling
        </p>

        <div className="lidar-hud-btns">
          <button className="lidar-btn lidar-btn--ghost lidar-btn--sm" onClick={cancel}>
            Cancel
          </button>
          <button
            className="lidar-btn lidar-btn--primary"
            onClick={finishScan}
            disabled={pointCount < 500}
          >
            {pointCount < 500 ? 'Keep scanning…' : '✓ Done Scanning'}
          </button>
        </div>
      </div>
    )
  }

  if (status === 'processing') {
    return (
      <div className="lidar-overlay">
        <div className="lidar-card">
          <div className="lidar-spinner" />
          <p className="lidar-status-text">Processing scan…</p>
          <p className="lidar-hint">{pointCount.toLocaleString()} points captured</p>
          <div className="lidar-progress-track">
            <div className="lidar-progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <p className="lidar-progress-label">{progress}%</p>
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="lidar-overlay">
        <div className="lidar-card">
          <svg className="lidar-warn-icon" viewBox="0 0 48 48" fill="none">
            <circle cx="24" cy="24" r="22" stroke="#f97316" strokeWidth="2"/>
            <path d="M24 14v14" stroke="#f97316" strokeWidth="2.5" strokeLinecap="round"/>
            <circle cx="24" cy="33" r="1.5" fill="#f97316"/>
          </svg>
          <h2 className="lidar-title">Scan Failed</h2>
          <p className="lidar-desc lidar-desc--diag">{errorMsg}</p>
          <div className="lidar-btn-row">
            <button className="lidar-btn lidar-btn--ghost" onClick={onCancel}>Close</button>
            <button className="lidar-btn lidar-btn--primary" onClick={() => setStatus('ready')}>
              Try Again
            </button>
          </div>
        </div>
      </div>
    )
  }

  return null
}
