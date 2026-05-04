/**
 * Room3DViewer — An immersive Three.js interior room tour.
 *
 * - Camera sits at the center of the room (0,0,0).
 * - Drag to look around (spherical coordinate look-at).
 * - Each surface shows its perspective-warped photo (or a placeholder).
 * - Art pieces are rendered as small planes on their respective surfaces.
 * - Click a surface to open the 2D face editor.
 */
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { FACES, FACE_META, getFaceGeometry, pieceToWorld } from '../utils/room3d'

// Placeholder colors for surfaces without a photo
const PLACEHOLDER = {
  north: 0x1e2d3a, south: 0x1e2d3a, east: 0x1f2c3a,
  west:  0x1f2c3a, floor: 0x141a14, ceiling: 0x252535,
}

// Subtle ambient grid to make empty surfaces feel spatial
function buildGridHelper(faceId, room) {
  const { wM, hM, position, rotX, rotY } = getFaceGeometry(faceId, room)
  const div    = Math.min(10, Math.max(4, Math.round(Math.max(wM, hM) / 0.5)))
  const helper = new THREE.GridHelper(Math.max(wM, hM), div, 0x335566, 0x223344)
  // GridHelper lies in XZ plane by default; we need XY
  helper.rotation.x = Math.PI / 2
  helper.position.set(...position)
  helper.rotation.set(rotX, rotY, 0)
  return helper
}

