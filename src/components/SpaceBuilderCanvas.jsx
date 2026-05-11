/**
 * SpaceBuilderCanvas3D — Three.js 3D builder canvas.
 * Drag bg = orbit | Scroll = zoom | Click = select | Drag surface = move (XZ)
 * Shift+drag = move Y | Arrow keys = rotate selected | Dbl-click = crop editor
 * Edge snap: drag a surface near another's edge → release to connect
 */
import { useRef, useState, useEffect, useCallback } from 'react'
import * as THREE from 'three'
import { SURFACE_COLORS, warpSurface } from '../utils/spaceAssembler'
import { warpPerspectiveAsync } from '../utils/homography'
import { PointCloudBuffer, planesFromJSON } from '../utils/pointCloud'
import { reconstructPlanarSurfaces } from '../utils/scanReconstructionPipeline'
import { applyOrbitJoystickStep, radiusToSlider, scaleZoomRadius, ZOOM_MIN, ZOOM_MAX } from '../utils/cameraControls'
import { HANDLE_OFFSET, HANDLE_PAD, HANDLE_DIR, HANDLE_COLORS } from '../utils/warpHandles'

const IN_TO_M   = 0.0254
const SNAP_DIST = 0.35
const EDGE_LIST = ['left', 'right', 'top', 'bottom']
const EDGE_LOCAL = {
  left:   new THREE.Vector3(-0.5, 0, 0),
  right:  new THREE.Vector3( 0.5, 0, 0),
  top:    new THREE.Vector3( 0,  0.5, 0),
  bottom: new THREE.Vector3( 0, -0.5, 0),
}
function edgeWorldMid(mesh, edge, wM, hM) {
  const v = EDGE_LOCAL[edge].clone(); v.x *= wM; v.y *= hM
  return v.applyMatrix4(mesh.matrixWorld)
}
function dims(s) { return { wM: s.widthIn * IN_TO_M, hM: s.heightIn * IN_TO_M } }

/**
 * Draw piece overlays on top of a base texture and return a composite data URL.
 * Base URL → offscreen canvas → draw each piece (image or solid colour) → JPEG.
 */
async function compositePiecesOntoTexture(surface, baseDataUrl, pieces) {
  return new Promise((resolve, reject) => {
    const base = new Image()
    base.onload = async () => {
      const canvas = document.createElement('canvas')
      canvas.width  = base.naturalWidth
      canvas.height = base.naturalHeight
      const ctx = canvas.getContext('2d')
      ctx.drawImage(base, 0, 0)

      const cW = canvas.width
      const cH = canvas.height

      for (const piece of pieces) {
        const px = (piece.x      / surface.widthIn)  * cW
        const py = (piece.y      / surface.heightIn) * cH
        const pw = (piece.width  / surface.widthIn)  * cW
        const ph = (piece.height / surface.heightIn) * cH

        if (piece.image) {
          await new Promise(res => {
            const img = new Image()
            img.crossOrigin = 'anonymous'
            img.onload  = () => { ctx.drawImage(img, px, py, pw, ph); res() }
            img.onerror = res  // skip on error
            img.src = piece.image
          })
        } else {
          // Solid colour fill
          ctx.fillStyle = piece.color || '#888888'
          ctx.fillRect(px, py, pw, ph)
          // Piece name label
          const fontSize = Math.max(10, Math.min(ph * 0.18, 22))
          ctx.font      = `bold ${fontSize}px sans-serif`
          ctx.fillStyle = '#ffffff'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(piece.name || '', px + pw / 2, py + ph / 2, pw)
        }
      }

      resolve(canvas.toDataURL('image/jpeg', 0.92))
    }
    base.onerror = reject
    base.src = baseDataUrl
  })
}

// ── Solid-disc splat shaders ────────────────────────────────────────────────
// Each LiDAR point renders as a solid opaque disc with a hard circular clip.
// depthWrite: true + opaque alpha means discs correctly occlude one another,
// so the point cloud reads as a solid coloured surface rather than a cloud of
// semi-transparent halos.
//
// splatScale is computed from a 10 cm voxel density and drives disc size
// so dense regions stay smooth while sparse areas stay readable.
//
// Sizing math (solid discs need ~10–20 % less radius than Gaussian blobs):
//   projectionMatrix[1][1] = cot(halfFOV_y) in column-major GLSL mat4.
//   At 55° FOV (cot≈2.05), depth 3 m, splatScale 1.0 → 7.0 * 2.05 / 3 ≈ 4.8 px.
//   Average inter-point gap at 3 m with 10 M points ≈ 1.15 px → gap completely
//   closed by a 2.4 px-radius opaque disc. Minimum 1.5 px ensures single-pixel
//   points are still visible at maximum zoom-out.

const SPLAT_VERT = /* glsl */`
  attribute float splatScale;
  attribute vec3  aNormal;
  varying   vec3  vColor;

  // Physically correct splat sizing: one rendered disc per deduplicated voxel.
  // Each voxel is CELL × CELL × CELL metres; the disc must cover its projected
  // footprint so no gaps appear between adjacent voxels.
  //
  // Derivation: a world-space diameter D at view-space depth z_view projects to
  //   px = D * proj[1][1] * (viewportHeight / 2) / (-z_view)   [framebuffer px]
  // Setting D = CELL * FILL_FACTOR (e.g. 1.15 → 15% overlap prevents seams):
  //   gl_PointSize = CELL * FILL * proj[1][1] * uViewH * 0.5 / -mvPos.z
  // uViewH is the framebuffer height in pixels (set each frame from renderer).
  uniform float uViewH;   // framebuffer height [px], updated by ResizeObserver

  void main() {
    vColor = color;
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);

    // View-dependent disc enlargement for surfaces seen at grazing angles.
    // Enlarging discs fills the perspective-stretched inter-voxel gaps on
    // walls viewed edge-on, without over-inflating head-on surfaces.
    vec3  mvN       = normalize(normalMatrix * aNormal);
    float cosView   = max(0.30, abs(mvN.z));
    float angleFactor = min(2.0, 1.0 / cosView);

    // RENDER_CELL = 0.025 m, FILL = 1.15 (15% overlap) → disc world diameter = 0.029 m.
    // multiply by 0.5 (radius) × 2 (proj NDC → half-screen): factor cancels to 1.
    float worldDiam  = 0.029 * splatScale * angleFactor;
    gl_PointSize = clamp(worldDiam * projectionMatrix[1][1] * uViewH * 0.5 / -mvPos.z, 1.5, 80.0);
    gl_Position  = projectionMatrix * mvPos;
  }
`

const SPLAT_FRAG = /* glsl */`
  varying vec3 vColor;
  uniform int uDiagMode; // 0=normal, 1=depth-false-color, 2=normal-dir

  void main() {
    // Hard circular clip — discard corners of the GL_POINT square.
    vec2  uv = gl_PointCoord - 0.5;
    float r2 = dot(uv, uv);
    if (r2 > 0.25) discard;

    vec3 col;
    if (uDiagMode == 1) {
      // Depth false-colour: near=warm, far=cool
      float d = gl_FragCoord.z;
      col = mix(vec3(1.0, 0.3, 0.0), vec3(0.0, 0.4, 1.0), clamp(d * 2.0 - 0.5, 0.0, 1.0));
    } else {
      // Normal colour grading: +35% saturation + gamma lift
      col = vColor;
      float luma = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(luma), col, 1.35);
      col = pow(clamp(col, 0.0, 1.0), vec3(0.88));
    }

    // Soft alphaToCoverage edge — inner 72% solid, outer 28% feathers.
    float alpha = r2 < 0.18 ? 1.0 : smoothstep(0.25, 0.18, r2);
    gl_FragColor = vec4(col, alpha);
  }
`

// ── Screen-Space Depth Dilation (SSDD) ─────────────────────────────────────
// Post-processing pass that runs after the point cloud is rendered to an FBO.
// For every screen pixel whose depth = 1.0 (background / gap between dots) we
// search a (2R+1)² neighbourhood and fill it with the colour of the nearest
// occupied pixel (minimum depth).  This makes the point cloud appear perfectly
// solid with no visible holes — regardless of disc size or camera distance.
//
// Why min-depth (not nearest pixel)?
//   Taking the minimum depth finds the closest surface in the neighbourhood,
//   which is correct — we want foreground surfaces to fill gaps, not distant walls.
//
// Performance:  the early-return in the fragment shader means the expensive
//   9×9 search runs only on empty pixels (background + inter-point gaps).
//   For a dense room scan, typically < 20 % of pixels trigger the search.

const SSDD_VERT = /* glsl */`
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`

const SSDD_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2      uRes;
  uniform vec3      uBg;

  void main() {
    vec2  uv = gl_FragCoord.xy / uRes;
    float d  = texture2D(tDepth, uv).r;

    // Occupied pixel — pass through unchanged.
    if (d < 0.9999) { gl_FragColor = texture2D(tColor, uv); return; }

    // Gap pixel — find the closest (min depth) occupied neighbour in a
    // 13×13 window and fill with that exact pixel's colour.  Min-depth
    // ensures foreground surfaces fill gaps; no averaging so sharp colour
    // transitions between surfaces are preserved (no blurry mosaic artefacts).
    float bestD = 2.0;
    vec4  bestC = vec4(uBg, 1.0);
    for (int xi = -6; xi <= 6; xi++) {
      for (int yi = -6; yi <= 6; yi++) {
        vec2  suv = uv + vec2(float(xi), float(yi)) / uRes;
        float nd  = texture2D(tDepth, suv).r;
        if (nd < bestD) { bestD = nd; bestC = texture2D(tColor, suv); }
      }
    }
    gl_FragColor = (bestD < 0.9999) ? bestC : vec4(uBg, 1.0);
  }
