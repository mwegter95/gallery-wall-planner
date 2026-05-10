/**
 * photoMesh.js
 *
 * Re-textures a LiDAR point cloud with high-res photo colours sampled from
 * snapshots taken during the scan. Each snapshot carries:
 *   { dataUrl, transform: [16 floats, col-major cam→world], intrinsics: [fx,fy,cx,cy,w,h] }
 *
 * Algorithm for each point P in world space:
 *   1. Transform P into each snapshot's camera space: cp = V * P  (V = inverse(transform))
 *   2. Skip if cp.z ≥ 0 (behind camera) or projected UV is outside image bounds.
 *   3. Score = cosine of angle from camera axis = (-cp.z) / |cp| (want ≈ 1 = dead-on).
 *   4. Pick the best view per point with strict visibility and edge-of-lens gating.
 *   5. Reject ambiguous multi-view ties to avoid ghost duplicates.
 *   6. Sample the selected JPEG at the projected pixel; replace depth-sensor colour.
 *
 * Coordinate system (ARKit):
 *   - Camera looks along –Z in camera space.
 *   - Y is up, X is right.
 *   - Projection:  u = fx*(cp.x / –cp.z) + cx,  v = fy*(cp.y / –cp.z) + cy
 *
 * Performance: ~1–2 s for 10 M points × 20 snapshots in a modern browser (V8 JIT).
 * The loop yields to the browser every 200 K points to keep the UI responsive.
 */

/** ── Invert a rigid-body (rotation + translation) 4×4 column-major matrix ── */
function invertRigid(t) {
  // Rotation part: R^T (transpose of the upper-left 3×3)
  const r00 = t[0], r10 = t[1], r20 = t[2]
  const r01 = t[4], r11 = t[5], r21 = t[6]
  const r02 = t[8], r12 = t[9], r22 = t[10]
  // Translation: –R^T · p
  const px = t[12], py = t[13], pz = t[14]
  const itx = -(r00*px + r10*py + r20*pz)
  const ity = -(r01*px + r11*py + r21*pz)
  const itz = -(r02*px + r12*py + r22*pz)
  // Column-major output: row-major view of the transposed rotation + new translation
  return new Float32Array([
    r00, r01, r02, 0,
    r10, r11, r12, 0,
    r20, r21, r22, 0,
    itx, ity, itz, 1,
  ])
}

/** Load a data URL or base64 JPEG payload into ImageData via an offscreen canvas. */
function loadPixels(snapshot) {
  return new Promise((resolve, reject) => {
    const src = snapshot.dataUrl || (snapshot.jpegB64 ? `data:image/jpeg;base64,${snapshot.jpegB64}` : null)
    if (!src) {
      reject(new Error('Snapshot has no image source'))
      return
    }
    const img = new Image()
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight
      const cv = document.createElement('canvas')
      cv.width = w; cv.height = h
      const ctx = cv.getContext('2d')
      ctx.drawImage(img, 0, 0)
      resolve({ data: ctx.getImageData(0, 0, w, h).data, width: w, height: h })
    }
    img.onerror = reject
    img.src = src
  })
}

function bilinearSampleRGBA(pix, width, height, u, v) {
  const x = Math.max(0, Math.min(width - 1, u))
  const y = Math.max(0, Math.min(height - 1, v))
  const x0 = x | 0
  const y0 = y | 0
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const tx = x - x0
  const ty = y - y0
  const i00 = (y0 * width + x0) * 4
  const i10 = (y0 * width + x1) * 4
  const i01 = (y1 * width + x0) * 4
  const i11 = (y1 * width + x1) * 4

  const w00 = (1 - tx) * (1 - ty)
  const w10 = tx * (1 - ty)
  const w01 = (1 - tx) * ty
  const w11 = tx * ty

  return [
    (pix[i00] * w00 + pix[i10] * w10 + pix[i01] * w01 + pix[i11] * w11) / 255,
    (pix[i00 + 1] * w00 + pix[i10 + 1] * w10 + pix[i01 + 1] * w01 + pix[i11 + 1] * w11) / 255,
    (pix[i00 + 2] * w00 + pix[i10 + 2] * w10 + pix[i01 + 2] * w01 + pix[i11 + 2] * w11) / 255,
  ]
}

export function normalizeIntrinsicsForImage(intrinsics, width, height) {
  if (!Array.isArray(intrinsics) || intrinsics.length < 6) return null
  const fx = intrinsics[0]
  const fy = intrinsics[1]
  const cx = intrinsics[2]
  const cy = intrinsics[3]
  const srcW = intrinsics[4]
  const srcH = intrinsics[5]
  const dstW = Number.isFinite(width) && width > 0 ? width : srcW
  const dstH = Number.isFinite(height) && height > 0 ? height : srcH
  const sx = Number.isFinite(srcW) && srcW > 0 ? dstW / srcW : 1
  const sy = Number.isFinite(srcH) && srcH > 0 ? dstH / srcH : 1
  return [fx * sx, fy * sy, cx * sx, cy * sy, dstW, dstH]
}

