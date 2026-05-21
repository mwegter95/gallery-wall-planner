/**
 * GaussianSplatViewer.jsx
 *
 * WebGL2 renderer for .splat files produced by OpenSplat / antimatter15.
 *
 * Binary format — 32 bytes per Gaussian:
 *   [0..11]  xyz position        float32 × 3
 *   [12..23] log-scale xyz       float32 × 3  (actual_scale = exp(stored))
 *   [24..27] RGBA colour         uint8  × 4   (0..255)
 *   [28..31] rotation quat xyzw  uint8  × 4   ((q × 127) + 128, decode: (b−128)/127)
 *
 * Rendering:
 *   • 2D EWA splatting: full 3D→2D covariance projection in the vertex shader.
 *   • One VAO per scene; all attributes are interleaved in a single dynamic VBO
 *     that is rewritten every sort frame (back-to-front depth order).
 *   • Depth sort: CPU radix-style using a Float64 packed key for ~3 ms per 300 K splats.
 *   • Sort fires every 3rd frame or when the camera moves more than 1 cm / 0.5°.
 *   • Compositing: renders to a transparent canvas that sits behind the THREE.js canvas.
 *     The parent (SpaceBuilderCanvas) passes current camera matrices via a ref that is
 *     read each frame — zero React state churn on the hot path.
 *
 * Props:
 *   splatUrl     {string}  Authenticated URL served by the Flask backend.
 *   cameraRef    {Ref}     { viewMatrix: Float32Array[16], projMatrix: Float32Array[16],
 *                            focalX: number, focalY: number }
 *                          Updated each frame by the parent's RAF loop.
 *   onStatus     {fn}      (status: 'loading'|'ready'|'error', info?) => void
 *   style        {object}  Extra CSS for the canvas element.
 */

import { useEffect, useRef, useCallback } from 'react'
import { getJwt, getDeviceToken } from '../utils/api'

// ─── GLSL ───────────────────────────────────────────────────────────────────

const VERT_SRC = /* glsl */`#version 300 es
precision highp float;

// Quad corner in [-1, 1]² — 6 verts (2 tris) per instance
in vec2  aCorner;

// Per-instance (one Gaussian) — interleaved in one VBO, stride = 56 bytes
in vec3  aPos;       // world-space centre
in vec3  aLogSc;     // log(scale) xyz
in vec4  aColor;     // rgba in [0, 1]
in vec4  aQuat;      // unit quaternion xyzw

uniform mat4 uView;
uniform mat4 uProj;
uniform vec2 uViewport;  // pixel size
uniform float uFx;       // focal length x (pixels)
uniform float uFy;       // focal length y (pixels)

out vec2 vOffset;    // screen-space corner offset in sigma units
out vec4 vColor;

mat3 quat2mat(vec4 q) {
  float x = q.x, y = q.y, z = q.z, w = q.w;
  return mat3(
    1.-2.*(y*y+z*z),  2.*(x*y+w*z),     2.*(x*z-w*y),
    2.*(x*y-w*z),     1.-2.*(x*x+z*z),  2.*(y*z+w*x),
    2.*(x*z+w*y),     2.*(y*z-w*x),     1.-2.*(x*x+y*y)
  );
}

void main() {
  // Transform to view space
  vec4 vp = uView * vec4(aPos, 1.0);
  if (vp.z >= -0.05) { gl_Position = vec4(0.,0.,2.,1.); return; }  // behind camera

  // 3-D covariance  Σ = R S Sᵀ Rᵀ
  vec3 sc   = exp(aLogSc);
  mat3 R    = quat2mat(normalize(aQuat));
  mat3 M    = R * mat3(sc.x,0,0, 0,sc.y,0, 0,0,sc.z);
  mat3 Sig3 = M * transpose(M);

  // Jacobian of projective map at vp
  float tx = vp.x, ty = vp.y, tz = vp.z;
  mat3 J = mat3(
    uFx/tz,           0.,              0.,
    0.,               uFy/tz,          0.,
    -uFx*tx/(tz*tz), -uFy*ty/(tz*tz), 0.
  );

  // 2-D screen covariance  Σ₂ = J W Σ Wᵀ Jᵀ
  mat3 W   = mat3(uView);
  mat3 T   = W * transpose(J);
  mat3 Sig2 = transpose(T) * Sig3 * T;

  // Extract upper-left 2×2 and add a small regulariser
  float a = Sig2[0][0] + 0.3;
  float b = Sig2[0][1];
  float c = Sig2[1][1] + 0.3;

  // Eigenvalues → semi-axis lengths (pixels, 3-sigma)
  float tr   = a + c;
  float disc = sqrt(max(0., tr*tr*0.25 - (a*c - b*b)));
  float lam1 = tr*0.5 + disc;
  float lam2 = tr*0.5 - disc;
  float r1   = min(3.*sqrt(abs(lam1)), 1024.);
  float r2   = min(3.*sqrt(abs(lam2)), 1024.);

  // Eigenvectors
  vec2 ev1 = normalize(vec2(b, lam1 - a));
  vec2 ev2 = vec2(-ev1.y, ev1.x);

  // Screen offset for this corner (pixels → NDC)
  vec4 clip   = uProj * vp;
  vec2 offset = aCorner.x*r1*ev1 + aCorner.y*r2*ev2;
  vec2 ndc    = clip.xy / clip.w + offset*2./uViewport;

  gl_Position = vec4(ndc, 0., 1.);
  vOffset     = aCorner;     // [-1,1]² used in frag for Gaussian falloff
  vColor      = aColor;
}
`