`

const FOV_PRESETS = [
  { label: 'Normal', fov: 55  },
  { label: 'Wide',   fov: 90  },
  { label: 'Fish',   fov: 120 },
  { label: 'Ultra',  fov: 140 },
]
const JOY_RADIUS = 36   // outer pad radius px
const JOY_THUMB  = 13   // thumb radius px
const JOY_SPEED    = 0.014  // halved from 0.028 — was too sensitive
const PAN_SPEED    = 0.04   // orbit.center translation per frame per unit joystick deflection
const DOLLY_SPEED  = 0.04   // radius change per frame (same units as PAN_SPEED)
const ENABLE_RECONSTRUCTION_OVERLAY = false

export default function SpaceBuilderCanvas({
  space, activeSurfaceId, onSelectSurface, onUpdateSurface, onSetConnection, onSurfaceTap, requestCropId,
  roomScan = null,
  onSurfaceFromView = null,
  onRoomScanLoadProgress = null,
}) {
  const mountRef = useRef(null)
  const threeRef  = useRef(null)
  const stateRef  = useRef({})
  const compTexCacheRef = useRef(new Map()) // Map<surfaceId, { key: string, dataUrl: string }>
  const joystickRef    = useRef({ active: false, nx: 0, ny: 0 })  // orbit  — read in RAF loop
  const panJoystickRef = useRef({ active: false, nx: 0, ny: 0 })  // pan    — read in RAF loop
  const fwdJoystickRef = useRef({ active: false, nx: 0, ny: 0 })  // dolly  — read in RAF loop
  const [snapHint,      setSnapHint]      = useState(null)
  const [cropSurfaceId, setCropSurfaceId] = useState(null)
  const [fov,           setFov]           = useState(55)
  const [zoomRadius,    setZoomRadius]    = useState(8)   // mirrors orbit.radius for slider UI
  const setZoomRef = useRef(setZoomRadius)                 // stable ref so onWheel closure can call it
  setZoomRef.current = setZoomRadius
  // When a room scan is loaded, orbit switches to FPS mode (camera rotates in
  // place at orbit.center) rather than classic third-person orbit around a pivot.
  const cameraFPSRef = useRef(false)
  const [joyPos,        setJoyPos]        = useState({ x: 0, y: 0 }) // orbit thumb CSS offset
  const [panJoyPos,     setPanJoyPos]     = useState({ x: 0, y: 0 }) // pan thumb CSS offset
  const [fwdJoyPos,     setFwdJoyPos]     = useState({ x: 0, y: 0 }) // fwd/back thumb CSS offset
  stateRef.current = { space, activeSurfaceId, onSelectSurface, onUpdateSurface, onSetConnection, onSurfaceTap }

  const prevCropReqRef = useRef(null)
  useEffect(() => {
    if (requestCropId && requestCropId !== prevCropReqRef.current) {
      prevCropReqRef.current = requestCropId
      // requestCropId is "surfaceId_timestamp" — strip the nonce suffix
      const realId = requestCropId.replace(/_\d+$/, '')
      setCropSurfaceId(realId)
    }
  }, [requestCropId])

  // ── Scene init (runs once) ───────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    mount.appendChild(renderer.domElement)

    // ── SSDD: offscreen FBO + fullscreen dilation quad ─────────────────────
    // The main scene is rendered into `ssdFBO` (color + depth), then the
    // dilation shader reads both textures and fills inter-point gaps.
    const makeSSDF = (w, h) => {
      const dt = new THREE.DepthTexture(w, h)
      dt.type = THREE.UnsignedIntType
      return new THREE.WebGLRenderTarget(w, h, {
        minFilter:   THREE.NearestFilter,
        magFilter:   THREE.NearestFilter,
        depthTexture: dt,
      })
    }
    const ssdFBO = makeSSDF(renderer.domElement.width, renderer.domElement.height)
    const ssdUniforms = {
      tColor: { value: ssdFBO.texture },
      tDepth: { value: ssdFBO.depthTexture },
      uRes:   { value: new THREE.Vector2(renderer.domElement.width, renderer.domElement.height) },
      uBg:    { value: new THREE.Color(0x080d14) },
    }
    const ssdQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms:       ssdUniforms,
        vertexShader:   SSDD_VERT,
        fragmentShader: SSDD_FRAG,
        depthTest:  false,
        depthWrite: false,
      }),
    )
    ssdQuad.frustumCulled = false
    const ssdScene = new THREE.Scene()
    const ssdCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    ssdScene.add(ssdQuad)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x080d14)
    scene.add(new THREE.GridHelper(40, 80, 0x0f1e30, 0x0f1e30))

    const camera = new THREE.PerspectiveCamera(55, mount.clientWidth / mount.clientHeight, 0.01, 200)
    const orbit = { phi: 1.1, theta: 0.4, radius: 8, center: new THREE.Vector3() }
    function applyOrbit() {
      orbit.phi = Math.max(0.05, Math.min(Math.PI - 0.05, orbit.phi))
      if (cameraFPSRef.current) {
        // ── FPS mode (room scan loaded) ───────────────────────────────────────
        // Camera sits at orbit.center and rotates in place — no external pivot.
        // Dragging looks around, pan joystick strafes, fwd joystick/scroll flies.
        camera.position.copy(orbit.center)
        camera.lookAt(
          orbit.center.x + Math.sin(orbit.phi) * Math.sin(orbit.theta),
          orbit.center.y + Math.cos(orbit.phi),
          orbit.center.z + Math.sin(orbit.phi) * Math.cos(orbit.theta),
        )
      } else {
        // ── Classic orbit (surface-only mode) ────────────────────────────────
        camera.position.set(
          orbit.center.x + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta),
          orbit.center.y + orbit.radius * Math.cos(orbit.phi),
          orbit.center.z + orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta),
        )
        camera.lookAt(orbit.center)
      }
    }
    applyOrbit()

    const texLoader = new THREE.TextureLoader()
    const meshMap = {}   // { [surfaceId]: { mesh, wM, hM } }

    // Returns the best available texture URL for a surface.
    // Priority: composite overlay (pieces) > inpaint layer > stitched seam > warped > raw photo.
    function getTexUrl(surface) {
      const cached = compTexCacheRef.current.get(surface.id)
      if (cached) return cached.dataUrl
      if (surface.inpaintDataUrl)  return surface.inpaintDataUrl
      if (surface.stitchedDataUrl) return surface.stitchedDataUrl
      if (surface.warpedDataUrl)   return surface.warpedDataUrl
      return stateRef.current.space.photos.find(p => p.id === surface.photoId)?.dataUrl || null
    }

    function buildMesh(surface) {
      const { wM, hM } = dims(surface)
      const geo = new THREE.PlaneGeometry(wM, hM)
      let mat
      const texUrl = getTexUrl(surface)
      if (texUrl) {
        const tex = texLoader.load(texUrl)
        tex.colorSpace = THREE.SRGBColorSpace
        mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide })
      } else {
        const hex = parseInt((SURFACE_COLORS[surface.colorIdx ?? 0] || '#4a9eff').replace('#', ''), 16)
        mat = new THREE.MeshBasicMaterial({ color: hex, side: THREE.DoubleSide, transparent: true, opacity: 0.55 })
      }
      const mesh = new THREE.Mesh(geo, mat)
      mesh.userData.surfaceId = surface.id
      // Position
      if (surface.pose3d) {
        mesh.position.fromArray(surface.pose3d.position)
      } else {
        const surfs = stateRef.current.space.surfaces
        const idx = surfs.findIndex(s => s.id === surface.id)
        mesh.position.set((idx - (surfs.length - 1) / 2) * (wM + 0.3), hM / 2, 0)
      }
      // Rotation — rotYDeg is authoritative for Y; pose3d.rotX for pitch
      mesh.rotation.set(
        surface.pose3d?.rotX ?? 0,
        (surface.rotYDeg ?? 0) * Math.PI / 180,
        0,
      )
      const edgesMesh = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0x3a5566 })
      )
      mesh.add(edgesMesh)
      scene.add(mesh)
      meshMap[surface.id] = { mesh, wM, hM, texUrl }
    }

    function syncMeshes(surfaces) {
      const ids = new Set(surfaces.map(s => s.id))
      for (const id of Object.keys(meshMap)) {
        if (!ids.has(id)) {
          scene.remove(meshMap[id].mesh)
          meshMap[id].mesh.traverse(o => {
            if (o.geometry) o.geometry.dispose()
            if (o.material?.map) o.material.map.dispose()
            if (o.material) o.material.dispose()
          })
          delete meshMap[id]
        }
      }
      for (const surface of surfaces) {
        if (!meshMap[surface.id]) {
          buildMesh(surface)
        } else {
          const entry = meshMap[surface.id]
          const { wM, hM } = dims(surface)
          // Texture: rebuild whenever the best-available URL changes
          const newTexUrl = getTexUrl(surface)
          if (newTexUrl !== entry.texUrl) {
            if (entry.mesh.material.map) entry.mesh.material.map.dispose()
            entry.mesh.material.dispose()
            if (newTexUrl) {
              const tex = texLoader.load(newTexUrl)
              tex.colorSpace = THREE.SRGBColorSpace
              entry.mesh.material = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide })
            } else {
              const hex = parseInt((SURFACE_COLORS[surface.colorIdx ?? 0] || '#4a9eff').replace('#', ''), 16)
              entry.mesh.material = new THREE.MeshBasicMaterial({ color: hex, side: THREE.DoubleSide, transparent: true, opacity: 0.55 })
            }
            entry.texUrl = newTexUrl
          }
          // Geometry: resize if dims changed
          if (Math.abs(entry.wM - wM) > 0.001 || Math.abs(entry.hM - hM) > 0.001) {
            entry.mesh.geometry.dispose()
            entry.mesh.geometry = new THREE.PlaneGeometry(wM, hM)
            const child = entry.mesh.children[0]
            if (child) { child.geometry.dispose(); child.geometry = new THREE.EdgesGeometry(entry.mesh.geometry) }
            entry.wM = wM; entry.hM = hM
          }
          // Rotation: rotYDeg is always authoritative for Y; pose3d.rotX for pitch
          entry.mesh.rotation.set(
            surface.pose3d?.rotX ?? 0,
            (surface.rotYDeg ?? 0) * Math.PI / 180,
            0,
          )
          // Position: from pose3d when available
          if (surface.pose3d) {
            entry.mesh.position.fromArray(surface.pose3d.position)
          }
        }
      }
    }

    function applySelection(activeId) {
      for (const [id, entry] of Object.entries(meshMap)) {
        const line = entry.mesh.children[0]
        if (line) line.material.color.set(id === activeId ? 0xffffff : 0x3a5566)
      }
    }

    const raycaster = new THREE.Raycaster()
    function raycast(clientX, clientY) {
      const rect = renderer.domElement.getBoundingClientRect()
      const mouse = new THREE.Vector2(
        ((clientX - rect.left) / rect.width)  * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      )
      raycaster.setFromCamera(mouse, camera)
      const hits = raycaster.intersectObjects(Object.values(meshMap).map(e => e.mesh))
      // Only accept hits on the visible (front) face of a surface.
      // Filters out back-face hits (DoubleSide planes behind other objects) and
      // nearly edge-on surfaces that the user isn't really aiming at.
      const validHits = hits.filter(hit => {
        if (!hit.face) return false
        const worldNormal = hit.face.normal.clone().applyQuaternion(hit.object.quaternion)
        // Accept front OR back face hits; only reject nearly edge-on surfaces.
        // |dot| > 0.15 means the ray is within ≈81° of either face normal.
        return Math.abs(worldNormal.dot(raycaster.ray.direction)) > 0.15
      })
      return validHits[0] ?? null
    }

    function computeSnap(movingId) {
      const me = meshMap[movingId]; if (!me) return null
      for (const fe of EDGE_LIST) {
        const fm = edgeWorldMid(me.mesh, fe, me.wM, me.hM)
        for (const [oid, oe] of Object.entries(meshMap)) {
          if (oid === movingId) continue
          for (const te of EDGE_LIST) {
            if (fm.distanceTo(edgeWorldMid(oe.mesh, te, oe.wM, oe.hM)) < SNAP_DIST)
              return { fromId: movingId, fromEdge: fe, toId: oid, toEdge: te }
          }
        }
      }
      return null
    }

    function applySnap(hint) {
      const { fromId, fromEdge, toId, toEdge } = hint
      const fe = meshMap[fromId]; const te = meshMap[toId]
      if (!fe || !te) return
      // Move "from" so its snapping edge midpoint coincides with "to"'s edge midpoint.
      // Rotation is intentionally NOT changed — the user sets the angle with the slider.
      const toMid   = edgeWorldMid(te.mesh, toEdge, te.wM, te.hM)
      const fromMid = edgeWorldMid(fe.mesh, fromEdge, fe.wM, fe.hM)
      fe.mesh.position.add(toMid.sub(fromMid))
      // Persist position only; keep existing rotYDeg intact
      stateRef.current.onUpdateSurface(fromId, {
        pose3d: { position: fe.mesh.position.toArray(), rotX: fe.mesh.rotation.x },
      })
      stateRef.current.onSetConnection(fromId, fromEdge, { surfaceId: toId, edge: toEdge, angleDeg: 90 })
    }

    // Drag state
    const drag = { active: false, hadMoved: false, type: null, surfaceId: null, startX: 0, startY: 0 }

    function onDown(e) {
      if (e.button !== 0) return
      drag.startX = e.clientX; drag.startY = e.clientY; drag.hadMoved = false
      const hit = raycast(e.clientX, e.clientY)
      if (hit) {
        // Walk up parent chain (LineSegments child may be hit instead of Mesh)
        let obj = hit.object
        while (obj && !obj.userData.surfaceId) obj = obj.parent
        const id = obj?.userData.surfaceId
        if (id) {
          // Always select the surface (works from front and back face)
          stateRef.current.onSelectSurface(id)
          // Only start a surface DRAG on front-face hits — back-face clicks
          // should orbit so the user doesn't accidentally drag invisible walls
          const worldNormal = hit.face.normal.clone().applyQuaternion(hit.object.quaternion)
          const isFront = worldNormal.dot(raycaster.ray.direction) < 0
          if (isFront) {
            drag.active = true; drag.type = 'surface'; drag.surfaceId = id
          } else {
            drag.active = true; drag.type = 'orbit'
          }
        } else {
          drag.active = true; drag.type = 'orbit'
        }
      } else {
        drag.active = true; drag.type = 'orbit'
      }
    }

    function onMove(e) {
      if (!drag.active) return
      const dx = e.clientX - drag.startX; const dy = e.clientY - drag.startY
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.hadMoved = true
      if (drag.type === 'orbit') {
        orbit.theta -= dx * 0.005; orbit.phi += dy * 0.005; applyOrbit()
      } else if (drag.type === 'surface') {
        const entry = meshMap[drag.surfaceId]; if (!entry) return
        // Camera-space drag: move surface in screen plane at surface depth
        const dist = Math.max(0.5, camera.position.distanceTo(entry.mesh.position))
        const rect = renderer.domElement.getBoundingClientRect()
        const scale = (2 * dist * Math.tan(camera.fov * Math.PI / 360)) / rect.height
        const camFwd   = new THREE.Vector3()
        camera.getWorldDirection(camFwd)
        const camRight = new THREE.Vector3().crossVectors(camFwd, camera.up).normalize()
        const camUp    = new THREE.Vector3().crossVectors(camRight, camFwd).normalize()
        if (e.shiftKey) {
          // Shift: move only vertically (world Y)
          entry.mesh.position.y -= dy * scale
        } else {
          entry.mesh.position.addScaledVector(camRight,  dx * scale)
          entry.mesh.position.addScaledVector(camUp,    -dy * scale)
        }
        setSnapHint(computeSnap(drag.surfaceId))
      }
      drag.startX = e.clientX; drag.startY = e.clientY
    }

    function onUp() {
      if (drag.type === 'surface' && drag.hadMoved) {
        const entry = meshMap[drag.surfaceId]
        if (entry) {
          const hint = computeSnap(drag.surfaceId)
          if (hint) applySnap(hint)
          else stateRef.current.onUpdateSurface(drag.surfaceId, {
            pose3d: { position: entry.mesh.position.toArray(), rotX: entry.mesh.rotation.x },
          })
        }
        setSnapHint(null)
      } else if (drag.type === 'surface' && !drag.hadMoved) {
        // Tap (not drag) on a surface — notify parent to open panel on mobile
        stateRef.current.onSurfaceTap?.()
      }
      drag.active = false; drag.hadMoved = false; drag.type = null; drag.surfaceId = null
    }

    function onWheel(e) {
      if (cameraFPSRef.current) {
        // FPS: scroll flies along look direction (positive deltaY = scroll down = step back)
        const sphi = Math.sin(orbit.phi), cphi = Math.cos(orbit.phi)
        const sth  = Math.sin(orbit.theta), cth = Math.cos(orbit.theta)
        const step = e.deltaY * 0.003
        orbit.center.x -= sphi * sth * step
        orbit.center.y -= cphi       * step
        orbit.center.z -= sphi * cth * step
        applyOrbit()
        setZoomRef.current(prev => scaleZoomRadius(prev, Math.exp(e.deltaY * 0.001), ZOOM_MIN, ZOOM_MAX))
      } else {
        // Classic: scroll changes orbit radius
        orbit.radius = scaleZoomRadius(orbit.radius, 1 + e.deltaY * 0.001, ZOOM_MIN, ZOOM_MAX)
        applyOrbit()
        setZoomRef.current(orbit.radius)
      }
    }

    function onDbl(e) {
      const hit = raycast(e.clientX, e.clientY)
      if (hit) setCropSurfaceId(hit.object.userData.surfaceId)
    }

    // ── Touch equivalents for drag (orbit + surface move) ───────────────
    function onTouchStart(e) {
      if (e.touches.length !== 1) return
      // Prevent scroll/zoom while dragging the canvas
      e.preventDefault()
      const t = e.touches[0]
      onDown({ button: 0, clientX: t.clientX, clientY: t.clientY })
    }
    function onTouchMove(e) {
      if (e.touches.length !== 1) return
      e.preventDefault()
      const t = e.touches[0]
      onMove({ clientX: t.clientX, clientY: t.clientY, shiftKey: false })
    }
    function onTouchEnd(e) {
      e.preventDefault()
      // If double-tap (two rapid taps), treat as dblclick
      const now = Date.now()
      if (now - (canvas._lastTap || 0) < 300) {
        const lx = canvas._lastTapX || 0, ly = canvas._lastTapY || 0
        const ct = e.changedTouches[0]
        if (Math.abs(ct.clientX - lx) < 20 && Math.abs(ct.clientY - ly) < 20) {
          onDbl({ clientX: ct.clientX, clientY: ct.clientY })
        }
        canvas._lastTap = 0
      } else {
        canvas._lastTap = now
        if (e.changedTouches[0]) {
          canvas._lastTapX = e.changedTouches[0].clientX
          canvas._lastTapY = e.changedTouches[0].clientY
        }
      }
      onUp()
    }

    const canvas = renderer.domElement
    canvas.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    canvas.addEventListener('wheel',     onWheel, { passive: true })
    canvas.addEventListener('dblclick',  onDbl)
    // Touch events — passive:false so we can preventDefault and stop scroll
    canvas.addEventListener('touchstart', onTouchStart, { passive: false })
    canvas.addEventListener('touchmove',  onTouchMove,  { passive: false })
    canvas.addEventListener('touchend',   onTouchEnd,   { passive: false })

    const ro = new ResizeObserver(() => {
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(mount.clientWidth, mount.clientHeight)
      const w = renderer.domElement.width, h = renderer.domElement.height
      ssdFBO.setSize(w, h)
      ssdUniforms.uRes.value.set(w, h)
      // Keep splat sizes physically correct after canvas resize / orientation change.
      const mat = pointCloudMeshRef.current?.material
      if (mat?.uniforms?.uViewH) mat.uniforms.uViewH.value = h
    })
    ro.observe(mount)

    let raf
    const animate = () => {
      raf = requestAnimationFrame(animate)
      let needsUpdate = false

      // Continuous orbit joystick — rotates around the center point
      // ny is inverted: joystick-up (ny < 0) should move camera higher → phi decreases
      const joy = joystickRef.current
      if (joy.active && (joy.nx !== 0 || joy.ny !== 0)) {
        needsUpdate = applyOrbitJoystickStep(orbit, joy.nx, joy.ny, JOY_SPEED) || needsUpdate
      }

      // Continuous pan / move joystick
      const pan = panJoystickRef.current
      if (pan.active && (pan.nx !== 0 || pan.ny !== 0)) {
        if (cameraFPSRef.current) {
          // FPS mode — Move joystick:
          //   X axis: strafe left/right  (camera right = (-cosθ, 0, sinθ) in world XZ)
          //   Y axis: strafe up/down     (world-Y; joystick up → orbit.center.y increases)
          // Forward/back is handled separately by the Fwd joystick.
          const sth = Math.sin(orbit.theta), cth = Math.cos(orbit.theta)
          orbit.center.x -= pan.nx * PAN_SPEED * cth   // strafe left/right
          orbit.center.z += pan.nx * PAN_SPEED * sth
          orbit.center.y -= pan.ny * PAN_SPEED          // strafe up/down (ny<0=up=y increases)
        } else {
          // Classic orbit — world-XZ pan + world-Y vertical
          orbit.center.x +=  pan.nx * PAN_SPEED * Math.cos(orbit.theta)
          orbit.center.z -= pan.nx * PAN_SPEED * Math.sin(orbit.theta)
          orbit.center.y -=  pan.ny * PAN_SPEED
        }
        needsUpdate = true
      }

      // Forward/Back (dolly) joystick.
      // FPS mode: fly along the camera look direction (ny < 0 = joystick up = forward).
      // Classic mode: change orbit.radius to dolly toward/away from the pivot.
      const fwd = fwdJoystickRef.current
      if (fwd.active && fwd.ny !== 0) {
        if (cameraFPSRef.current) {
          const sphi = Math.sin(orbit.phi), cphi = Math.cos(orbit.phi)
          const sth  = Math.sin(orbit.theta), cth = Math.cos(orbit.theta)
          // ny < 0 (joystick up) = forward → add look direction
          orbit.center.x += sphi * sth * (-fwd.ny) * DOLLY_SPEED
          orbit.center.y += cphi       * (-fwd.ny) * DOLLY_SPEED
          orbit.center.z += sphi * cth * (-fwd.ny) * DOLLY_SPEED
        } else {
          const newR = Math.max(0.1, Math.min(80, orbit.radius + fwd.ny * DOLLY_SPEED))
          orbit.radius = newR
          setZoomRef.current(newR)
        }
        needsUpdate = true
      }

      if (needsUpdate) applyOrbit()
      // Two-pass SSDD: render scene to FBO, then blit through gap-fill shader.
      renderer.setRenderTarget(ssdFBO)
      renderer.render(scene, camera)
      renderer.setRenderTarget(null)
      renderer.render(ssdScene, ssdCam)
    }
    animate()

    threeRef.current = { syncMeshes, applySelection, meshMap, orbit, applyOrbit, camera, scene, renderer, ssdFBO }

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
      canvas.removeEventListener('wheel',     onWheel)
      canvas.removeEventListener('dblclick',  onDbl)
      canvas.removeEventListener('touchstart', onTouchStart)
      canvas.removeEventListener('touchmove',  onTouchMove)
      canvas.removeEventListener('touchend',   onTouchEnd)
      scene.traverse(o => {
        if (o.geometry) o.geometry.dispose()
        if (o.material?.map) o.material.map.dispose()
        if (o.material) o.material.dispose()
      })
      ssdFBO.dispose()
      renderer.dispose()
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
      threeRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { threeRef.current?.syncMeshes(space.surfaces) }, [space.surfaces])
  useEffect(() => { threeRef.current?.applySelection(activeSurfaceId) }, [activeSurfaceId])

  // ── Point cloud / room scan rendering ────────────────────────────────────
  const pointCloudMeshRef = useRef(null)
  const planeMeshesRef    = useRef([])
  const reconstructionMeshesRef = useRef([])
  const yOffsetRef        = useRef(0)
  const rawBufferRef      = useRef(null)  // decoded PointCloudBuffer for LiDAR measurement
  const diagStatsRef      = useRef(null)  // { rawPts, renderedPts, fboW, fboH, dpr }
  const [diagVisible,     setDiagVisible]  = useState(false)
  const [diagMode,        setDiagMode]     = useState(0)  // 0=color, 1=depth, 2=normals
  const roomLoadProgressRef = useRef({ pct: -1, phase: '', ts: 0 })
  const reportRoomLoad = useCallback((pct, phase, active = true) => {
    if (!onRoomScanLoadProgress) return
    const now = performance.now()
    const clamped = Math.max(0, Math.min(100, Math.round(pct)))
    const prev = roomLoadProgressRef.current
    const enoughDelta = Math.abs(clamped - prev.pct) >= 2
    const phaseChanged = phase !== prev.phase
    const enoughTime = now - prev.ts >= 120
    if (!phaseChanged && !enoughDelta && !enoughTime) return
    roomLoadProgressRef.current = { pct: clamped, phase, ts: now }
    try { onRoomScanLoadProgress({ pct: clamped, phase, active }) } catch (err) { void err }
  }, [onRoomScanLoadProgress])
  useEffect(() => {
    const t = threeRef.current
    if (!t) return

    // Remove old point cloud + plane meshes
    if (pointCloudMeshRef.current) {
      t.scene.remove(pointCloudMeshRef.current)
      pointCloudMeshRef.current.geometry.dispose()
      pointCloudMeshRef.current.material.dispose()
      pointCloudMeshRef.current = null
    }
    for (const m of planeMeshesRef.current) {
      t.scene.remove(m)
      m.geometry.dispose(); m.material.dispose()
    }
    planeMeshesRef.current = []
    for (const m of reconstructionMeshesRef.current) {
      t.scene.remove(m)
      m.geometry.dispose(); m.material.dispose()
    }
    reconstructionMeshesRef.current = []

    // Switch orbit style based on whether a scan is loaded
    cameraFPSRef.current = !!roomScan

    if (!roomScan) {
      reportRoomLoad(0, 'No scan loaded', false)
      return
    }

    let cancelled = false

    // Resolve the PointCloudBuffer from any of three storage formats:
    //   { _buffer }      — live scan, already decoded in memory (fastest)
    //   { url }          — loaded from server, fetch the binary blob
    //   { data }         — legacy base64 JSON format
    async function buildCloud() {
      let buf
      const pc = roomScan.pointCloud
      reportRoomLoad(3, 'Preparing room scan')
      try {
        if (pc?._buffer) {
          reportRoomLoad(24, 'Using cached scan data')
          buf = pc._buffer
        } else if (pc?.url) {
          const resp = await fetch(pc.url)
          if (!resp.ok) throw new Error(`Failed to load point cloud: ${resp.status}`)
          const totalBytes = Number(resp.headers.get('content-length') || 0)
          let ab
          if (resp.body?.getReader && totalBytes > 0) {
            const reader = resp.body.getReader()
            const merged = new Uint8Array(totalBytes)
            let received = 0
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              if (!value) continue
              const end = Math.min(totalBytes, received + value.byteLength)
              merged.set(value.subarray(0, end - received), received)
              received += value.byteLength
              if (!cancelled) {
                reportRoomLoad(4 + (34 * received / totalBytes), 'Downloading scan')
              }
            }
            ab = received === totalBytes
              ? merged.buffer
              : merged.subarray(0, Math.max(0, Math.min(received, totalBytes))).buffer
          } else {
            reportRoomLoad(14, 'Downloading scan')
            ab = await resp.arrayBuffer()
            reportRoomLoad(38, 'Download complete')
          }
          buf = PointCloudBuffer.fromFloat32Array(new Float32Array(ab), pc.pointCount)
          reportRoomLoad(42, 'Decoding point cloud')
        } else if (pc?.data) {
          reportRoomLoad(22, 'Decoding legacy scan payload')
          buf = PointCloudBuffer.fromJSON(pc)
        } else {
          reportRoomLoad(100, 'No point cloud payload', false)
          return
        }
      } catch (err) {
        console.warn('[SpaceBuilderCanvas] Could not load point cloud:', err)
        reportRoomLoad(100, 'Scan load failed', false)
        return
      }
      if (cancelled) return

      // ── Build colored point cloud ─────────────────────────────────
      try {
        // Zero-copy: access buf._data directly rather than toFloat32Array()
        // which would copy the entire array (240 MB for a 10M-point scan).
        const rawData = buf._data
        const n       = buf.pointCount

        // ── 3-pass algorithm ─────────────────────────────────────────────────
        //
        // Pass 1 (SOR, 10 cm grid): build coarse voxel map for outlier removal.
        //   Floating noise blobs that have fewer than SOR_MIN neighbours in the
        //   3×3×3 surrounding cells are tagged as outliers and skipped.
        //   10 cm cells are intentionally coarse so each cell has enough points
        //   for a reliable neighbourhood count; the SOR is insensitive to grid
        //   resolution as long as it's large enough to aggregate returns.
        //
        // Pass 2 (Render dedup, 2.5 cm grid): deduplicate to one representative
        //   point per 2.5 cm render-voxel.  2.5 cm gives fine enough granularity
        //   that individual textural details (bricks, wood grain) are preserved,
        //   while still reducing a 10 M-point scan to ~300 K–1 M render points.
        //   Position = average centroid; colour = per-channel median (9 samples).
        //
        // Yield points after each heavy phase let the browser repaint and show
        // smooth progress instead of a sudden jump at the end.
        //
        const CELL        = 0.10          // coarse grid for SOR
        const CELL_INV    = 1 / CELL
        const RENDER_CELL = 0.025         // fine grid for render dedup
        const RENDER_INV  = 1 / RENDER_CELL
        const SOR_MIN     = 4

        const hashXYZ = (ix, iy, iz) =>
          (ix * 92837111 + iy * 689287499 + iz * 283923481) | 0

        // ─── Pass 1a: coarse voxel count + bounds ─────────────────────────
        const voxelCounts = new Map()
        const voxelKeys   = new Int32Array(n)
        let   minY = Infinity, maxY = -Infinity
        let   minX = Infinity, maxX = -Infinity
        let   minZ = Infinity, maxZ = -Infinity

        for (let i = 0, b = 0; i < n; i++, b += 6) {
          const x = rawData[b], y = rawData[b+1], z = rawData[b+2]
          if (y < minY) minY = y;  if (y > maxY) maxY = y
          if (x < minX) minX = x;  if (x > maxX) maxX = x
          if (z < minZ) minZ = z;  if (z > maxZ) maxZ = z

          const ix  = Math.floor(x * CELL_INV)
          const iy  = Math.floor(y * CELL_INV)
          const iz  = Math.floor(z * CELL_INV)
          const key = hashXYZ(ix, iy, iz)
          voxelKeys[i] = key
          voxelCounts.set(key, (voxelCounts.get(key) || 0) + 1)

          if ((i & 0x1ffff) === 0 && i > 0 && !cancelled) {
            reportRoomLoad(42 + (16 * i / n), 'Building voxel map')
          }
        }
        if (cancelled) return
        await new Promise(r => setTimeout(r, 0))  // yield → browser repaints progress

        const yOffset = isFinite(minY) ? -minY : 0
        yOffsetRef.current = yOffset

        const roomCenterX  = (minX + maxX) * 0.5
        const roomCenterZ  = (minZ + maxZ) * 0.5
        const roomHeight   = isFinite(maxY) && isFinite(minY) ? (maxY - minY) : 1

        // ─── Pass 1b: identify singletons ─────────────────────────────────
        reportRoomLoad(58, 'Identifying outliers')
        const singletonOffset = new Map()
        for (let i = 0, b = 0; i < n; i++, b += 6) {
          const key = voxelKeys[i]
          if ((voxelCounts.get(key) || 0) === 1) singletonOffset.set(key, b)
        }
        if (cancelled) return
        await new Promise(r => setTimeout(r, 0))

        // ─── Pass 1c: SOR on singletons ────────────────────────────────────
        const outlierKeys = new Set()
        let singletonProcessed = 0
        for (const [key, b] of singletonOffset) {
          const ix = Math.floor(rawData[b]   * CELL_INV)
          const iy = Math.floor(rawData[b+1] * CELL_INV)
          const iz = Math.floor(rawData[b+2] * CELL_INV)
          let nhTotal = 0
          outer: for (let dx = -1; dx <= 1; dx++)
            for (let dy = -1; dy <= 1; dy++)
              for (let dz = -1; dz <= 1; dz++) {
                nhTotal += voxelCounts.get(hashXYZ(ix+dx, iy+dy, iz+dz)) || 0
                if (nhTotal >= SOR_MIN) break outer
              }
          if (nhTotal < SOR_MIN) outlierKeys.add(key)
          singletonProcessed++
          if ((singletonProcessed & 0xfff) === 0 && singletonOffset.size > 0 && !cancelled) {
            reportRoomLoad(60 + (8 * singletonProcessed / singletonOffset.size), 'Filtering outliers')
          }
        }
        if (cancelled) return
        await new Promise(r => setTimeout(r, 0))

        // ─── Pass 2: fine-grid (2.5 cm) render deduplication ──────────────
        // SOR used 10 cm voxelKeys to tag outliers; those tags are reused here.
        // Render dedup uses a separate 2.5 cm hash, giving 64× more voxels than
        // the SOR grid and preserving fine surface detail.
        //
        // Colour = per-channel median of up to 9 samples per render-voxel.
        // Median is more robust than mean because it discards outlier sensor
        // readings (specular spikes, sky bleed) without blurring colour edges.
        const floorTop   = minY + roomHeight * 0.20
        const ceilBottom = maxY - roomHeight * 0.20

        const renderVoxels = new Map()  // renderKey → { sx,sy,sz,cnt, rs[],gs[],bs[] }
        for (let i = 0, b = 0; i < n; i++, b += 6) {
          if (outlierKeys.has(voxelKeys[i])) continue

          const px = rawData[b], py = rawData[b+1], pz = rawData[b+2]
          const rix = Math.floor(px * RENDER_INV)
          const riy = Math.floor(py * RENDER_INV)
          const riz = Math.floor(pz * RENDER_INV)
          const rk  = hashXYZ(rix, riy, riz)

          let vd = renderVoxels.get(rk)
          if (!vd) {
            vd = { sx: 0, sy: 0, sz: 0, cnt: 0, rs: [], gs: [], bs: [] }
            renderVoxels.set(rk, vd)
          }
          vd.sx += px; vd.sy += py; vd.sz += pz; vd.cnt++
          if (vd.rs.length < 9) {
            vd.rs.push(rawData[b+3])
            vd.gs.push(rawData[b+4])
            vd.bs.push(rawData[b+5])
          }
          if ((i & 0x1ffff) === 0 && i > 0 && !cancelled) {
            reportRoomLoad(68 + (16 * i / n), 'Deduplicating voxels')
          }
        }
        if (cancelled) return
        await new Promise(r => setTimeout(r, 0))

        // ─── Pass 3: build geometry buffers ────────────────────────────────
        reportRoomLoad(84, 'Building geometry')
        const validCount  = renderVoxels.size
        const positions   = new Float32Array(validCount * 3)
        const colors      = new Float32Array(validCount * 3)
        const splatScales = new Float32Array(validCount)
        const normals     = new Float32Array(validCount * 3)
        let vi = 0
        let voxIdx = 0

        for (const [, vd] of renderVoxels) {
          const avgX = vd.sx / vd.cnt
          const avgY = vd.sy / vd.cnt
          const avgZ = vd.sz / vd.cnt

          positions[vi*3]   = avgX
          positions[vi*3+1] = avgY + yOffset
          positions[vi*3+2] = avgZ

          vd.rs.sort((a, b) => a - b)
          vd.gs.sort((a, b) => a - b)
          vd.bs.sort((a, b) => a - b)
          const mi = vd.rs.length >> 1
          colors[vi*3]   = vd.rs[mi]
          colors[vi*3+1] = vd.gs[mi]
          colors[vi*3+2] = vd.bs[mi]

          splatScales[vi] = 1.0

          if (avgY <= floorTop) {
            normals[vi*3] = 0;  normals[vi*3+1] = 1;  normals[vi*3+2] = 0
          } else if (avgY >= ceilBottom) {
            normals[vi*3] = 0;  normals[vi*3+1] = -1; normals[vi*3+2] = 0
          } else {
            let nx = avgX - roomCenterX, nz = avgZ - roomCenterZ
            const len = Math.sqrt(nx*nx + nz*nz) || 1
            normals[vi*3] = nx/len;  normals[vi*3+1] = 0;  normals[vi*3+2] = nz/len
          }
          vi++

          if ((voxIdx & 0x3fff) === 0 && validCount > 0 && !cancelled) {
            reportRoomLoad(84 + (6 * voxIdx / validCount), 'Building geometry')
          }
          voxIdx++
        }
        if (cancelled) return

        // Store diagnostic stats so the overlay can display them.
        // Use t.renderer (threeRef.current.renderer) — this buildCloud() function
        // is in a separate useEffect from the renderer, so `renderer` is out of
        // scope; access it through the stable threeRef instead.
        const fboW = t.renderer?.domElement?.width  ?? 0
        const fboH = t.renderer?.domElement?.height ?? 0
        diagStatsRef.current = {
          rawPts: n,
          renderedPts: validCount,
          fboW,
          fboH,
          dpr: Math.min(window.devicePixelRatio, 2),
        }

        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position',   new THREE.BufferAttribute(positions,  3))
        geo.setAttribute('color',      new THREE.BufferAttribute(colors,     3))
        geo.setAttribute('splatScale', new THREE.BufferAttribute(splatScales, 1))
        geo.setAttribute('aNormal',    new THREE.BufferAttribute(normals,    3))

        const mat = new THREE.ShaderMaterial({
          vertexColors: true,
          transparent: false,
          depthWrite: true,
          alphaToCoverage: true,
          vertexShader: SPLAT_VERT,
          fragmentShader: SPLAT_FRAG,
          uniforms: {
            uViewH:    { value: fboH },
            uDiagMode: { value: 0 },
          },
        })

        const points = new THREE.Points(geo, mat)
        t.scene.add(points)
        pointCloudMeshRef.current = points
        rawBufferRef.current = buf  // keep decoded buffer for Declare Surface measurement
        reportRoomLoad(90, 'Rendering scan')
        reportRoomLoad(100, 'Scan ready', false)

        // Dedicated reconstruction is rendered as a separate mesh layer so the
        // room shape stays faithful without replacing the point cloud preview.

        // Auto-frame the camera to show the full room scan
        try {
          geo.computeBoundingBox()
          const bbox = geo.boundingBox
          const center = new THREE.Vector3()
          bbox.getCenter(center)

          // FPS mode: stand at room centre at eye height, look horizontally
          const EYE_HEIGHT = 1.6   // metres above floor (yOffset already applied)
          t.orbit.center.set(center.x, EYE_HEIGHT, center.z)
          t.orbit.phi   = Math.PI / 2   // look horizontally
          t.orbit.theta = 0.4           // initial heading (matches default)
          t.applyOrbit()
        } catch { /* ignore framing errors */ }
      } catch (err) {
        console.warn('[SpaceBuilderCanvas] Could not render point cloud:', err)
        reportRoomLoad(100, 'Scan load failed', false)
      }

      if (ENABLE_RECONSTRUCTION_OVERLAY) {
        try {
          const reconstruction = await reconstructPlanarSurfaces(buf, {
            yOffset: yOffsetRef.current,
          })

          if (!cancelled && reconstruction?.segments?.length) {
            for (const segment of reconstruction.segments) {
              const geo = new THREE.BufferGeometry()
              geo.setAttribute('position', new THREE.BufferAttribute(segment.positions, 3))
              const colors = segment.textureColors || segment.colors
              if (colors?.length) {
                geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
              }
              geo.setAttribute('uv', new THREE.BufferAttribute(segment.uvs, 2))
              geo.setIndex(new THREE.BufferAttribute(segment.indices, 1))
              geo.computeVertexNormals()

              const mat = new THREE.MeshBasicMaterial({
                vertexColors: !!colors?.length,
                transparent: true,
                opacity: segment.classification === 'ceiling' ? 0.2 : 0.28,
                side: THREE.DoubleSide,
                depthWrite: false,
              })
              const mesh = new THREE.Mesh(geo, mat)
              mesh.renderOrder = 2

              const wireMat = new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.18, transparent: true })
              const wireGeo = new THREE.EdgesGeometry(geo)
              const wire = new THREE.LineSegments(wireGeo, wireMat)
              mesh.add(wire)

              t.scene.add(mesh)
              reconstructionMeshesRef.current.push(mesh)
            }
          }
        } catch (err) {
          console.warn('[SpaceBuilderCanvas] Could not render reconstructed mesh:', err)
        }
      }

      // ── Build ghost plane meshes from detected planes ─────────────────
      try {
        if (roomScan.planes?.length) {
          const planes = planesFromJSON(roomScan.planes)
          for (const plane of planes) {
            const verts = plane.vertices  // Float32Array of [x,y,z, x,y,z, ...]
            const count = verts.length / 3
            if (count < 3) continue

            // Build a simple polygon mesh by fan-triangulation from centroid
            const cx = verts.reduce((s, v, i) => i % 3 === 0 ? s + v : s, 0) / count
            const cy = verts.reduce((s, v, i) => i % 3 === 1 ? s + v : s, 0) / count
            const cz = verts.reduce((s, v, i) => i % 3 === 2 ? s + v : s, 0) / count

            const positions = [cx, cy, cz]
            for (let i = 0; i < count; i++) {
              positions.push(verts[i*3], verts[i*3+1], verts[i*3+2])
            }
            const indices = []
            for (let i = 1; i <= count; i++) {
              indices.push(0, i, (i % count) + 1)
            }

            const geo = new THREE.BufferGeometry()
            geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
            geo.setIndex(indices)
            geo.computeVertexNormals()

            const color = plane.orientation === 'horizontal' ? 0x34d399 : 0x4a9eff
            const mat = new THREE.MeshBasicMaterial({
              color,
              transparent: true,
              opacity: 0.08,
              side: THREE.DoubleSide,
              depthWrite: false,
            })

            // Wireframe outline
            const wireMat = new THREE.LineBasicMaterial({ color, opacity: 0.35, transparent: true })
            const wireGeo = new THREE.EdgesGeometry(geo)
            const wire    = new THREE.LineSegments(wireGeo, wireMat)

            const mesh = new THREE.Mesh(geo, mat)
            mesh.add(wire)
            t.scene.add(mesh)
            planeMeshesRef.current.push(mesh)
          }
        }
      } catch (err) {
        console.warn('[SpaceBuilderCanvas] Could not render planes:', err)
      }
    }

    buildCloud()
    return () => { cancelled = true }
  }, [roomScan, reportRoomLoad]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Composite piece overlays onto surface textures ───────────────────────
  useEffect(() => {
    const t = threeRef.current
    if (!t) return

    // Collect surfaces that need (re-)compositing
    const toProcess = []
    for (const surface of space.surfaces) {
      const layoutName = surface.activeLayout
      if (!layoutName) {
        // No active layout — clear any cached composite so we revert to base texture
        if (compTexCacheRef.current.has(surface.id)) {
          compTexCacheRef.current.delete(surface.id)
          // Force syncMeshes to pick up the now-uncached base texture
        }
        continue
      }
      const pieces = surface.layouts?.[layoutName]?.pieces || []
      const baseUrl = surface.inpaintDataUrl
        || surface.stitchedDataUrl
        || surface.warpedDataUrl
        || space.photos.find(p => p.id === surface.photoId)?.dataUrl
        || null
      if (!baseUrl) continue

      const key = baseUrl + '|' + JSON.stringify(pieces)
      const cached = compTexCacheRef.current.get(surface.id)
      if (cached?.key === key) continue  // already up-to-date

      toProcess.push({ surface, baseUrl, pieces, key })
    }

    if (toProcess.length === 0) return

    // Composite async, then re-sync meshes once all done
    ;(async () => {
      let changed = false
      for (const { surface, baseUrl, pieces, key } of toProcess) {
        try {
          const dataUrl = await compositePiecesOntoTexture(surface, baseUrl, pieces)
          compTexCacheRef.current.set(surface.id, { key, dataUrl })
          changed = true
        } catch (err) {
          console.error('[SpaceBuilderCanvas] composite failed for', surface.id, err)
        }
      }
      if (changed) t.syncMeshes(stateRef.current.space.surfaces)
    })()
  }, [space]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard: rotate selected surface
  useEffect(() => {
    function onKey(e) {
      const t = threeRef.current; if (!t) return
      const id = stateRef.current.activeSurfaceId; if (!id) return
      const entry = t.meshMap[id]; if (!entry) return
      const stepDeg = e.shiftKey ? 5 : 15
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // ←→ rotate Y — keep rotYDeg in sync with slider
        e.preventDefault()
        const surf = stateRef.current.space.surfaces.find(s => s.id === id)
        const newDeg = (surf?.rotYDeg ?? 0) + (e.key === 'ArrowLeft' ? -stepDeg : stepDeg)
        entry.mesh.rotation.y = newDeg * Math.PI / 180
        stateRef.current.onUpdateSurface(id, { rotYDeg: newDeg })
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // ↑↓ rotate X (tilt) — stored in pose3d.rotX
        e.preventDefault()
        entry.mesh.rotation.x += (e.key === 'ArrowUp' ? stepDeg : -stepDeg) * Math.PI / 180
        stateRef.current.onUpdateSurface(id, {
          pose3d: { position: entry.mesh.position.toArray(), rotX: entry.mesh.rotation.x },
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Update camera FOV whenever the preset changes
  useEffect(() => {
    const t = threeRef.current
    if (!t?.camera) return
    t.camera.fov = fov
    t.camera.updateProjectionMatrix()
  }, [fov])

  // Propagate diagnostics colour mode to the point cloud shader uniform
  useEffect(() => {
    const mat = pointCloudMeshRef.current?.material
    if (mat?.uniforms?.uDiagMode) mat.uniforms.uDiagMode.value = diagMode
  }, [diagMode])

  // ── Joystick pointer handlers — shared helper ────────────────────────────
  function makeJoyHandlers(joyRef, setPos) {
    return {
      onDown(e) {
        e.currentTarget.setPointerCapture(e.pointerId)
        joyRef.current.active = true
      },
      onMove(e) {
        if (!joyRef.current.active) return
        const rect = e.currentTarget.getBoundingClientRect()
        const cx = rect.left + rect.width  / 2
        const cy = rect.top  + rect.height / 2
        const dx = e.clientX - cx
        const dy = e.clientY - cy
        const dist = Math.sqrt(dx * dx + dy * dy)
        const maxDist = JOY_RADIUS - JOY_THUMB
        const clamped = dist > maxDist ? maxDist / dist : 1
        const tx = dx * clamped, ty = dy * clamped
        joyRef.current.nx = tx / maxDist
        joyRef.current.ny = ty / maxDist
        setPos({ x: tx, y: ty })
      },
      onUp() {
        joyRef.current.active = false
        joyRef.current.nx = 0
        joyRef.current.ny = 0
        setPos({ x: 0, y: 0 })
      },
    }
  }

  // Orbit joystick
  const orbitJoy = makeJoyHandlers(joystickRef, setJoyPos)
  const handleJoyDown = orbitJoy.onDown
  const handleJoyMove = orbitJoy.onMove
  const handleJoyUp   = orbitJoy.onUp

  // Pan joystick (left)
  const panJoy = makeJoyHandlers(panJoystickRef, setPanJoyPos)
  const handlePanJoyDown = panJoy.onDown
  const handlePanJoyMove = panJoy.onMove
  const handlePanJoyUp   = panJoy.onUp

  // Forward/Back joystick (only Y axis used in RAF loop)
  const fwdJoy = makeJoyHandlers(fwdJoystickRef, setFwdJoyPos)
  const handleFwdJoyDown = fwdJoy.onDown
  const handleFwdJoyMove = fwdJoy.onMove
  const handleFwdJoyUp   = fwdJoy.onUp

  return (
    <div ref={mountRef} className="sbc-3d-viewport">
      {snapHint && (
        <div className="sbc-snap-hint">
          ⚡ snap: <strong>{snapHint.fromEdge}</strong> → <strong>{snapHint.toEdge}</strong> — release to connect
        </div>
      )}

      {/* ── FOV presets — left side, vertical ──────────────────────── */}
      <div className="sbc-fov-bar">
        <span className="sbc-ctrl-label">FOV</span>
        {FOV_PRESETS.map(p => (
          <button
            key={p.label}
            className={`sbc-fov-btn${fov === p.fov ? ' sbc-fov-btn--active' : ''}`}
            onClick={() => setFov(p.fov)}
            title={`${p.fov}° field of view`}
          >{p.label}</button>
        ))}
        {/* Diagnostics toggle — at bottom of FOV bar, only shown when a scan is loaded */}
        {diagStatsRef.current && (
          <button
            className={`sbc-fov-btn${diagVisible ? ' sbc-fov-btn--active' : ''}`}
            style={{ marginTop: 8, fontSize: '0.65rem', padding: '3px 6px' }}
            onClick={() => setDiagVisible(v => !v)}
            title="Toggle scan diagnostics overlay"
          >Diag</button>
        )}
      </div>

      {/* ── Zoom controls — right side, vertical ─────────────────────── */}
      <div className="sbc-zoom-bar">
        <span className="sbc-ctrl-label">Zoom</span>
        <button
          className="sbc-zoom-btn"
          title={cameraFPSRef.current ? 'Step forward' : 'Zoom in'}
          onClick={() => {
            const t = threeRef.current; if (!t) return
            if (cameraFPSRef.current) {
              // FPS: step forward along look direction
              const o = t.orbit
              const sphi = Math.sin(o.phi), cphi = Math.cos(o.phi)
              o.center.x += sphi * Math.sin(o.theta) * 0.5
              o.center.y += cphi                      * 0.5
              o.center.z += sphi * Math.cos(o.theta) * 0.5
              setZoomRadius(prev => scaleZoomRadius(prev, 0.8, ZOOM_MIN, ZOOM_MAX))
            } else {
              const r = scaleZoomRadius(zoomRadius, 0.8, ZOOM_MIN, ZOOM_MAX)
              setZoomRadius(r)
              t.orbit.radius = r
            }
            t.applyOrbit()
          }}
        >+</button>
        <span className="sbc-zoom-val">{radiusToSlider(zoomRadius, ZOOM_MIN, ZOOM_MAX).toFixed(0)}%</span>
        <button
          className="sbc-zoom-btn"
          title={cameraFPSRef.current ? 'Step back' : 'Zoom out'}
          onClick={() => {
            const t = threeRef.current; if (!t) return
            if (cameraFPSRef.current) {
              // FPS: step back
              const o = t.orbit
              const sphi = Math.sin(o.phi), cphi = Math.cos(o.phi)
              o.center.x -= sphi * Math.sin(o.theta) * 0.5
              o.center.y -= cphi                      * 0.5
              o.center.z -= sphi * Math.cos(o.theta) * 0.5
              setZoomRadius(prev => scaleZoomRadius(prev, 1.25, ZOOM_MIN, ZOOM_MAX))
            } else {
              const r = scaleZoomRadius(zoomRadius, 1.25, ZOOM_MIN, ZOOM_MAX)
              setZoomRadius(r)
              t.orbit.radius = r
            }
            t.applyOrbit()
          }}
        >−</button>
      </div>

      {/* ── Joystick group — centered at top ─────────────────────────── */}
      <div className="sbc-joystick-group">
        {/* Move/Pan joystick */}
        <div className="sbc-joystick-wrapper">
          <div
            className="sbc-joystick sbc-joystick--pan"
            style={{ '--jr': `${JOY_RADIUS}px` }}
            onPointerDown={handlePanJoyDown}
            onPointerMove={handlePanJoyMove}
            onPointerUp={handlePanJoyUp}
            onPointerLeave={handlePanJoyUp}
            title="Drag to pan / move view"
          >
            <svg className="sbc-joystick-arrows" viewBox="0 0 72 72" fill="none">
              <path d="M36 13l-7 11h14l-7-11Z" fill="currentColor" opacity=".55"/>
              <path d="M36 59l-7-11h14l-7 11Z" fill="currentColor" opacity=".55"/>
              <path d="M13 36l11-7v14l-11-7Z" fill="currentColor" opacity=".55"/>
              <path d="M59 36l-11-7v14Z" fill="currentColor" opacity=".55"/>
              <line x1="36" y1="24" x2="36" y2="48" stroke="currentColor" strokeWidth="1" opacity=".2"/>
              <line x1="24" y1="36" x2="48" y2="36" stroke="currentColor" strokeWidth="1" opacity=".2"/>
            </svg>
            <div
              className="sbc-joystick-thumb"
              style={{
                '--jt': `${JOY_THUMB}px`,
                transform: `translate(calc(-50% + ${panJoyPos.x}px), calc(-50% + ${panJoyPos.y}px))`,
              }}
            />
          </div>
          <div className="sbc-joystick-label">Move</div>
        </div>

        {/* Orbit joystick */}
        <div className="sbc-joystick-wrapper">
          <div
            className="sbc-joystick sbc-joystick--orbit"
            style={{ '--jr': `${JOY_RADIUS}px` }}
            onPointerDown={handleJoyDown}
            onPointerMove={handleJoyMove}
            onPointerUp={handleJoyUp}
            onPointerLeave={handleJoyUp}
            title="Drag to orbit / rotate view"
          >
            <svg className="sbc-joystick-globe" viewBox="0 0 72 72" fill="none">
              <circle cx="36" cy="36" r="26" stroke="currentColor" strokeWidth="1.5" opacity=".65"/>
              <ellipse cx="36" cy="36" rx="26" ry="7.5" stroke="currentColor" strokeWidth="1" opacity=".5"/>
              <ellipse cx="36" cy="25" rx="19" ry="5.5" stroke="currentColor" strokeWidth="1" opacity=".4"/>
              <ellipse cx="36" cy="47" rx="19" ry="5.5" stroke="currentColor" strokeWidth="1" opacity=".4"/>
              <ellipse cx="36" cy="36" rx="7.5" ry="26" stroke="currentColor" strokeWidth="1" opacity=".5"/>
              <ellipse cx="36" cy="36" rx="7.5" ry="26" stroke="currentColor" strokeWidth="1" opacity=".35" transform="rotate(60 36 36)"/>
            </svg>
            <div
              className="sbc-joystick-thumb"
              style={{
                '--jt': `${JOY_THUMB}px`,
                transform: `translate(calc(-50% + ${joyPos.x}px), calc(-50% + ${joyPos.y}px))`,
              }}
            />
          </div>
          <div className="sbc-joystick-label">Orbit</div>
        </div>

        {/* Forward/Back (dolly) joystick */}
        <div className="sbc-joystick-wrapper">
          <div
            className="sbc-joystick sbc-joystick--fwd"
            style={{ '--jr': `${JOY_RADIUS}px` }}
            onPointerDown={handleFwdJoyDown}
            onPointerMove={handleFwdJoyMove}
            onPointerUp={handleFwdJoyUp}
            onPointerLeave={handleFwdJoyUp}
            title="Drag up/down to move forward/back into the scene"
          >
            {/* Perspective double-arrow: small arrowhead at top (far/into screen),
                large arrowhead at bottom (near/out of screen), tapering body. */}
            <svg className="sbc-joystick-depth" viewBox="0 0 72 72" fill="none">
              {/* Perspective body (trapezoid, narrow at top, wide at bottom) */}
              <path d="M31 25 L41 25 L45 47 L27 47 Z" fill="currentColor" opacity=".15"/>
              {/* Far arrowhead (top, small) */}
              <path d="M36 12 L31 25 L41 25 Z" fill="currentColor" opacity=".6"/>
              {/* Near arrowhead (bottom, large) */}
              <path d="M36 60 L27 47 L45 47 Z" fill="currentColor" opacity=".6"/>
              {/* Center spine */}
              <line x1="36" y1="25" x2="36" y2="47" stroke="currentColor" strokeWidth="1" opacity=".3"/>
            </svg>
            <div
              className="sbc-joystick-thumb"
              style={{
                '--jt': `${JOY_THUMB}px`,
                transform: `translate(calc(-50% + ${fwdJoyPos.x}px), calc(-50% + ${fwdJoyPos.y}px))`,
              }}
            />
          </div>
          <div className="sbc-joystick-label">Forward / Back</div>
        </div>
      </div>

      <div className="sbc-3d-legend">
        <span>Drag bg / joystick: orbit</span>
        <span>Drag surface: move XZ</span>
        <span>Shift+drag: raise/lower</span>
        <span>←→↑↓: rotate (Shift=fine)</span>
        <span>Dbl-click: crop corners</span>
        <span>Scroll: zoom in/out</span>
      </div>
      {space.surfaces.length === 0 && !roomScan && (
        <div className="sbc-3d-empty">
          <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
            <rect x="4" y="12" width="48" height="32" rx="4" stroke="#4a9eff" strokeWidth="2"/>
            <circle cx="19" cy="24" r="5" stroke="#4a9eff" strokeWidth="2"/>
            <path d="M4 36l14-10 10 7 10-13 18 16" stroke="#4a9eff" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>
          </svg>
          <p>Add a photo — drag surfaces into position to build your room</p>
        </div>
      )}
      {cropSurfaceId && (
        <CropOverlay
          surfaceId={cropSurfaceId}
          space={space}
          onUpdateSurface={onUpdateSurface}
          onClose={() => setCropSurfaceId(null)}
        />
      )}

      {/* ── Add Surface from current 3D view (perspective warp) ─── */}
      {onSurfaceFromView && (
        <button
          className="sbc-add-surface-btn"
          title="Capture this view and apply perspective warp to create a new wall surface"
          onClick={() => {
            const t = threeRef.current
            if (!t?.renderer) return
            // Force a render so the canvas buffer is fresh
            t.renderer.render(t.scene, t.camera)
            const dataUrl = t.renderer.domElement.toDataURL('image/jpeg', 0.88)
            // Capture camera matrices for LiDAR-based dimension measurement in WallSetup
            const cam = t.camera
            onSurfaceFromView(dataUrl, {
              fov: fov,
              projectionMatrixElements: Array.from(cam.projectionMatrix.elements),
              viewMatrixElements:       Array.from(cam.matrixWorldInverse.elements),
              yOffset:                  yOffsetRef.current ?? 0,
              pointCloudBuffer:         rawBufferRef.current ?? null,
            })
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="2" width="12" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M4 7.5L6 5.5L8 7L10 5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round"/>
            <path d="M7 12v-2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          {roomScan ? 'Declare Surface' : 'Add Surface'}
        </button>
      )}

      {/* ── Diagnostics overlay ───────────────────────────────────── */}
      {diagVisible && diagStatsRef.current && (() => {
        const s = diagStatsRef.current
        const pct = ((s.renderedPts / s.rawPts) * 100).toFixed(1)
        const dedupX = (s.rawPts / s.renderedPts).toFixed(0)
        // Estimate splat px size at 3 m depth using current FOV
        const projY  = 1 / Math.tan(fov * Math.PI / 360)
        const splatPx = (0.115 * projY * s.fboH * 0.5 / 3.0).toFixed(1)
        return (
          <div className="sbc-diag-panel">
            <div className="sbc-diag-title">
              Scan Diagnostics
              <div className="sbc-diag-modes">
                {['Color', 'Depth', 'Normals'].map((label, i) => (
                  <button
                    key={i}
                    className={`sbc-diag-mode-btn${diagMode === i ? ' active' : ''}`}
                    onClick={() => setDiagMode(i)}
                  >{label}</button>
                ))}
              </div>
            </div>
            <table className="sbc-diag-table">
              <tbody>
                <tr><td>Raw points</td><td>{s.rawPts.toLocaleString()}</td></tr>
                <tr><td>Rendered (dedup)</td><td>{s.renderedPts.toLocaleString()} <span className="sbc-diag-dim">({pct}% / {dedupX}× reduction)</span></td></tr>
                <tr><td>FBO resolution</td><td>{s.fboW} × {s.fboH} px</td></tr>
                <tr><td>Device pixel ratio</td><td>{s.dpr.toFixed(1)}×</td></tr>
                <tr><td>Splat px @ 3 m</td><td>{splatPx} fb-px <span className="sbc-diag-dim">({(splatPx / s.dpr).toFixed(1)} CSS px)</span></td></tr>
                <tr><td>Voxel cell</td><td>2.5 cm (SOR: 10 cm)</td></tr>
                <tr><td>Colour method</td><td>per-voxel median (9 samples)</td></tr>
              </tbody>
            </table>
          </div>
        )
      })()}
    </div>
  )
}

// ── 2D crop-corner editor (overlay on top of 3D canvas) ──────────────────────
// Each corner's handle is offset diagonally outward so the finger/cursor
// never obscures the exact point being controlled.
// HANDLE_OFFSET, HANDLE_PAD, HANDLE_DIR, HANDLE_COLORS imported from ../utils/warpHandles

function CropOverlay({ surfaceId, space, onUpdateSurface, onClose }) {
  const surface = space.surfaces.find(s => s.id === surfaceId)
  const photo   = surface && space.photos.find(p => p.id === surface.photoId)
  const [corners,   setCorners]   = useState(surface?.corners ? JSON.parse(JSON.stringify(surface.corners)) : null)
  const [isWarping, setIsWarping] = useState(false)
  const svgRef = useRef(null)

  const W = 540
  const H = photo ? Math.round(W * photo.displayH / photo.displayW) : 360
  if (!surface || !photo || !corners) return null

  const toSVG   = ([fx, fy]) => [fx * W, fy * H]
  const fromSVG = (sx, sy)   => [sx / W, sy / H]
  const polyStr = ['tl','tr','br','bl'].map(k => toSVG(corners[k]).join(',')).join(' ')

  async function applyAndWarp() {
    onUpdateSurface(surfaceId, { corners, warpedDataUrl: null, stitchedDataUrl: null, inpaintDataUrl: null })
    setIsWarping(true)
    try {
      const url = await warpSurface(
        { ...surface, corners }, photo.dataUrl, photo.displayW, photo.displayH, warpPerspectiveAsync
      )
      onUpdateSurface(surfaceId, { corners, warpedDataUrl: url, stitchedDataUrl: null, inpaintDataUrl: null })
    } finally { setIsWarping(false); onClose() }
  }

  // svg.getScreenCTM().inverse() gives the exact screen→viewBox transform,
  // accounting for viewBox, preserveAspectRatio, zoom, and device pixel ratio.
  // No clamping here — handles intentionally live outside the viewBox bounds.
  function clientToSVG(clientX, clientY) {
    const svg = svgRef.current
    const pt  = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const p = pt.matrixTransform(svg.getScreenCTM().inverse())
    return [p.x, p.y]
  }

  // Use pointer capture so the drag stays locked to this element even when
  // the pointer leaves the SVG or the modal entirely — handles remain
  // grabbable no matter where they end up on screen.
  function startDrag(k, e) {
    e.stopPropagation()
    e.preventDefault()
    const captureEl = e.currentTarget
    captureEl.setPointerCapture(e.pointerId)

    const [dx, dy] = HANDLE_DIR[k]
    const ox = dx * HANDLE_OFFSET
    const oy = dy * HANDLE_OFFSET

    const onMove = (ev) => {
      if (!svgRef.current) return
      const [sx, sy] = clientToSVG(ev.clientX, ev.clientY)
      // Subtract the visual offset to get the actual corner position, then
      // clamp the corner (not the handle) to the image bounds.
      setCorners(prev => ({ ...prev, [k]: fromSVG(
        Math.max(0, Math.min(W, sx - ox)),
        Math.max(0, Math.min(H, sy - oy))
      )}))
    }

    const onUp = () => {
      captureEl.removeEventListener('pointermove',  onMove)
      captureEl.removeEventListener('pointerup',    onUp)
      captureEl.removeEventListener('pointercancel', onUp)
    }

    captureEl.addEventListener('pointermove',   onMove)
    captureEl.addEventListener('pointerup',     onUp)
    captureEl.addEventListener('pointercancel', onUp)
  }

  const clipId = `photo-clip-${surfaceId}`

  return (
    <div className="sbc-crop-overlay">
      <div className="sbc-crop-modal">
        <div className="sbc-crop-header">
          <span>Crop corners — {surface.name}</span>
          <button className="sbc-crop-close" onClick={onClose}>✕</button>
        </div>

        {/* The viewBox is padded on all sides by HANDLE_PAD so the diagonal
            offset handles always stay within the SVG element's own bounding
            box. This means browser hit-testing always finds the handle <g>,
            regardless of where the handle was last released. No overflow:visible
            tricks needed — handles are simply inside the SVG, always. */}
        <div className="sbc-crop-svg-wrap">
        <svg
          ref={svgRef}
          viewBox={`${-HANDLE_PAD} ${-HANDLE_PAD} ${W + 2*HANDLE_PAD} ${H + 2*HANDLE_PAD}`}
          className="sbc-crop-svg"
          style={{ display:'block', cursor:'crosshair', touchAction:'none', aspectRatio:`${W + 2*HANDLE_PAD}/${H + 2*HANDLE_PAD}` }}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x="0" y="0" width={W} height={H}/>
            </clipPath>
          </defs>

          {/* Photo + selection polygon clipped to image bounds */}
          <image href={photo.dataUrl} x="0" y="0" width={W} height={H}
            preserveAspectRatio="xMidYMid meet" clipPath={`url(#${clipId})`}/>
          <polygon points={polyStr}
            fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.8)" strokeWidth="1.5"
            strokeDasharray="7 4"
            clipPath={`url(#${clipId})`} style={{ pointerEvents:'none' }}/>

          {/* Corner handles — offset diagonally outward from each corner */}
          {['tl','tr','br','bl'].map(k => {
            const [hx, hy] = toSVG(corners[k])
            const [dx, dy] = HANDLE_DIR[k]
            const hpx = hx + dx * HANDLE_OFFSET   // handle centre X
            const hpy = hy + dy * HANDLE_OFFSET   // handle centre Y
            const CX = 6                           // crosshair arm length
            const color = HANDLE_COLORS[k]

            return (
              <g key={k}>
                {/* Black backing stroke for dashed connector */}
                <line x1={hx} y1={hy} x2={hpx} y2={hpy}
                  stroke="rgba(0,0,0,0.55)" strokeWidth="3"
                  style={{ pointerEvents:'none' }}/>

                {/* Colored dashed connector: actual corner → handle */}
                <line x1={hx} y1={hy} x2={hpx} y2={hpy}
                  stroke={color} strokeWidth="1.5" strokeDasharray="4 3"
                  style={{ pointerEvents:'none' }}/>

                {/* Crosshair at the exact corner point */}
                <line x1={hx-CX} y1={hy} x2={hx+CX} y2={hy}
                  stroke={color} strokeWidth="1.5" style={{ pointerEvents:'none' }}/>
                <line x1={hx} y1={hy-CX} x2={hx} y2={hy+CX}
                  stroke={color} strokeWidth="1.5" style={{ pointerEvents:'none' }}/>

                {/* Draggable hollow ring handle */}
                <g onPointerDown={e => startDrag(k, e)}
                   style={{ cursor:'grab', touchAction:'none' }}>
                  <circle cx={hpx} cy={hpy} r={26} fill="transparent"/>
                  <circle cx={hpx} cy={hpy} r={12}
                    fill="rgba(0,0,0,0.35)" stroke={color} strokeWidth="2"/>
                  <text x={hpx} y={hpy}
                    textAnchor="middle" dominantBaseline="central"
                    fontSize="8" fill={color} fontWeight="800" opacity="0.9"
                    style={{ pointerEvents:'none', userSelect:'none' }}>
                    {k.toUpperCase()}
                  </text>
                </g>
              </g>
            )
          })}
        </svg>
        </div>{/* .sbc-crop-svg-wrap */}

        <div className="sbc-crop-footer">
          <button className="sb-btn sb-btn--ghost" onClick={onClose}>Cancel</button>
          <button
            className={`sb-btn sb-btn--save${isWarping ? ' sb-btn--loading' : ''}`}
            onClick={applyAndWarp} disabled={isWarping}
          >
            {isWarping ? <><span className="btn-spinner"/>Warping…</> : 'Apply & Warp'}
          </button>
        </div>
      </div>
    </div>
  )
}