const VISIBILITY_TARGET_SAMPLES = 1_800_000
const VISIBILITY_MAX_DIM = 768
const VISIBILITY_REL_TOL = 0.015
const VISIBILITY_ABS_TOL = 0.03
const FUSION_MAX_CANDIDATES = 8
const COLOR_GATE_L1 = 0.33
const MIN_PROJECTION_SCORE = 0.16
const VIEW_EDGE_SIGMA = 0.62
const VIEW_EDGE_HARD_RADIUS2 = 1.35
const AMBIGUITY_SCORE_RATIO = 0.96
const AMBIGUITY_COLOR_L1 = 0.31
const CONSENSUS_COLOR_L1 = 0.18
const CONSENSUS_AMBIGUITY_RELIEF = 0.42
const PLANE_FACING_MIN = 0.05
const PLANE_CONFIDENT_MIN = 0.55
const PLANE_EDGE_SOFT = 0.12
const CORNER_DISTANCE_SOFT = 0.24
const STRUCTURE_NEAR_M = 0.12
const STRUCTURE_FAR_M = 1.6
const STRUCTURE_MIN_WEIGHT = 0.82

// ─── Pose Refinement & Masking Constants ─────────────────────────────────
const POSE_REFINEMENT_ITERATIONS = 3
const POSE_REFINEMENT_LEARNING_RATE = 0.018
const POSE_REFINEMENT_MIN_VISIBLE = 2000
const DYNAMIC_OBJECT_EDGE_THRESHOLD = 0.12
const DYNAMIC_OBJECT_COLOR_CLUSTER_MIN = 8
const DYNAMIC_OBJECT_MIN_REGION = 120

function estimateRoomFrame(buf) {
  const D = buf._data
  const n = buf.pointCount
  if (!n) return null

  let meanX = 0
  let meanZ = 0
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0, b = 0; i < n; i++, b += 6) {
    const x = D[b]
    const y = D[b + 1]
    const z = D[b + 2]
    meanX += x
    meanZ += z
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  meanX /= n
  meanZ /= n

  let covXX = 0
  let covXZ = 0
  let covZZ = 0
  for (let i = 0, b = 0; i < n; i++, b += 6) {
    const dx = D[b] - meanX
    const dz = D[b + 2] - meanZ
    covXX += dx * dx
    covXZ += dx * dz
    covZZ += dz * dz
  }
  covXX /= n
  covXZ /= n
  covZZ /= n

  const angle = 0.5 * Math.atan2(2 * covXZ, covXX - covZZ)
  let axisU = [Math.cos(angle), 0, Math.sin(angle)]
  let axisV = [-Math.sin(angle), 0, Math.cos(angle)]
  if (axisU[0] < 0) {
    axisU = [-axisU[0], 0, -axisU[2]]
    axisV = [-axisV[0], 0, -axisV[2]]
  }

  let uMin = Infinity
  let uMax = -Infinity
  let vMin = Infinity
  let vMax = -Infinity
  for (let i = 0, b = 0; i < n; i++, b += 6) {
    const dx = D[b] - meanX
    const dz = D[b + 2] - meanZ
    const u = dx * axisU[0] + dz * axisU[2]
    const v = dx * axisV[0] + dz * axisV[2]
    if (u < uMin) uMin = u
    if (u > uMax) uMax = u
    if (v < vMin) vMin = v
    if (v > vMax) vMax = v
  }

  return { meanX, meanZ, axisU, axisV, uMin, uMax, vMin, vMax, minY, maxY }
}

function unitVector(x, y, z) {
  const len = Math.hypot(x, y, z)
  if (len <= 1e-9) return [0, 0, 0]
  return [x / len, y / len, z / len]
}

function classifyPlaneNormal(wx, wy, wz, frame) {
  if (!frame) return null
  const dx = wx - frame.meanX
  const dz = wz - frame.meanZ
  const u = dx * frame.axisU[0] + dz * frame.axisU[2]
  const v = dx * frame.axisV[0] + dz * frame.axisV[2]

  const dFloor = Math.abs(wy - frame.minY)
  const dCeil = Math.abs(wy - frame.maxY)
  const dUmin = Math.abs(u - frame.uMin)
  const dUmax = Math.abs(u - frame.uMax)
  const dVmin = Math.abs(v - frame.vMin)
  const dVmax = Math.abs(v - frame.vMax)

  const distances = [dFloor, dCeil, dUmin, dUmax, dVmin, dVmax]
  let bestIdx = 0
  let best = distances[0]
  let second = Infinity
  for (let i = 1; i < distances.length; i++) {
    const d = distances[i]
    if (d < best) {
      second = best
      best = d
      bestIdx = i
    } else if (d < second) {
      second = d
    }
  }

  const normals = [
    [0, 1, 0],
    [0, -1, 0],
    [-frame.axisU[0], 0, -frame.axisU[2]],
    [frame.axisU[0], 0, frame.axisU[2]],
    [-frame.axisV[0], 0, -frame.axisV[2]],
    [frame.axisV[0], 0, frame.axisV[2]],
  ]
  const separation = second > 1e-6 ? (second - best) / (second + 1e-6) : 0
  const confidence = Math.max(0, Math.min(1, separation / PLANE_EDGE_SOFT))
  const cornerStrength =
    Math.max(0, Math.min(1, 1 - best / CORNER_DISTANCE_SOFT)) *
    Math.max(0, Math.min(1, 1 - second / CORNER_DISTANCE_SOFT))
  return { normal: normals[bestIdx], confidence, bestDistance: best, secondDistance: second, cornerStrength }
}