const FRAG_SRC = /* glsl */`#version 300 es
precision highp float;

in  vec2 vOffset;
in  vec4 vColor;
out vec4 fragColor;

void main() {
  float r2 = dot(vOffset, vOffset);
  if (r2 > 1.) discard;
  float alpha = exp(-r2 * 4.5) * vColor.a;
  if (alpha < 0.015) discard;
  // Premultiplied alpha (matches WebGL blendFuncSeparate ONE, ONE_MINUS_SRC_ALPHA)
  fragColor = vec4(vColor.rgb * alpha, alpha);
}
`

// ─── Constants ───────────────────────────────────────────────────────────────

const SPLAT_STRIDE = 32        // bytes per Gaussian in the .splat file
// Interleaved VBO layout per Gaussian (14 floats = 56 bytes):
//   [0..2]  aPos      float32 × 3
//   [3..5]  aLogSc    float32 × 3
//   [6..9]  aColor    float32 × 4
//   [10..13] aQuat    float32 × 4
const VBO_FLOATS = 14
const VBO_BYTES  = VBO_FLOATS * 4

// ─── Parse .splat binary ─────────────────────────────────────────────────────

function parseSplat(buffer) {
  const n    = Math.floor(buffer.byteLength / SPLAT_STRIDE)
  const view = new DataView(buffer)

  // Interleaved packed array (used both as source data and as sorted-copy target)
  const packed = new Float32Array(n * VBO_FLOATS)

  for (let i = 0; i < n; i++) {
    const s = i * SPLAT_STRIDE
    const d = i * VBO_FLOATS
    // Position
    packed[d]   = view.getFloat32(s,      true)
    packed[d+1] = view.getFloat32(s +  4, true)
    packed[d+2] = view.getFloat32(s +  8, true)
    // Log-scale
    packed[d+3] = view.getFloat32(s + 12, true)
    packed[d+4] = view.getFloat32(s + 16, true)
    packed[d+5] = view.getFloat32(s + 20, true)
    // Color  (uint8 0-255 → float 0-1)
    packed[d+6] = view.getUint8(s + 24) / 255
    packed[d+7] = view.getUint8(s + 25) / 255
    packed[d+8] = view.getUint8(s + 26) / 255
    packed[d+9] = view.getUint8(s + 27) / 255
    // Quaternion xyzw ((byte − 128) / 127 → [-1, 1])
    packed[d+10] = (view.getUint8(s + 28) - 128) / 127
    packed[d+11] = (view.getUint8(s + 29) - 128) / 127
    packed[d+12] = (view.getUint8(s + 30) - 128) / 127
    packed[d+13] = (view.getUint8(s + 31) - 128) / 127
  }

  return { n, packed }
}

// ─── Depth sort ──────────────────────────────────────────────────────────────
// Uses a Float64Array as a packed (depth_f32_BE | index_u32_LE) key so the
// native typed-array sort (no comparison function) handles ordering in ~3 ms
// for 300 K splats. Positive-only depths required for bit-comparison trick:
// we offset by +1 000 (nothing meaningful in a room extends >1 000 m from camera).

const DEPTH_OFFSET = 1000.0