export default function Room3DViewer({ room, onEditFace, onClose }) {
  const mountRef = useRef(null)

  useEffect(() => {
    if (!mountRef.current || !room) return
    const mount = mountRef.current

    // ── Renderer ─────────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth || 800, mount.clientHeight || 600)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    mount.appendChild(renderer.domElement)

    // ── Scene & camera ────────────────────────────────────────────────────────
    const scene  = new THREE.Scene()
    scene.background = new THREE.Color(0x090c10)

    const camera = new THREE.PerspectiveCamera(
      75, (mount.clientWidth || 800) / (mount.clientHeight || 600), 0.01, 500
    )
    camera.position.set(0, 0, 0)

    // ── Spherical look-around state ───────────────────────────────────────────
    // phi = polar angle from +Y axis (PI/2 = looking horizontally)
    // theta = azimuth in XZ plane (0 = looking toward -Z = north wall)
    let phi   = Math.PI / 2
    let theta = 0

    const updateLookAt = () => {
      phi = Math.max(0.05, Math.min(Math.PI - 0.05, phi))
      camera.lookAt(
        Math.sin(phi) * Math.sin(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.cos(theta),
      )
    }
    updateLookAt()

    // ── Build faces ───────────────────────────────────────────────────────────
    const texLoader  = new THREE.TextureLoader()
    const faceMeshes = []    // for raycasting

    FACES.forEach(faceId => {
      const surface = room.surfaces?.[faceId]
      const { position, rotX, rotY, wM, hM } = getFaceGeometry(faceId, room)
      const geo = new THREE.PlaneGeometry(wM, hM)

      let mat
      if (surface?.warpedImageUrl) {
        const tex = texLoader.load(surface.warpedImageUrl)
        tex.colorSpace = THREE.SRGBColorSpace
        // flipY = true (default) is correct for canvas-generated images
        mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide })
      } else {
        mat = new THREE.MeshBasicMaterial({
          color: PLACEHOLDER[faceId] ?? 0x1e2530,
          side:  THREE.FrontSide,
        })
        // Add a grid overlay so empty surfaces look intentional
        const grid = buildGridHelper(faceId, room)
        scene.add(grid)
      }

      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(...position)
      mesh.rotation.set(rotX, rotY, 0)
      mesh.userData.faceId = faceId
      scene.add(mesh)
      faceMeshes.push(mesh)

      // Thin frame around every face
      const edges   = new THREE.EdgesGeometry(geo)
      const lineMat = new THREE.LineBasicMaterial({ color: 0x3a5566 })
      const frame   = new THREE.LineSegments(edges, lineMat)
      frame.position.set(...position)
      frame.rotation.set(rotX, rotY, 0)
      scene.add(frame)

      // ── Art pieces on this surface ──────────────────────────────────────────
      const pieces = surface?.pieces ?? []
      pieces.forEach(piece => {
        const { x, y, z, rotX: prx, rotY: pry, pwM, phM } = pieceToWorld(
          faceId, piece.x, piece.y, piece.width, piece.height, room
        )
        const pgeo = new THREE.PlaneGeometry(pwM, phM)
        let pmat

        if (piece.image) {
          const ptex = texLoader.load(piece.image)
          ptex.colorSpace = THREE.SRGBColorSpace
          pmat = new THREE.MeshBasicMaterial({ map: ptex, side: THREE.FrontSide })
        } else {
          const hex = piece.color
            ? parseInt(piece.color.replace('#', ''), 16)
            : 0x888888
          pmat = new THREE.MeshBasicMaterial({ color: hex, side: THREE.FrontSide })
        }

        const pmesh = new THREE.Mesh(pgeo, pmat)
        pmesh.position.set(x, y, z)
        pmesh.rotation.set(prx, pry, 0)
        scene.add(pmesh)

        // Thin frame around each piece
        const pe    = new THREE.EdgesGeometry(pgeo)
        const plMat = new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.4, transparent: true })
        const pf    = new THREE.LineSegments(pe, plMat)
        pf.position.set(x, y, z)
        pf.rotation.set(prx, pry, 0)
        scene.add(pf)
      })
    })

    // ── Drag-to-look controls ─────────────────────────────────────────────────
    let isDragging = false
    let lastX = 0, lastY = 0
    let clickStartX = 0, clickStartY = 0
    const SENSITIVITY = 0.006

    const getCoords = e => e.touches ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
                                     : { x: e.clientX,            y: e.clientY            }

    const onPointerDown = e => {
      isDragging = true
      const { x, y } = getCoords(e)
      lastX = clickStartX = x
      lastY = clickStartY = y
    }
    const onPointerMove = e => {
      if (!isDragging) return
      const { x, y } = getCoords(e)
      theta -= (x - lastX) * SENSITIVITY
      phi   += (y - lastY) * SENSITIVITY
      lastX = x; lastY = y
      updateLookAt()
    }
    const onPointerUp = () => { isDragging = false }

    // ── Face click ────────────────────────────────────────────────────────────
    const raycaster = new THREE.Raycaster()
    const onClick = e => {
      if (!onEditFace) return
      if (Math.abs(e.clientX - clickStartX) + Math.abs(e.clientY - clickStartY) > 6) return
      const rect = renderer.domElement.getBoundingClientRect()
      const mx   = ((e.clientX - rect.left) / rect.width)  * 2 - 1
      const my   = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(new THREE.Vector2(mx, my), camera)
      const hits = raycaster.intersectObjects(faceMeshes)
      if (hits.length > 0) onEditFace(hits[0].object.userData.faceId)
    }

    const canvas = renderer.domElement
    canvas.addEventListener('mousedown',  onPointerDown)
    canvas.addEventListener('mousemove',  onPointerMove)
    canvas.addEventListener('mouseup',    onPointerUp)
    canvas.addEventListener('mouseleave', onPointerUp)
    canvas.addEventListener('touchstart', onPointerDown, { passive: true })
    canvas.addEventListener('touchmove',  onPointerMove, { passive: true })
    canvas.addEventListener('touchend',   onPointerUp)
    canvas.addEventListener('click',      onClick)

    // ── Resize handler ────────────────────────────────────────────────────────
    const onResize = () => {
      const w = mount.clientWidth, h = mount.clientHeight
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(mount)

    // ── Render loop ───────────────────────────────────────────────────────────
    let raf
    const animate = () => {
      raf = requestAnimationFrame(animate)
      renderer.render(scene, camera)
    }
    animate()

    // ── Cleanup ───────────────────────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('mousedown',  onPointerDown)
      canvas.removeEventListener('mousemove',  onPointerMove)
      canvas.removeEventListener('mouseup',    onPointerUp)
      canvas.removeEventListener('mouseleave', onPointerUp)
      canvas.removeEventListener('touchstart', onPointerDown)
      canvas.removeEventListener('touchmove',  onPointerMove)
      canvas.removeEventListener('touchend',   onPointerUp)
      canvas.removeEventListener('click',      onClick)
      // Dispose Three.js objects
      scene.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose()
        if (obj.material) {
          if (obj.material.map) obj.material.map.dispose()
          obj.material.dispose()
        }
      })
      renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
    }
  }, [room, onEditFace])

  return (
    <div className="room-viewer">
      <div ref={mountRef} className="room-viewer__canvas" />

      {/* HUD overlay */}
      <div className="room-viewer__hud">
        <div className="room-viewer__hud-top">
          <button className="room-viewer__close-btn" onClick={onClose}>
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M1 1l9 9M10 1L1 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            Exit Room
          </button>
          {room && (
            <span className="room-viewer__room-name">{room.name}</span>
          )}
        </div>
        <div className="room-viewer__tip">
          Drag to look around &nbsp;·&nbsp; Click a surface to edit
        </div>
      </div>

      {/* Face label buttons around the edges */}
      <div className="room-viewer__face-labels">
        {FACES.map(faceId => {
          const surface = room?.surfaces?.[faceId]
          return (
            <button
              key={faceId}
              className={`room-viewer__face-btn room-viewer__face-btn--${faceId} ${surface?.warpedImageUrl ? 'has-photo' : ''}`}
              onClick={() => onEditFace?.(faceId)}
              title={`Edit ${FACE_META[faceId].label}`}
            >
              {FACE_META[faceId].shortLabel}
            </button>
          )
        })}
      </div>
    </div>
  )
}