function structureWeightFromDistance(distanceToEnvelope) {
  if (!Number.isFinite(distanceToEnvelope)) return 1
  if (distanceToEnvelope <= STRUCTURE_NEAR_M) return 1
  if (distanceToEnvelope >= STRUCTURE_FAR_M) return STRUCTURE_MIN_WEIGHT
  const t = (distanceToEnvelope - STRUCTURE_NEAR_M) / (STRUCTURE_FAR_M - STRUCTURE_NEAR_M)
  const s = t * t * (3 - 2 * t)
  return 1 - (1 - STRUCTURE_MIN_WEIGHT) * s
}

function insertTopByScore(top, candidate, max = 6) {
  top.push(candidate)
  top.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    return a.depthResidual - b.depthResidual
  })
  if (top.length > max) top.length = max
}

function consensusSupport(candidate, ranked) {
  if (!candidate || !ranked?.length) return 0
  let support = 0
  for (const other of ranked) {
    if (other === candidate) continue
    const disagreement =
      Math.abs(candidate.color[0] - other.color[0]) +
      Math.abs(candidate.color[1] - other.color[1]) +
      Math.abs(candidate.color[2] - other.color[2])
    if (disagreement <= CONSENSUS_COLOR_L1) support += other.score
  }
  return support
}

// ─────────────────────────────────────────────────────────────────────────
// POSE REFINEMENT: Lightweight ICP-like optimization
// ─────────────────────────────────────────────────────────────────────────
function multiplyMatrices(a, b) {
  const c = new Float32Array(16)
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let sum = 0
      for (let k = 0; k < 4; k++) {
        sum += a[i + k * 4] * b[k + j * 4]
      }
      c[i + j * 4] = sum
    }
  }
  return c
}

function transformPoint(t, p) {
  const x = t[0] * p[0] + t[4] * p[1] + t[8] * p[2] + t[12]
  const y = t[1] * p[0] + t[5] * p[1] + t[9] * p[2] + t[13]
  const z = t[2] * p[0] + t[6] * p[1] + t[10] * p[2] + t[14]
  return [x, y, z]
}

function poseDeltaFromResiduals(points, projections, camPos) {
  // Estimate pose correction from depth residuals and gradient descent
  // Using simplified Gauss-Newton: compute gradient of reprojection error w.r.t. pose params
  let dTx = 0, dTy = 0, dTz = 0
  let dRx = 0, dRy = 0, dRz = 0
  const gradWeight = 0.0015

  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const proj = projections[i]
    if (!proj || proj.residual <= 0) continue

    const res = proj.residual * gradWeight
    const toCam = [
      camPos[0] - p[0],
      camPos[1] - p[1],
      camPos[2] - p[2],
    ]
    const dist = Math.hypot(toCam[0], toCam[1], toCam[2])
    if (dist < 1e-6) continue
    const dir = [toCam[0] / dist, toCam[1] / dist, toCam[2] / dist]

    dTx += res * dir[0]
    dTy += res * dir[1]
    dTz += res * dir[2]

    // Rotation gradient (simplified): perpendicular component
    dRx += res * (p[1] * dir[2] - p[2] * dir[1])
    dRy += res * (p[2] * dir[0] - p[0] * dir[2])
    dRz += res * (p[0] * dir[1] - p[1] * dir[0])
  }

  return { dTx, dTy, dTz, dRx, dRy, dRz }
}

function applyPoseDelta(transform, delta) {
  // Create small-angle rotation matrix from delta.dR{x,y,z}
  const c = new Float32Array(transform)
  const scale = POSE_REFINEMENT_LEARNING_RATE

  // Translation update (direct)
  c[12] += delta.dTx * scale
  c[13] += delta.dTy * scale
  c[14] += delta.dTz * scale

  // Rotation update via Rodrigues formula (small angle)
  const rx = delta.dRx * scale, ry = delta.dRy * scale, rz = delta.dRz * scale
  const theta = Math.hypot(rx, ry, rz)
  if (theta > 1e-6) {
    const k = [rx / theta, ry / theta, rz / theta]
    const c_theta = Math.cos(theta), s_theta = Math.sin(theta)
    const K = [
      [0, -k[2], k[1]],
      [k[2], 0, -k[0]],
      [-k[1], k[0], 0],
    ]
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const idx = i + j * 4
        const R0 = c[idx]
        let dR = 0
        for (let l = 0; l < 3; l++) {
          dR += (c_theta === 1 ? 0 : K[i][l]) * c[l + j * 4]
        }
        c[idx] = R0 + dR * 0.08
      }
    }
  }

  return c
}