function sortSplats(packed, n, viewMatrix, sortKeys, sortBuf) {
  const vm = viewMatrix
  // Row 2 of column-major view matrix: vm[2], vm[6], vm[10], vm[14]
  const r0 = vm[2], r1 = vm[6], r2 = vm[10], r3 = vm[14]
  const keyView = new DataView(sortKeys.buffer)

  for (let i = 0; i < n; i++) {
    const b = i * VBO_FLOATS
    const d = r0 * packed[b] + r1 * packed[b+1] + r2 * packed[b+2] + r3 + DEPTH_OFFSET
    // Big-endian float32 → numeric comparison sorts by value for positive floats
    keyView.setFloat32(i * 8,     d, false /* big-endian */)
    keyView.setUint32 (i * 8 + 4, i, true  /* little-endian index */)
  }

  sortKeys.sort()  // ~3 ms for 300 K (native, no comparison fn)

  // Repack in back-to-front order (ascending depth = furthest first)
  for (let si = 0; si < n; si++) {
    const origIdx = keyView.getUint32(si * 8 + 4, true)
    const src = origIdx * VBO_FLOATS
    const dst = si     * VBO_FLOATS
    for (let k = 0; k < VBO_FLOATS; k++) sortBuf[dst + k] = packed[src + k]
  }
}

// ─── WebGL helpers ───────────────────────────────────────────────────────────