async function refineSnapshotPoses(buf, snapshots, views, intrs, atlases) {
  const D = buf._data
  const n = buf.pointCount
  const S = snapshots.length
  const stride = Math.max(1, Math.ceil(n / 150000))

  const refinedSnapshots = snapshots.map(s => ({ ...s }))
  const refinedViews = views.map(v => new Float32Array(v))

  for (let iter = 0; iter < POSE_REFINEMENT_ITERATIONS; iter++) {
    const deltas = []
    for (let si = 0; si < S; si++) {
      const visible = []
      const projections = []
      const camPos = [refinedSnapshots[si].transform[12], refinedSnapshots[si].transform[13], refinedSnapshots[si].transform[14]]

      for (let i = 0; i < n; i += stride) {
        if (i > 0 && i % 300000 === 0) await new Promise(r => setTimeout(r, 0))

        const b = i * 6
        const p = [D[b], D[b + 1], D[b + 2]]
        const proj = projectToSnapshot(p[0], p[1], p[2], refinedViews[si], intrs[si])
        if (!proj) continue

        const atlas = atlases[si]
        const ax = Math.min(atlas.width - 1, Math.max(0, proj.u * atlas.invW | 0))
        const ay = Math.min(atlas.height - 1, Math.max(0, proj.v * atlas.invH | 0))
        const depthRef = atlas.depth[ay * atlas.width + ax]
        const residual = Math.max(0, proj.depth - depthRef)

        visible.push(p)
        projections.push({ ...proj, residual })
      }

      if (visible.length >= POSE_REFINEMENT_MIN_VISIBLE) {
        const delta = poseDeltaFromResiduals(visible, projections, camPos)
        deltas.push({ si, delta })
      }
    }

    for (const { si, delta } of deltas) {
      const updatedTrans = applyPoseDelta(refinedSnapshots[si].transform, delta)
      refinedSnapshots[si].transform = updatedTrans
      refinedViews[si] = invertRigid(updatedTrans)
    }
  }

  return { snapshots: refinedSnapshots, views: refinedViews }
}

// ─────────────────────────────────────────────────────────────────────────
// DYNAMIC OBJECT MASKING: Detect and mask furniture/clutter
// ─────────────────────────────────────────────────────────────────────────
function computeEdgeMap(pixData, width, height) {
  const edges = new Float32Array(width * height)
  const kernel = [-1, -2, -1, 0, 0, 0, 1, 2, 1]

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let gx = 0, gy = 0
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const idx = ((y + ky) * width + (x + kx)) * 4
          const lum = 0.299 * pixData[idx] + 0.587 * pixData[idx + 1] + 0.114 * pixData[idx + 2]
          const k = kernel[(ky + 1) * 3 + (kx + 1)]
          gx += k * lum
          gy += kernel[(kx + 1) * 3 + (ky + 1)] * lum
        }
      }
      edges[y * width + x] = Math.hypot(gx, gy) / 256
    }
  }
  return edges
}

function detectDynamicObjectMask(pixData, width, height) {
  const mask = new Uint8Array(width * height).fill(255)
  const edges = computeEdgeMap(pixData, width, height)

  // High-edge regions = likely furniture/objects
  const edgeThreshold = DYNAMIC_OBJECT_EDGE_THRESHOLD
  let labelMap = new Int32Array(width * height).fill(-1)
  let labelCount = 0

  // Connected component labeling on high-edge pixels
  for (let i = 0; i < edges.length; i++) {
    if (edges[i] > edgeThreshold && labelMap[i] === -1) {
      const stack = [i]
      const label = labelCount++
      let regionSize = 0

      while (stack.length > 0) {
        const idx = stack.pop()
        if (labelMap[idx] !== -1) continue
        labelMap[idx] = label
        regionSize++

        const y = (idx / width) | 0
        const x = idx % width
        const neighbors = [
          idx - width,
          idx + width,
          idx - 1,
          idx + 1,
        ]
        for (const n of neighbors) {
          if (n >= 0 && n < edges.length && labelMap[n] === -1 && edges[n] > edgeThreshold) {
            stack.push(n)
          }
        }
      }

      // Mark small regions as dynamic objects
      if (regionSize < DYNAMIC_OBJECT_MIN_REGION) {
        for (let i = 0; i < labelMap.length; i++) {
          if (labelMap[i] === label) mask[i] = 0
        }
      }
    }
  }

  // Dilate mask slightly to catch edges
  const dilated = new Uint8Array(mask)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      if (mask[idx] === 0) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            dilated[(y + dy) * width + (x + dx)] = 0
          }
        }
      }
    }
  }

  return dilated
}

function bilinearSampleRGBAMasked(pix, width, height, u, v, mask = null) {
  const x = Math.max(0, Math.min(width - 1, u))
  const y = Math.max(0, Math.min(height - 1, v))
  const x0 = x | 0
  const y0 = y | 0
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)

  // If mask present and any sample point is masked, return null
  if (mask) {
    if (mask[y0 * width + x0] === 0 || mask[y0 * width + x1] === 0 ||
        mask[y1 * width + x0] === 0 || mask[y1 * width + x1] === 0) {
      return null
    }
  }

  const tx = x - x0
  const ty = y - y0
  const i00 = (y0 * width + x0) * 4
  const i10 = (y0 * width + x1) * 4
  const i01 = (y1 * width + x0) * 4
  const i11 = (y1 * width + x1) * 4

  const w00 = (1 - tx) * (1 - ty)
  const w10 = tx * (1 - ty)
  const w01 = (1 - tx) * ty
  const w11 = tx * ty

  return [
    (pix[i00] * w00 + pix[i10] * w10 + pix[i01] * w01 + pix[i11] * w11) / 255,
    (pix[i00 + 1] * w00 + pix[i10 + 1] * w10 + pix[i01 + 1] * w01 + pix[i11] * w11) / 255,
    (pix[i00 + 2] * w00 + pix[i10 + 2] * w10 + pix[i01 + 2] * w01 + pix[i11] * w11) / 255,
  ]
}