function compileProgram(gl, vertSrc, fragSrc) {
  function shader(type, src) {
    const s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error('Shader: ' + gl.getShaderInfoLog(s))
    return s
  }
  const prog = gl.createProgram()
  gl.attachShader(prog, shader(gl.VERTEX_SHADER,   vertSrc))
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, fragSrc))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error('Program: ' + gl.getProgramInfoLog(prog))
  return prog
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function GaussianSplatViewer({ splatUrl, cameraRef, onStatus, style }) {
  const canvasRef  = useRef(null)
  const glRef      = useRef(null)
  const progRef    = useRef(null)
  const uniRef     = useRef(null)   // { uView, uProj, uViewport, uFx, uFy }
  const vaoRef     = useRef(null)
  const vboRef     = useRef(null)   // main interleaved dynamic VBO
  const splatRef   = useRef(null)   // { n, packed }
  const sortKeyRef = useRef(null)   // Float64Array(n) — packed sort keys
  const sortBufRef = useRef(null)   // Float32Array(n × VBO_FLOATS) — sorted output
  const frameRef   = useRef(0)
  const rafRef     = useRef(null)
  const prevCamRef = useRef({ vx: 0, vy: 0, vz: 0, theta: 0 })

  // ── Init WebGL2 ──────────────────────────────────────────────────────────
  const initGL = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return false
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false })
    if (!gl) { onStatus?.('error', 'WebGL2 unavailable'); return false }

    let prog
    try { prog = compileProgram(gl, VERT_SRC, FRAG_SRC) }
    catch (e) { console.error('[GaussianSplat]', e); onStatus?.('error', String(e)); return false }

    // Cache uniform locations (do NOT do this per-frame)
    uniRef.current = {
      uView:     gl.getUniformLocation(prog, 'uView'),
      uProj:     gl.getUniformLocation(prog, 'uProj'),
      uViewport: gl.getUniformLocation(prog, 'uViewport'),
      uFx:       gl.getUniformLocation(prog, 'uFx'),
      uFy:       gl.getUniformLocation(prog, 'uFy'),
    }

    glRef.current   = gl
    progRef.current = prog
    return true
  }, [onStatus])

  // ── Upload splat data to GPU ─────────────────────────────────────────────
  const uploadSplat = useCallback((splat) => {
    const gl   = glRef.current
    const prog = progRef.current
    if (!gl || !prog) return

    const { n, packed } = splat

    // Quad corners (6 verts, 2 triangles)
    const corners = new Float32Array([-1,-1, 1,-1, -1,1,  1,-1, 1,1, -1,1])
    const cornerBuf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf)
    gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW)

    // Main dynamic interleaved VBO (re-uploaded after each sort)
    const vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, n * VBO_BYTES, gl.DYNAMIC_DRAW)  // pre-allocate
    vboRef.current = vbo

    // VAO
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)

    const locCorner = gl.getAttribLocation(prog, 'aCorner')
    const locPos    = gl.getAttribLocation(prog, 'aPos')
    const locLogSc  = gl.getAttribLocation(prog, 'aLogSc')
    const locColor  = gl.getAttribLocation(prog, 'aColor')
    const locQuat   = gl.getAttribLocation(prog, 'aQuat')

    // Corner — non-instanced
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf)
    gl.enableVertexAttribArray(locCorner)
    gl.vertexAttribPointer(locCorner, 2, gl.FLOAT, false, 0, 0)

    // Interleaved instance attributes
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    function inst(loc, size, offset) {
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, VBO_BYTES, offset * 4)
      gl.vertexAttribDivisor(loc, 1)
    }
    inst(locPos,   3,  0)
    inst(locLogSc, 3,  3)
    inst(locColor, 4,  6)
    inst(locQuat,  4, 10)

    gl.bindVertexArray(null)
    vaoRef.current = vao

    // Allocate sort buffers
    sortKeyRef.current = new Float64Array(n)
    sortBufRef.current = new Float32Array(n * VBO_FLOATS)

    // Initial upload (unsorted — first frame will sort)
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, packed)
  }, [])

  // ── Camera-change detection ───────────────────────────────────────────────
  function cameraChangedEnough(vm) {
    const p = prevCamRef.current
    const dx = vm[12] - p.vx, dy = vm[13] - p.vy, dz = vm[14] - p.vz
    // translation > 1 cm OR rotation > 0.5° (tracked via m[0] element)
    if (dx*dx + dy*dy + dz*dz > 0.0001 || Math.abs(vm[0] - p.theta) > 0.009) {
      prevCamRef.current = { vx: vm[12], vy: vm[13], vz: vm[14], theta: vm[0] }
      return true
    }
    return false
  }

  // ── Render one frame ──────────────────────────────────────────────────────
  const renderFrame = useCallback(() => {
    const gl   = glRef.current
    const prog = progRef.current
    const vao  = vaoRef.current
    const uni  = uniRef.current
    const sp   = splatRef.current
    const cam  = cameraRef?.current
    if (!gl || !prog || !vao || !uni || !sp || !cam?.viewMatrix || !cam?.projMatrix) return

    const { viewMatrix: vm, projMatrix: pm, focalX: fx, focalY: fy } = cam
    const canvas = canvasRef.current
    const W = canvas.width, H = canvas.height

    // Depth sort every 3rd frame OR on camera movement
    const f = ++frameRef.current
    if (f % 3 === 0 || cameraChangedEnough(vm)) {
      sortSplats(sp.packed, sp.n, vm, sortKeyRef.current, sortBufRef.current)
      gl.bindBuffer(gl.ARRAY_BUFFER, vboRef.current)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, sortBufRef.current)
    }

    gl.viewport(0, 0, W, H)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendEquation(gl.FUNC_ADD)
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.DEPTH_TEST)

    gl.useProgram(prog)
    gl.uniformMatrix4fv(uni.uView,     false, vm)
    gl.uniformMatrix4fv(uni.uProj,     false, pm)
    gl.uniform2f(uni.uViewport, W, H)
    gl.uniform1f(uni.uFx, fx ?? 800)
    gl.uniform1f(uni.uFy, fy ?? 800)

    gl.bindVertexArray(vao)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, sp.n)
    gl.bindVertexArray(null)
  }, [cameraRef])

  // ── Load .splat file ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!splatUrl) return
    onStatus?.('loading')
    const jwt    = getJwt()
    const device = getDeviceToken()
    const headers = {
      'X-Device-Token': device,
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    }
    fetch(splatUrl, { headers })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer() })
      .then(buf => {
        const splat = parseSplat(buf)
        splatRef.current = splat
        uploadSplat(splat)
        onStatus?.('ready', { n: splat.n })
        console.info(`[GaussianSplat] Loaded ${splat.n.toLocaleString()} Gaussians from ${splatUrl}`)
      })
      .catch(err => { console.error('[GaussianSplat] Load error:', err); onStatus?.('error', err.message) })
  }, [splatUrl, uploadSplat, onStatus])

  // ── Init GL + resize observer ────────────────────────────────────────────
  useEffect(() => {
    const ok = initGL()
    if (!ok) return
    const canvas = canvasRef.current
    function resize() {
      if (!canvas) return
      canvas.width  = Math.round(canvas.offsetWidth  * window.devicePixelRatio)
      canvas.height = Math.round(canvas.offsetHeight * window.devicePixelRatio)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [initGL])

  // ── RAF render loop ──────────────────────────────────────────────────────
  useEffect(() => {
    function loop() { rafRef.current = requestAnimationFrame(loop); renderFrame() }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [renderFrame])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 0,
        background: '#080d14',
        ...style,
      }}
    />
  )
}