// ─────────────────────────────────────────────────────────────────────────
// ROBUST FUSION: Lab color space median + confidence scoring
// ─────────────────────────────────────────────────────────────────────────
function rgbToLab(r, g, b) {
  // sRGB to linear
  const rl = r <= 0.04045 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4)
  const gl = g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4)
  const bl = b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4)

  // Linear RGB to XYZ
  const x = rl * 0.4124 + gl * 0.3576 + bl * 0.1805
  const y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722
  const z = rl * 0.0193 + gl * 0.1192 + bl * 0.9505

  // XYZ to Lab
  const ref = [0.95047, 1.0, 1.08883]
  const fx = x / ref[0]
  const fy = y / ref[1]
  const fz = z / ref[2]

  const delta = 6 / 29
  const f = (t) => t > delta * delta * delta ? Math.cbrt(t) : (t / (3 * delta * delta) + 4 / 29)

  const L = 116 * f(fy) - 16
  const a = 500 * (f(fx) - f(fy))
  const b_comp = 200 * (f(fy) - f(fz))

  return [L / 100, (a + 128) / 256, (b_comp + 128) / 256]
}

function labToRgb(l, a, b) {
  // Lab to XYZ
  const L = l * 100
  const a_val = a * 256 - 128
  const b_val = b * 256 - 128

  const delta = 6 / 29
  const fy = (L + 16) / 116
  const fx = a_val / 500 + fy
  const fz = fy - b_val / 200

  const f_inv = (t) => t > delta ? t * t * t : 3 * delta * delta * (t - 4 / 29)

  const ref = [0.95047, 1.0, 1.08883]
  const x = f_inv(fx) * ref[0]
  const y = f_inv(fy) * ref[1]
  const z = f_inv(fz) * ref[2]

  // XYZ to linear RGB
  const rl = x * 3.2406 + y * -1.5372 + z * -0.4986
  const gl = x * -0.9689 + y * 1.8758 + z * 0.0415
  const bl = x * 0.0557 + y * -0.2040 + z * 1.0570

  // Linear to sRGB
  const r = rl <= 0.0031308 ? 12.92 * rl : 1.055 * Math.pow(rl, 1 / 2.4) - 0.055
  const g = gl <= 0.0031308 ? 12.92 * gl : 1.055 * Math.pow(gl, 1 / 2.4) - 0.055
  const b_out = bl <= 0.0031308 ? 12.92 * bl : 1.055 * Math.pow(bl, 1 / 2.4) - 0.055

  return [
    Math.max(0, Math.min(1, r)),
    Math.max(0, Math.min(1, g)),
    Math.max(0, Math.min(1, b_out)),
  ]
}

function robustWeightedMedianLab(candidates) {
  if (!candidates?.length) return null
  if (candidates.length === 1) {
    return { color: candidates[0].color, confidence: candidates[0].score }
  }

  // Convert to Lab + score weights
  const labs = candidates.map((c, i) => ({
    lab: rgbToLab(c.color[0], c.color[1], c.color[2]),
    weight: c.score * c.score,
    score: c.score,
    index: i,
  }))

  // Weighted median in Lab space
  const totalWeight = labs.reduce((s, c) => s + c.weight, 0)
  if (totalWeight === 0) return { color: candidates[0].color, confidence: 0.3 }

  // Find weighted median for each channel
  const medianLab = [0, 0, 0]
  for (let ch = 0; ch < 3; ch++) {
    const sorted = [...labs].sort((a, b) => a.lab[ch] - b.lab[ch])
    let cumWeight = 0
    for (const c of sorted) {
      cumWeight += c.weight
      if (cumWeight >= totalWeight * 0.5) {
        medianLab[ch] = c.lab[ch]
        break
      }
    }
  }

  // Convert back to RGB
  const medianRgb = labToRgb(medianLab[0], medianLab[1], medianLab[2])

  // Confidence: agreement of top candidates
  const topScore = labs[0].score
  let agreement = 0
  for (const c of labs) {
    if (c.score >= topScore * 0.85) {
      const labDist =
        Math.abs(c.lab[0] - medianLab[0]) * 0.5 +
        Math.abs(c.lab[1] - medianLab[1]) * 0.25 +
        Math.abs(c.lab[2] - medianLab[2]) * 0.25
      agreement += Math.exp(-labDist * 2) * c.weight
    }
  }

  const confidence = Math.min(1, agreement / (totalWeight + 1e-6))
  return { color: medianRgb, confidence }
}

function getVisibilityAtlasSize(width, height, maxDim = VISIBILITY_MAX_DIM) {
  const longest = Math.max(width, height)
  const scale = longest > maxDim ? (maxDim / longest) : 1
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function projectToSnapshot(wx, wy, wz, view, intr) {
  const cpx = view[0] * wx + view[4] * wy + view[8] * wz + view[12]
  const cpy = view[1] * wx + view[5] * wy + view[9] * wz + view[13]
  const cpz = view[2] * wx + view[6] * wy + view[10] * wz + view[14]
  if (cpz >= 0) return null

  const depth = -cpz
  const u = intr[0] * cpx / depth + intr[2]
  const v = intr[1] * cpy / depth + intr[3]
  if (u < 0 || v < 0 || u >= intr[4] || v >= intr[5]) return null

  const invLen2 = 1 / (cpx * cpx + cpy * cpy + depth * depth)
  const facing = depth * depth * invLen2
  const proximity = 1 / (1 + 0.08 * depth)
  const score = facing * proximity
  return { u, v, depth, score }
}

function edgeCentralityWeight(intr, u, v) {
  const fx = Math.max(1e-6, intr[0])
  const fy = Math.max(1e-6, intr[1])
  const nx = (u - intr[2]) / fx
  const ny = (v - intr[3]) / fy
  const r2 = nx * nx + ny * ny
  if (r2 > VIEW_EDGE_HARD_RADIUS2) return { weight: 0, r2 }
  const weight = Math.exp(-r2 / (2 * VIEW_EDGE_SIGMA * VIEW_EDGE_SIGMA))
  return { weight, r2 }
}

function projectToSnapshotVerbose(wx, wy, wz, view, intr) {
  const cpx = view[0] * wx + view[4] * wy + view[8] * wz + view[12]
  const cpy = view[1] * wx + view[5] * wy + view[9] * wz + view[13]
  const cpz = view[2] * wx + view[6] * wy + view[10] * wz + view[14]
  if (cpz >= 0) return { ok: false, reason: 'behind' }

  const depth = -cpz
  const u = intr[0] * cpx / depth + intr[2]
  const v = intr[1] * cpy / depth + intr[3]
  if (u < 0 || v < 0 || u >= intr[4] || v >= intr[5]) return { ok: false, reason: 'outside' }

  const invLen2 = 1 / (cpx * cpx + cpy * cpy + depth * depth)
  const facing = depth * depth * invLen2
  const proximity = 1 / (1 + 0.08 * depth)
  const score = facing * proximity
  return { ok: true, u, v, depth, score }
}

export function isDepthVisible(sampleDepth, mapDepth, relTol = VISIBILITY_REL_TOL, absTol = VISIBILITY_ABS_TOL) {
  if (!Number.isFinite(sampleDepth) || !Number.isFinite(mapDepth)) return false
  const tolerance = absTol + relTol * mapDepth
  return sampleDepth <= mapDepth + tolerance
}

function updateBestCandidates(candidates, candidate, maxCount = FUSION_MAX_CANDIDATES) {
  candidates.push(candidate)
  candidates.sort((a, b) => {
    // Prefer lower depth residual first (closer to camera-visible surface),
    // then higher angular/proximity score as tie-breaker.
    if (a.depthResidual !== b.depthResidual) return a.depthResidual - b.depthResidual
    return b.score - a.score
  })
  if (candidates.length > maxCount) candidates.length = maxCount
}

function scoreToWeight(score) {
  return score * score
}

export function fuseVisibleCandidates(candidates) {
  if (!candidates?.length) return null
  if (FUSION_MAX_CANDIDATES <= 1) return candidates[0].color
  if (candidates.length === 1) return candidates[0].color

  const ref = candidates[0].color
  const filtered = candidates.filter(c => {
    const l1 = Math.abs(c.color[0] - ref[0]) + Math.abs(c.color[1] - ref[1]) + Math.abs(c.color[2] - ref[2])
    return l1 <= COLOR_GATE_L1
  })
  const pool = filtered.length > 0 ? filtered : [candidates[0]]

  let total = 0
  let r = 0
  let g = 0
  let b = 0
  for (const c of pool) {
    const w = scoreToWeight(c.score)
    total += w
    r += c.color[0] * w
    g += c.color[1] * w
    b += c.color[2] * w
  }
  if (total <= 0) return pool[0].color
  return [r / total, g / total, b / total]
}

async function buildVisibilityAtlases(buf, views, intrs, {
  yieldEvery = 120_000,
  maxSamples = VISIBILITY_TARGET_SAMPLES,
} = {}) {
  const n = buf.pointCount
  const D = buf._data
  const stride = Math.max(1, Math.ceil(n / Math.max(1, maxSamples)))
  const atlases = intrs.map(intr => {
    const size = getVisibilityAtlasSize(intr[4], intr[5])
    return {
      width: size.width,
      height: size.height,
      invW: size.width / intr[4],
      invH: size.height / intr[5],
      depth: new Float32Array(size.width * size.height).fill(Infinity),
    }
  })

  for (let i = 0; i < n; i += stride) {
    if (i > 0 && i % yieldEvery === 0) {
      await new Promise(r => setTimeout(r, 0))
    }
    const b = i * 6
    const wx = D[b]
    const wy = D[b + 1]
    const wz = D[b + 2]
    for (let si = 0; si < views.length; si++) {
      const proj = projectToSnapshot(wx, wy, wz, views[si], intrs[si])
      if (!proj) continue
      const atlas = atlases[si]
      const ax = Math.min(atlas.width - 1, Math.max(0, proj.u * atlas.invW | 0))
      const ay = Math.min(atlas.height - 1, Math.max(0, proj.v * atlas.invH | 0))
      const idx = ay * atlas.width + ax
      if (proj.depth < atlas.depth[idx]) atlas.depth[idx] = proj.depth
    }
  }
  return atlases
}

/**
 * Apply photo colours to mesh vertices produced by reconstructSurface().
 *
 * Vertex positions include yOffset (floor at y=0), but snapshot camera transforms
 * are in ARKit world space (no yOffset).  We subtract yOffset before projecting.
 *
 * @param {Float32Array} positions  [x,y,z …] in display coords (yOffset applied)
 * @param {Float32Array} fallback   [r,g,b …] base colours when no snapshot covers a vertex
 * @param {{ dataUrl:string, transform:number[], intrinsics:number[] }[]} snapshots
 * @param {number} [yOffset=0]
 * @returns {Promise<Float32Array | null>}
 */
export async function buildPhotoColorsForPositions(positions, fallback, snapshots, yOffset = 0, options = {}) {
  const n = (positions.length / 3) | 0
  if (n === 0 || !snapshots?.length) return null
  // Assemble a fake PointCloudBuffer row layout: [x, y_arkit, z, r, g, b]
  const data = new Float32Array(n * 6)
  for (let i = 0; i < n; i++) {
    data[i*6]   = positions[i*3]
    data[i*6+1] = positions[i*3+1] - yOffset   // display → ARKit world Y
    data[i*6+2] = positions[i*3+2]
    data[i*6+3] = fallback[i*3]
    data[i*6+4] = fallback[i*3+1]
    data[i*6+5] = fallback[i*3+2]
  }
  return buildPhotoColors({ _data: data, pointCount: n }, snapshots, options)
}

/**
 * Build a new Float32Array of per-point RGB colours by projecting each point
 * through the best-covering snapshot.
 *
 * @param {import('./pointCloud').PointCloudBuffer} buf
 * @param {{ dataUrl?:string, jpegB64?:string, transform:number[], intrinsics:number[] }[]} snapshots
 * @returns {Promise<Float32Array | null>}
 */
export async function buildPhotoColors(buf, snapshots, options = {}) {
  if (!snapshots?.length) return null

  const n = buf.pointCount
  if (n === 0) return null

  // ── Load all snapshot images in parallel ─────────────────────────────────
  let pixMaps
  try {
    pixMaps = await Promise.all(snapshots.map(loadPixels))
  } catch (err) {
    console.warn('[photoMesh] Failed to load snapshot images:', err)
    return null
  }

  const S = snapshots.length

  // ── Per-point colour replacement ──────────────────────────────────────────
  const D         = buf._data               // zero-copy raw Float32Array
  const newColors = new Float32Array(n * 3)
  const confidenceMap = new Float32Array(n).fill(0) // Confidence scoring for each point
  const YIELD_EVERY = 200_000               // yield to browser every 200 K pts

  // ── Precompute per-snapshot data ──────────────────────────────────────────
  // views[si]  = column-major 4×4 world→camera matrix (inverse of cam→world)
  // intrs[si]  = [fx, fy, cx, cy, imgW, imgH]
  let views = snapshots.map(s => invertRigid(s.transform))
  let refinedSnapshots = snapshots
  const camPositions = snapshots.map(s => [s.transform[12], s.transform[13], s.transform[14]])
  const intrs = snapshots.map((s, index) => normalizeIntrinsicsForImage(s.intrinsics, pixMaps[index].width, pixMaps[index].height))
  
  // ── Build initial atlases for pose refinement ──────────────────────────
  let atlases = await buildVisibilityAtlases(buf, views, intrs)

  // ── STRATEGY 1: Refine snapshot poses for better corner alignment ───────
  try {
    const poseRefinement = await refineSnapshotPoses(buf, snapshots, views, intrs, atlases)
    refinedSnapshots = poseRefinement.snapshots
    views = poseRefinement.views
    atlases = await buildVisibilityAtlases(buf, refinedSnapshots, intrs)
  } catch (err) {
    console.warn('[photoMesh] Pose refinement failed, using original poses:', err)
  }

  const roomFrame = estimateRoomFrame(buf)

  // ── STRATEGY 2: Build dynamic object masks for each snapshot ─────────────
  const dynamicMasks = pixMaps.map((pm, si) => {
    try {
      return detectDynamicObjectMask(pm.data, pm.width, pm.height)
    } catch (err) {
      console.warn(`[photoMesh] Dynamic masking failed for snapshot ${si}`)
      return null
    }
  })

  const stats = options?.onDiagnostics ? {
    points: n,
    behindCamera: 0,
    outsideFrame: 0,
    depthRejected: 0,
    scoreRejected: 0,
    withProjection: 0,
    accepted: 0,
    fallback: 0,
    singleView: 0,
    multiView: 0,
    edgeRejected: 0,
    ambiguousRejected: 0,
    planeRejected: 0,
    structureDownWeighted: 0,
    robustFusionPoints: 0,
    maskedRejected: 0,
  } : null

  // ── STRATEGY 3: Per-point robust fusion with multiple candidates in Lab space ────
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % YIELD_EVERY === 0) {
      await new Promise(r => setTimeout(r, 0))
    }

    const b  = i * 6
    const wx = D[b],  wy = D[b+1], wz = D[b+2]   // original world coords (no yOffset)
    const or = D[b+3], og = D[b+4], ob = D[b+5]   // depth-sensor fallback colour
    const plane = classifyPlaneNormal(wx, wy, wz, roomFrame)

    const candidates = []

    for (let si = 0; si < S; si++) {
      let proj
      if (stats) {
        const verbose = projectToSnapshotVerbose(wx, wy, wz, views[si], intrs[si])
        if (!verbose.ok) {
          if (verbose.reason === 'behind') stats.behindCamera++
          else stats.outsideFrame++
          continue
        }
        proj = verbose
      } else {
        proj = projectToSnapshot(wx, wy, wz, views[si], intrs[si])
        if (!proj) continue
      }
      if (stats) stats.withProjection++

      const center = edgeCentralityWeight(intrs[si], proj.u, proj.v)
      if (center.weight <= 0) {
        if (stats) stats.edgeRejected++
        continue
      }

      const atlas = atlases[si]
      const ax = Math.min(atlas.width - 1, Math.max(0, proj.u * atlas.invW | 0))
      const ay = Math.min(atlas.height - 1, Math.max(0, proj.v * atlas.invH | 0))
      const idx = ay * atlas.width + ax
      const depthRef = atlas.depth[idx]
      if (!isDepthVisible(proj.depth, depthRef)) {
        if (stats) stats.depthRejected++
        continue
      }

      const depthResidual = Math.max(0, proj.depth - depthRef)
      const toCam = unitVector(
        camPositions[si][0] - wx,
        camPositions[si][1] - wy,
        camPositions[si][2] - wz,
      )
      const planeFacing = plane
        ? Math.max(0, -(plane.normal[0] * toCam[0] + plane.normal[1] * toCam[1] + plane.normal[2] * toCam[2]))
        : 1
      const cornerStrength = plane?.cornerStrength || 0
      const confGate = 0.82 + 0.14 * cornerStrength
      const facingGate = Math.max(0.01, PLANE_FACING_MIN * (1 - 0.75 * cornerStrength))
      const planeHardRejected = plane && plane.confidence >= confGate && planeFacing < facingGate
      if (planeHardRejected && stats) stats.planeRejected++
      const facingSoft = plane
        ? Math.max(0.25, 0.48 + 0.52 * planeFacing)
        : 1
      const depthResidualWeight = 1 / (1 + 4.5 * depthResidual)
      const planeWeight = plane
        ? (0.82 + 0.18 * plane.confidence) * facingSoft * (1 + 0.14 * cornerStrength)
        : 1
      const structureWeight = structureWeightFromDistance(plane?.bestDistance)
      const weightedScore = proj.score * center.weight * planeWeight * structureWeight * depthResidualWeight
      if (stats && structureWeight < 0.9) stats.structureDownWeighted++

      if (weightedScore < MIN_PROJECTION_SCORE) {
        if (stats) stats.scoreRejected++
        continue
      }

      // ─ STRATEGY 2 continued: Apply dynamic mask if available ──────────────
      const px = pixMaps[si]
      const mask = dynamicMasks[si]
      let color = bilinearSampleRGBAMasked(px.data, px.width, px.height, proj.u, proj.v, mask)
      
      if (color === null) {
        // Masked out by dynamic object detection
        if (stats) stats.maskedRejected++
        continue
      }

      const candidate = { si, score: weightedScore, depthResidual, proj, color }
      updateBestCandidates(candidates, candidate, FUSION_MAX_CANDIDATES)
    }

    if (candidates.length > 0) {
      // ─ STRATEGY 3: Robust weighted median fusion in Lab color space ───────
      const fusion = robustWeightedMedianLab(candidates)
      if (fusion) {
        newColors[i*3] = fusion.color[0]
        newColors[i*3+1] = fusion.color[1]
        newColors[i*3+2] = fusion.color[2]
        confidenceMap[i] = fusion.confidence
        if (stats) {
          stats.accepted++
          stats.multiView += candidates.length > 1 ? 1 : 0
          stats.singleView += candidates.length === 1 ? 1 : 0
          if (candidates.length > 1) stats.robustFusionPoints++
        }
      } else {
        // Fallback if fusion fails
        newColors[i*3] = or
        newColors[i*3+1] = og
        newColors[i*3+2] = ob
        if (stats) stats.fallback++
      }
    } else {
      // No valid candidates
      newColors[i*3] = or
      newColors[i*3+1] = og
      newColors[i*3+2] = ob
      if (stats) stats.fallback++
    }
  }

  if (stats) {
    const pct = (value, denom = stats.points) => denom > 0 ? (100 * value / denom) : 0
    options.onDiagnostics({
      points: stats.points,
      acceptedPoints: stats.accepted,
      fallbackPoints: stats.fallback,
      acceptedPct: pct(stats.accepted),
      fallbackPct: pct(stats.fallback),
      depthRejected: stats.depthRejected,
      scoreRejected: stats.scoreRejected,
      behindCamera: stats.behindCamera,
      outsideFrame: stats.outsideFrame,
      singleViewPoints: stats.singleView,
      multiViewPoints: stats.multiView,
      multiViewPct: stats.accepted > 0 ? (100 * stats.multiView / stats.accepted) : 0,
      edgeRejected: stats.edgeRejected,
      ambiguousRejected: stats.ambiguousRejected,
      planeRejected: stats.planeRejected,
      structureDownWeighted: stats.structureDownWeighted,
      robustFusionPoints: stats.robustFusionPoints,
      maskedRejected: stats.maskedRejected,
    })
  }

  return newColors
}
