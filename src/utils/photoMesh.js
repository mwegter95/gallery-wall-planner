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
const STRICT_VISIBILITY_REL_TOL = 0.007
const STRICT_VISIBILITY_ABS_TOL = 0.012
const FUSION_MAX_CANDIDATES = 1
const COLOR_GATE_L1 = 0.33
const MIN_PROJECTION_SCORE = 0.16
const VIEW_EDGE_SIGMA = 0.62
const VIEW_EDGE_HARD_RADIUS2 = 1.35
const AMBIGUITY_SCORE_RATIO = 0.9
const AMBIGUITY_COLOR_L1 = 0.2
const CONSENSUS_COLOR_L1 = 0.18
const CONSENSUS_AMBIGUITY_RELIEF = 0.42
const PLANE_FACING_MIN = 0.05
const PLANE_CONFIDENT_MIN = 0.55
const PLANE_EDGE_SOFT = 0.12
const CORNER_DISTANCE_SOFT = 0.24
const STRUCTURE_NEAR_M = 0.12
const STRUCTURE_FAR_M = 1.6
const STRUCTURE_MIN_WEIGHT = 0.82
const MAX_DEPTH_RESIDUAL_REJECT = 0.06
const PLANE_CELL_SIZE_M = 0.24
const PLANE_PREF_MAX_SAMPLES = 450_000
const PLANE_PREF_DOMINANCE_RATIO = 1.06
const PLANE_PREF_MATCH_BONUS = 1.2
const PLANE_PREF_MISMATCH_PENALTY = 0.55
const PLANE_PREF_HARD_GATING = true
const PLANE_PREF_COLOR_DRIFT_WEIGHT = 2.8
const PLANE_PREF_MAX_MEAN_DRIFT = 0.74
const SNAPSHOT_RELIABILITY_MAX_SAMPLES = 380_000
const SNAPSHOT_RELIABILITY_MIN = 0.3
const SNAPSHOT_RELIABILITY_RESIDUAL_SCALE = 12
const AUTO_TUNE_MIN_PLANE_CONFIDENCE = 0.3
const AUTO_TUNE_MAX_ENVELOPE_DISTANCE = 0.7
const AUTO_TUNE_MIN_ENVELOPE_DISTANCE = 0.4
const DEPTH_EDGE_GUARD_DEFAULT_M = 0.05
const STRICT_PLANE_REJECTION = true
const RELAXED_RECOVERY_CONFIDENCE_FACTOR = 0.62
const RELAXED_RECOVERY_ENVELOPE_EXPAND_M = 0.26
const RELAXED_RECOVERY_RELIABILITY_FACTOR = 0.72
const RELAXED_RECOVERY_DEPTH_EDGE_EXPAND_M = 0.028
const RELAXED_RECOVERY_SCORE_FACTOR = 0.72
const COLOR_DRIFT_BASE_L1 = 0.78
const COLOR_DRIFT_RELAXED_BONUS = 0.16
const POSE_REFINE_MAX_SAMPLES = 220_000
const POSE_REFINE_DEG_COARSE = 1.6
const POSE_REFINE_DEG_FINE = 0.65

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
  let localU = 0
  let localV = 0
  if (bestIdx === 0 || bestIdx === 1) {
    localU = u
    localV = v
  } else if (bestIdx === 2 || bestIdx === 3) {
    localU = v
    localV = wy
  } else {
    localU = u
    localV = wy
  }
  return {
    normal: normals[bestIdx],
    confidence,
    bestDistance: best,
    secondDistance: second,
    cornerStrength,
    planeIndex: bestIdx,
    localU,
    localV,
  }
}

function planeCellKey(plane, cellSize = PLANE_CELL_SIZE_M) {
  if (!plane || !Number.isFinite(plane.localU) || !Number.isFinite(plane.localV)) return null
  const qu = Math.round(plane.localU / cellSize)
  const qv = Math.round(plane.localV / cellSize)
  return `${plane.planeIndex}:${qu}:${qv}`
}

async function buildPlaneCellSnapshotPreference(buf, views, intrs, atlases, roomFrame, pixMaps, {
  maxSamples = PLANE_PREF_MAX_SAMPLES,
  yieldEvery = 120_000,
} = {}) {
  const n = buf.pointCount
  const D = buf._data
  const S = views.length
  const stride = Math.max(1, Math.ceil(n / Math.max(1, maxSamples)))
  const scoresByCell = new Map()
  const driftSumByCell = new Map()
  const driftWeightByCell = new Map()
  const planeGlobalScores = Array.from({ length: 6 }, () => new Float32Array(S))
  const planeGlobalDriftSums = Array.from({ length: 6 }, () => new Float32Array(S))
  const planeGlobalDriftWeights = Array.from({ length: 6 }, () => new Float32Array(S))

  for (let i = 0; i < n; i += stride) {
    if (i > 0 && i % yieldEvery === 0) await new Promise(r => setTimeout(r, 0))

    const b = i * 6
    const wx = D[b]
    const wy = D[b + 1]
    const wz = D[b + 2]
    const plane = classifyPlaneNormal(wx, wy, wz, roomFrame)
    if (!plane || plane.confidence < 0.2) continue
    const key = planeCellKey(plane)
    if (!key) continue

    let cellScores = scoresByCell.get(key)
    if (!cellScores) {
      cellScores = new Float32Array(S)
      scoresByCell.set(key, cellScores)
      driftSumByCell.set(key, new Float32Array(S))
      driftWeightByCell.set(key, new Float32Array(S))
    }
    const cellDriftSums = driftSumByCell.get(key)
    const cellDriftWeights = driftWeightByCell.get(key)
    const baseR = D[b + 3]
    const baseG = D[b + 4]
    const baseB = D[b + 5]

    for (let si = 0; si < S; si++) {
      const proj = projectToSnapshot(wx, wy, wz, views[si], intrs[si])
      if (!proj) continue
      const center = edgeCentralityWeight(intrs[si], proj.u, proj.v)
      if (center.weight <= 0) continue

      const atlas = atlases[si]
      const ax = Math.min(atlas.width - 1, Math.max(0, proj.u * atlas.invW | 0))
      const ay = Math.min(atlas.height - 1, Math.max(0, proj.v * atlas.invH | 0))
      const depthRef = atlas.depth[ay * atlas.width + ax]
      if (!isDepthVisible(proj.depth, depthRef, STRICT_VISIBILITY_REL_TOL, STRICT_VISIBILITY_ABS_TOL)) continue

      const depthResidual = Math.max(0, proj.depth - depthRef)
      if (depthResidual > MAX_DEPTH_RESIDUAL_REJECT) continue

      const px = pixMaps?.[si]
      if (!px) continue
      const sampled = bilinearSampleRGBA(px.data, px.width, px.height, proj.u, proj.v)
      const drift = colorDriftL1ToBase(sampled, baseR, baseG, baseB)
      const driftPenalty = Math.exp(-PLANE_PREF_COLOR_DRIFT_WEIGHT * drift)

      // Build a stable dominant-view map in plane-local cells.
      const contrib = proj.score * center.weight * (1 / (1 + 6 * depthResidual)) * driftPenalty
      cellScores[si] += contrib
      cellDriftSums[si] += drift * contrib
      cellDriftWeights[si] += contrib
      const pidx = Math.max(0, Math.min(5, plane.planeIndex | 0))
      planeGlobalScores[pidx][si] += contrib
      planeGlobalDriftSums[pidx][si] += drift * contrib
      planeGlobalDriftWeights[pidx][si] += contrib
    }
  }

  const preferredByCell = new Map()
  for (const [key, scores] of scoresByCell.entries()) {
    const cellDriftSums = driftSumByCell.get(key)
    const cellDriftWeights = driftWeightByCell.get(key)
    let bestSi = -1
    let bestScore = 0
    let secondScore = 0
    for (let si = 0; si < scores.length; si++) {
      const s = scores[si]
      if (s > bestScore) {
        secondScore = bestScore
        bestScore = s
        bestSi = si
      } else if (s > secondScore) {
        secondScore = s
      }
    }
    const bestMeanDrift = (bestSi >= 0 && cellDriftWeights[bestSi] > 0)
      ? (cellDriftSums[bestSi] / cellDriftWeights[bestSi])
      : Infinity
    if (
      bestSi >= 0 &&
      bestScore > 0 &&
      bestScore >= secondScore * PLANE_PREF_DOMINANCE_RATIO &&
      bestMeanDrift <= PLANE_PREF_MAX_MEAN_DRIFT
    ) {
      preferredByCell.set(key, bestSi)
    }
  }

  const preferredByPlane = new Int16Array(6).fill(-1)
  for (let pidx = 0; pidx < 6; pidx++) {
    const scores = planeGlobalScores[pidx]
    const driftSums = planeGlobalDriftSums[pidx]
    const driftWeights = planeGlobalDriftWeights[pidx]
    let bestSi = -1
    let bestScore = 0
    let secondScore = 0
    for (let si = 0; si < scores.length; si++) {
      const s = scores[si]
      if (s > bestScore) {
        secondScore = bestScore
        bestScore = s
        bestSi = si
      } else if (s > secondScore) {
        secondScore = s
      }
    }
    const bestMeanDrift = (bestSi >= 0 && driftWeights[bestSi] > 0)
      ? (driftSums[bestSi] / driftWeights[bestSi])
      : Infinity
    if (
      bestSi >= 0 &&
      bestScore > 0 &&
      bestScore >= secondScore * PLANE_PREF_DOMINANCE_RATIO &&
      bestMeanDrift <= PLANE_PREF_MAX_MEAN_DRIFT
    ) {
      preferredByPlane[pidx] = bestSi
    }
  }

  let preferredPlanes = 0
  for (let pidx = 0; pidx < preferredByPlane.length; pidx++) {
    if (preferredByPlane[pidx] >= 0) preferredPlanes++
  }

  return {
    preferredByCell,
    preferredByPlane,
    sampledCells: scoresByCell.size,
    preferredCells: preferredByCell.size,
    preferredPlanes,
  }
}

async function estimateSnapshotReliability(buf, views, intrs, atlases, {
  maxSamples = SNAPSHOT_RELIABILITY_MAX_SAMPLES,
  yieldEvery = 120_000,
} = {}) {
  const n = buf.pointCount
  const D = buf._data
  const S = views.length
  const stride = Math.max(1, Math.ceil(n / Math.max(1, maxSamples)))
  const support = new Float32Array(S)
  const residualSum = new Float32Array(S)

  for (let i = 0; i < n; i += stride) {
    if (i > 0 && i % yieldEvery === 0) await new Promise(r => setTimeout(r, 0))
    const b = i * 6
    const wx = D[b]
    const wy = D[b + 1]
    const wz = D[b + 2]

    for (let si = 0; si < S; si++) {
      const proj = projectToSnapshot(wx, wy, wz, views[si], intrs[si])
      if (!proj) continue
      const center = edgeCentralityWeight(intrs[si], proj.u, proj.v)
      if (center.weight <= 0) continue
      const atlas = atlases[si]
      const ax = Math.min(atlas.width - 1, Math.max(0, proj.u * atlas.invW | 0))
      const ay = Math.min(atlas.height - 1, Math.max(0, proj.v * atlas.invH | 0))
      const depthRef = atlas.depth[ay * atlas.width + ax]
      if (!isDepthVisible(proj.depth, depthRef, STRICT_VISIBILITY_REL_TOL, STRICT_VISIBILITY_ABS_TOL)) continue
      const residual = Math.max(0, proj.depth - depthRef)
      if (residual > MAX_DEPTH_RESIDUAL_REJECT) continue

      support[si] += center.weight
      residualSum[si] += residual
    }
  }

  const reliability = new Float32Array(S)
  let maxSupport = 0
  for (let si = 0; si < S; si++) {
    if (support[si] > maxSupport) maxSupport = support[si]
  }
  const supportDenom = Math.max(1e-6, maxSupport)
  for (let si = 0; si < S; si++) {
    const meanResidual = residualSum[si] / Math.max(1e-6, support[si])
    const supportNorm = support[si] / supportDenom
    const residualQuality = Math.exp(-SNAPSHOT_RELIABILITY_RESIDUAL_SCALE * meanResidual)
    reliability[si] = Math.max(0, Math.min(1, supportNorm * residualQuality))
  }
  return reliability
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

function getVisibilityAtlasSize(width, height, maxDim = VISIBILITY_MAX_DIM) {
  const longest = Math.max(width, height)
  const scale = longest > maxDim ? (maxDim / longest) : 1
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function computeQuantile(values, q) {
  if (!values?.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q)))
  return sorted[idx]
}

function localAtlasDepthSpread(atlas, ax, ay) {
  let dMin = Infinity
  let dMax = -Infinity
  for (let dy = -1; dy <= 1; dy++) {
    const y = Math.max(0, Math.min(atlas.height - 1, ay + dy))
    for (let dx = -1; dx <= 1; dx++) {
      const x = Math.max(0, Math.min(atlas.width - 1, ax + dx))
      const d = atlas.depth[y * atlas.width + x]
      if (!Number.isFinite(d) || d === Infinity) continue
      if (d < dMin) dMin = d
      if (d > dMax) dMax = d
    }
  }
  if (!Number.isFinite(dMin) || !Number.isFinite(dMax)) return 0
  return Math.max(0, dMax - dMin)
}

function buildAutoTunePolicy(snapshotReliability, planePreference) {
  const reliabilities = Array.from(snapshotReliability || [])
  const p20 = computeQuantile(reliabilities, 0.2)
  const p35 = computeQuantile(reliabilities, 0.35)
  const p55 = computeQuantile(reliabilities, 0.55)
  const coverage = planePreference.sampledCells > 0
    ? (planePreference.preferredCells / planePreference.sampledCells)
    : 0

  // Outer optimizer tunes inner projection gates based on scan-specific signal quality.
  const reliabilityMin = Math.max(0.22, Math.min(0.5, Math.max(0.24, p20 * 0.88, p35 * 0.84)))
  const minPlaneConfidence = Math.max(0.28, Math.min(0.52, 0.44 - coverage * 0.12))
  const maxEnvelopeDistance = Math.max(0.34, Math.min(0.72, 0.42 + 0.32 * coverage))
  const depthEdgeGuard = Math.max(0.045, Math.min(0.075, DEPTH_EDGE_GUARD_DEFAULT_M + 0.02 - coverage * 0.01))
  const ambiguityRatioBase = coverage >= 0.5 ? 0.8 : 0.86

  return {
    reliabilityMin,
    minPlaneConfidence,
    maxEnvelopeDistance,
    depthEdgeGuard,
    ambiguityRatioBase,
    reliabilityP35: p35,
    reliabilityP55: p55,
    planeCoverage: coverage,
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

function colorDriftL1ToBase(sampled, baseR, baseG, baseB) {
  return (
    Math.abs(sampled[0] - baseR) +
    Math.abs(sampled[1] - baseG) +
    Math.abs(sampled[2] - baseB)
  )
}

function rad(deg) {
  return deg * (Math.PI / 180)
}

function applyViewRotationDelta(view, yawRad, pitchRad, rollRad) {
  const cy = Math.cos(yawRad), sy = Math.sin(yawRad)
  const cp = Math.cos(pitchRad), sp = Math.sin(pitchRad)
  const cr = Math.cos(rollRad), sr = Math.sin(rollRad)

  // Camera-space delta rotation: Rz * Rx * Ry
  const rd00 = cr * cy - sr * sp * sy
  const rd01 = -sr * cp
  const rd02 = cr * sy + sr * sp * cy
  const rd10 = sr * cy + cr * sp * sy
  const rd11 = cr * cp
  const rd12 = sr * sy - cr * sp * cy
  const rd20 = -cp * sy
  const rd21 = sp
  const rd22 = cp * cy

  const out = new Float32Array(view)

  // Extract current row-major R from column-major 4x4 view matrix
  const r00 = view[0], r01 = view[4], r02 = view[8]
  const r10 = view[1], r11 = view[5], r12 = view[9]
  const r20 = view[2], r21 = view[6], r22 = view[10]

  // R' = Rd * R
  const n00 = rd00 * r00 + rd01 * r10 + rd02 * r20
  const n01 = rd00 * r01 + rd01 * r11 + rd02 * r21
  const n02 = rd00 * r02 + rd01 * r12 + rd02 * r22
  const n10 = rd10 * r00 + rd11 * r10 + rd12 * r20
  const n11 = rd10 * r01 + rd11 * r11 + rd12 * r21
  const n12 = rd10 * r02 + rd11 * r12 + rd12 * r22
  const n20 = rd20 * r00 + rd21 * r10 + rd22 * r20
  const n21 = rd20 * r01 + rd21 * r11 + rd22 * r21
  const n22 = rd20 * r02 + rd21 * r12 + rd22 * r22

  out[0] = n00; out[4] = n01; out[8] = n02
  out[1] = n10; out[5] = n11; out[9] = n12
  out[2] = n20; out[6] = n21; out[10] = n22

  // t' = Rd * t
  const tx = view[12], ty = view[13], tz = view[14]
  out[12] = rd00 * tx + rd01 * ty + rd02 * tz
  out[13] = rd10 * tx + rd11 * ty + rd12 * tz
  out[14] = rd20 * tx + rd21 * ty + rd22 * tz

  return out
}

function evaluateViewAlignmentMetric(buf, view, intr, pixMap, {
  maxSamples = POSE_REFINE_MAX_SAMPLES,
} = {}) {
  const n = buf.pointCount
  const D = buf._data
  const stride = Math.max(1, Math.ceil(n / Math.max(1, maxSamples)))
  let total = 0
  let support = 0

  for (let i = 0; i < n; i += stride) {
    const b = i * 6
    const wx = D[b]
    const wy = D[b + 1]
    const wz = D[b + 2]
    const proj = projectToSnapshot(wx, wy, wz, view, intr)
    if (!proj) continue

    const center = edgeCentralityWeight(intr, proj.u, proj.v)
    if (center.weight <= 0) continue

    const color = bilinearSampleRGBA(pixMap.data, pixMap.width, pixMap.height, proj.u, proj.v)
    const drift = colorDriftL1ToBase(color, D[b + 3], D[b + 4], D[b + 5])
    const quality = Math.exp(-2.2 * drift)
    total += proj.score * center.weight * quality
    support += 1
  }

  return support > 0 ? (total / support) : 0
}

function refineSnapshotViewsByPoseSearch(buf, views, intrs, pixMaps) {
  const refined = views.map(v => new Float32Array(v))
  let refinedCount = 0
  let totalShiftDeg = 0

  for (let si = 0; si < refined.length; si++) {
    let bestView = refined[si]
    let bestMetric = evaluateViewAlignmentMetric(buf, bestView, intrs[si], pixMaps[si])
    let bestYaw = 0
    let bestPitch = 0

    const coarse = [0, -POSE_REFINE_DEG_COARSE, POSE_REFINE_DEG_COARSE]
    for (const yd of coarse) {
      for (const pd of coarse) {
        if (yd === 0 && pd === 0) continue
        const cand = applyViewRotationDelta(refined[si], rad(yd), rad(pd), 0)
        const m = evaluateViewAlignmentMetric(buf, cand, intrs[si], pixMaps[si])
        if (m > bestMetric) {
          bestMetric = m
          bestView = cand
          bestYaw = yd
          bestPitch = pd
        }
      }
    }

    const fine = [0, -POSE_REFINE_DEG_FINE, POSE_REFINE_DEG_FINE]
    const baseForFine = bestView
    let fineYaw = 0
    let finePitch = 0
    for (const yd of fine) {
      for (const pd of fine) {
        if (yd === 0 && pd === 0) continue
        const cand = applyViewRotationDelta(baseForFine, rad(yd), rad(pd), 0)
        const m = evaluateViewAlignmentMetric(buf, cand, intrs[si], pixMaps[si])
        if (m > bestMetric) {
          bestMetric = m
          bestView = cand
          fineYaw = yd
          finePitch = pd
        }
      }
    }

    const shiftDeg = Math.hypot(bestYaw + fineYaw, bestPitch + finePitch)
    if (shiftDeg > 0.05) {
      refinedCount++
      totalShiftDeg += shiftDeg
    }
    refined[si] = bestView
  }

  return {
    views: refined,
    refinedCount,
    avgShiftDeg: refinedCount > 0 ? (totalShiftDeg / refinedCount) : 0,
  }
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
 * Apply bilateral filtering to refine depth maps and improve alignment.
 * This function smooths depth data while preserving edges.
 */
function applyBilateralFilter(depthMap, width, height, sigmaSpatial, sigmaRange) {
  const filteredDepthMap = new Float32Array(depthMap.length);
  const kernelSize = Math.ceil(2 * sigmaSpatial);
  const gaussian = (x, sigma) => Math.exp(-(x * x) / (2 * sigma * sigma));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sumWeights = 0;
      let sumDepth = 0;
      const centerDepth = depthMap[y * width + x];

      for (let ky = -kernelSize; ky <= kernelSize; ky++) {
        for (let kx = -kernelSize; kx <= kernelSize; kx++) {
          const nx = x + kx;
          const ny = y + ky;

          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const neighborDepth = depthMap[ny * width + nx];
            const spatialWeight = gaussian(Math.sqrt(kx * kx + ky * ky), sigmaSpatial);
            const rangeWeight = gaussian(Math.abs(neighborDepth - centerDepth), sigmaRange);
            const weight = spatialWeight * rangeWeight;

            sumWeights += weight;
            sumDepth += neighborDepth * weight;
          }
        }
      }

      filteredDepthMap[y * width + x] = sumDepth / sumWeights;
    }
  }

  return filteredDepthMap;
}

/**
 * Fill gaps in the point cloud using a basic inpainting algorithm.
 */
function fillPointCloudGaps(pointCloud, width, height) {
  const filledPointCloud = new Float32Array(pointCloud.length);

  for (let i = 0; i < pointCloud.length; i++) {
    if (pointCloud[i] === 0) {
      // Simple nearest-neighbor interpolation for gap filling
      let sum = 0;
      let count = 0;

      for (let offset = -1; offset <= 1; offset++) {
        const neighborIndex = i + offset;
        if (neighborIndex >= 0 && neighborIndex < pointCloud.length && pointCloud[neighborIndex] !== 0) {
          sum += pointCloud[neighborIndex];
          count++;
        }
      }

      filledPointCloud[i] = count > 0 ? sum / count : 0;
    } else {
      filledPointCloud[i] = pointCloud[i];
    }
  }

  return filledPointCloud;
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
  const YIELD_EVERY = 200_000               // yield to browser every 200 K pts

  // ── Precompute per-snapshot data ──────────────────────────────────────────
  // views[si]  = column-major 4×4 world→camera matrix (inverse of cam→world)
  // intrs[si]  = [fx, fy, cx, cy, imgW, imgH]
  let views = snapshots.map(s => invertRigid(s.transform))
  const intrs = snapshots.map((s, index) => normalizeIntrinsicsForImage(s.intrinsics, pixMaps[index].width, pixMaps[index].height))
  const poseRefine = refineSnapshotViewsByPoseSearch(buf, views, intrs, pixMaps)
  views = poseRefine.views
  const camPositions = views.map(v => {
    const t = invertRigid(v)
    return [t[12], t[13], t[14]]
  })
  const atlases = await buildVisibilityAtlases(buf, views, intrs)
  const roomFrame = estimateRoomFrame(buf)
  const planePreference = await buildPlaneCellSnapshotPreference(buf, views, intrs, atlases, roomFrame, pixMaps)
  const preferredSnapshotByPlaneCell = planePreference.preferredByCell
  const preferredSnapshotByPlane = planePreference.preferredByPlane
  const snapshotReliability = await estimateSnapshotReliability(buf, views, intrs, atlases)
  const autoTunePolicy = buildAutoTunePolicy(snapshotReliability, planePreference)

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
    depthResidualRejected: 0,
    planeCellPenaltyApplied: 0,
    planeCellSampled: planePreference.sampledCells,
    planeCellPreferred: planePreference.preferredCells,
    planePreferredGlobal: planePreference.preferredPlanes,
    hardPlaneCellBlocked: 0,
    unreliableSnapshotRejected: 0,
    geometryGuardedFallback: 0,
    depthEdgeRejected: 0,
    autoReliabilityMin: autoTunePolicy.reliabilityMin,
    autoPlaneMinConfidence: autoTunePolicy.minPlaneConfidence,
    autoMaxEnvelopeDistance: autoTunePolicy.maxEnvelopeDistance,
    autoDepthEdgeGuard: autoTunePolicy.depthEdgeGuard,
    autoPlaneCoverage: autoTunePolicy.planeCoverage,
    poseRefinedSnapshots: poseRefine.refinedCount,
    poseAvgShiftDeg: poseRefine.avgShiftDeg,
    relaxedRecoveryAccepted: 0,
    relaxedRecoveryFallback: 0,
    colorDriftRejected: 0,
  } : null

  // Per-point single-view assignment with ambiguity rejection.
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % YIELD_EVERY === 0) {
      await new Promise(r => setTimeout(r, 0))
    }

    const b  = i * 6
    const wx = D[b],  wy = D[b+1], wz = D[b+2]   // original world coords (no yOffset)
    const or = D[b+3], og = D[b+4], ob = D[b+5]   // depth-sensor fallback colour
    const plane = classifyPlaneNormal(wx, wy, wz, roomFrame)

    const geometryEligibleStrict = !!(
      plane &&
      plane.confidence >= autoTunePolicy.minPlaneConfidence &&
      plane.bestDistance <= autoTunePolicy.maxEnvelopeDistance
    )
    const relaxedMinPlaneConfidence = autoTunePolicy.minPlaneConfidence * RELAXED_RECOVERY_CONFIDENCE_FACTOR
    const relaxedMaxEnvelopeDistance = autoTunePolicy.maxEnvelopeDistance + RELAXED_RECOVERY_ENVELOPE_EXPAND_M
    const geometryEligibleRelaxed = !!(
      plane &&
      plane.confidence >= relaxedMinPlaneConfidence &&
      plane.bestDistance <= relaxedMaxEnvelopeDistance
    )
    const useRelaxedRecovery = !geometryEligibleStrict && geometryEligibleRelaxed
    if (!geometryEligibleStrict && !useRelaxedRecovery) {
      newColors[i*3] = or
      newColors[i*3+1] = og
      newColors[i*3+2] = ob
      if (stats) {
        stats.fallback++
        stats.geometryGuardedFallback++
      }
      continue
    }

    const reliabilityMinGate = useRelaxedRecovery
      ? Math.max(0.16, autoTunePolicy.reliabilityMin * RELAXED_RECOVERY_RELIABILITY_FACTOR)
      : autoTunePolicy.reliabilityMin
    const depthEdgeGuardGate = useRelaxedRecovery
      ? (autoTunePolicy.depthEdgeGuard + RELAXED_RECOVERY_DEPTH_EDGE_EXPAND_M)
      : autoTunePolicy.depthEdgeGuard
    const scoreMinGate = useRelaxedRecovery
      ? (MIN_PROJECTION_SCORE * RELAXED_RECOVERY_SCORE_FACTOR)
      : MIN_PROJECTION_SCORE

    let best = null
    let second = null
    const ranked = []
    let preferredSiForPoint = null
    if (plane) {
      const planeIdx = Math.max(0, Math.min(5, plane.planeIndex | 0))
      const planeGlobal = preferredSnapshotByPlane[planeIdx]
      if (planeGlobal !== undefined && planeGlobal !== null && planeGlobal >= 0) {
        preferredSiForPoint = planeGlobal
      } else {
        preferredSiForPoint = preferredSnapshotByPlaneCell.get(planeCellKey(plane))
      }
    }

    for (let si = 0; si < S; si++) {
      if (snapshotReliability[si] < reliabilityMinGate) {
        if (stats) stats.unreliableSnapshotRejected++
        continue
      }
      if (PLANE_PREF_HARD_GATING && preferredSiForPoint !== undefined && preferredSiForPoint !== null && si !== preferredSiForPoint) {
        if (stats) stats.hardPlaneCellBlocked++
        continue
      }
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
      const depthSpread = localAtlasDepthSpread(atlas, ax, ay)
      if (depthSpread > depthEdgeGuardGate) {
        if (stats) stats.depthEdgeRejected++
        continue
      }
      const idx = ay * atlas.width + ax
      const depthRef = atlas.depth[idx]
      if (!isDepthVisible(proj.depth, depthRef, STRICT_VISIBILITY_REL_TOL, STRICT_VISIBILITY_ABS_TOL)) {
        if (stats) stats.depthRejected++
        continue
      }

      const depthResidual = Math.max(0, proj.depth - depthRef)
      if (depthResidual > MAX_DEPTH_RESIDUAL_REJECT) {
        if (stats) stats.depthResidualRejected++
        continue
      }
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
      if (planeHardRejected) {
        if (stats) stats.planeRejected++
        if (STRICT_PLANE_REJECTION) continue
      }
      const facingSoft = plane
        ? Math.max(0.25, 0.48 + 0.52 * planeFacing)
        : 1
      const depthResidualWeight = 1 / (1 + 4.5 * depthResidual)
      const planeWeight = plane
        ? (0.82 + 0.18 * plane.confidence) * facingSoft * (1 + 0.14 * cornerStrength)
        : 1
      const structureWeight = structureWeightFromDistance(plane?.bestDistance)
      let weightedScore = proj.score * center.weight * planeWeight * structureWeight * depthResidualWeight
      weightedScore *= Math.max(0.25, snapshotReliability[si])
      if (plane) {
        const cellKey = planeCellKey(plane)
        const preferredSi = cellKey ? preferredSnapshotByPlaneCell.get(cellKey) : null
        if (preferredSi !== undefined && preferredSi !== null) {
          if (preferredSi === si) {
            weightedScore *= PLANE_PREF_MATCH_BONUS
          } else {
            weightedScore *= PLANE_PREF_MISMATCH_PENALTY
            if (stats) stats.planeCellPenaltyApplied++
          }
        }
      }
      if (stats && structureWeight < 0.9) stats.structureDownWeighted++

      if (weightedScore < scoreMinGate) {
        if (stats) stats.scoreRejected++
        continue
      }

      const px = pixMaps[si]
      const color = bilinearSampleRGBA(px.data, px.width, px.height, proj.u, proj.v)
      const maxColorDrift = COLOR_DRIFT_BASE_L1 + (1 - snapshotReliability[si]) * 0.24 + (useRelaxedRecovery ? COLOR_DRIFT_RELAXED_BONUS : 0)
      if (colorDriftL1ToBase(color, or, og, ob) > maxColorDrift) {
        if (stats) stats.colorDriftRejected++
        continue
      }
      const candidate = { si, score: weightedScore, depthResidual, proj, color }
      insertTopByScore(ranked, candidate)

      if (!best || candidate.score > best.score || (Math.abs(candidate.score - best.score) < 1e-9 && candidate.depthResidual < best.depthResidual)) {
        second = best
        best = candidate
      } else if (!second || candidate.score > second.score || (Math.abs(candidate.score - second.score) < 1e-9 && candidate.depthResidual < second.depthResidual)) {
        second = candidate
      }
    }

    if (best) {
      const bestConsensus = consensusSupport(best, ranked)
      const bestConsensusRel = bestConsensus / (best.score + 1e-6)
      // If two views are similarly plausible but disagree in colour, projection is ambiguous.
      // Keep fallback colour here to avoid duplicate/ghost overlays.
      if (second) {
        const secondConsensus = consensusSupport(second, ranked)
        const ratio = second.score / (best.score + 1e-6)
        const ratioGate = Math.max(autoTunePolicy.ambiguityRatioBase, AMBIGUITY_SCORE_RATIO - Math.min(0.08, bestConsensusRel * 0.02))
        const disagreement =
          Math.abs(best.color[0] - second.color[0]) +
          Math.abs(best.color[1] - second.color[1]) +
          Math.abs(best.color[2] - second.color[2])
        const consensusDelta = (bestConsensus - secondConsensus) / (best.score + second.score + 1e-6)
        const canRelieveByConsensus = consensusDelta >= (CONSENSUS_AMBIGUITY_RELIEF + 0.2)
        if (ratio >= ratioGate && disagreement >= AMBIGUITY_COLOR_L1 && !canRelieveByConsensus) {
          newColors[i*3] = or
          newColors[i*3+1] = og
          newColors[i*3+2] = ob
          if (stats) {
            stats.ambiguousRejected++
            stats.fallback++
          }
          continue
        }
      }

      newColors[i*3] = best.color[0]
      newColors[i*3+1] = best.color[1]
      newColors[i*3+2] = best.color[2]
      if (stats) {
        stats.accepted++
        stats.singleView++
        if (useRelaxedRecovery) stats.relaxedRecoveryAccepted++
      }
    } else {
      newColors[i*3] = or
      newColors[i*3+1] = og
      newColors[i*3+2] = ob
      if (stats) {
        stats.fallback++
        if (useRelaxedRecovery) stats.relaxedRecoveryFallback++
      }
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
      depthResidualRejected: stats.depthResidualRejected,
      planeCellPenaltyApplied: stats.planeCellPenaltyApplied,
      planeCellSampled: stats.planeCellSampled,
      planeCellPreferred: stats.planeCellPreferred,
      planePreferredGlobal: stats.planePreferredGlobal,
      hardPlaneCellBlocked: stats.hardPlaneCellBlocked,
      unreliableSnapshotRejected: stats.unreliableSnapshotRejected,
      geometryGuardedFallback: stats.geometryGuardedFallback,
      depthEdgeRejected: stats.depthEdgeRejected,
      autoReliabilityMin: stats.autoReliabilityMin,
      autoPlaneMinConfidence: stats.autoPlaneMinConfidence,
      autoMaxEnvelopeDistance: stats.autoMaxEnvelopeDistance,
      autoDepthEdgeGuard: stats.autoDepthEdgeGuard,
      autoPlaneCoverage: stats.autoPlaneCoverage,
      poseRefinedSnapshots: stats.poseRefinedSnapshots,
      poseAvgShiftDeg: stats.poseAvgShiftDeg,
      relaxedRecoveryAccepted: stats.relaxedRecoveryAccepted,
      relaxedRecoveryFallback: stats.relaxedRecoveryFallback,
      colorDriftRejected: stats.colorDriftRejected,
    })
  }

  return newColors
}

/**
 * Utilize WebGL for GPU-accelerated photo projection.
 */
function projectPhotoWithGPU(pointCloud, snapshots) {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl');

  if (!gl) {
    console.error('WebGL not supported');
    return;
  }

  // Initialize WebGL shaders and buffers
  const vertexShaderSource = `
    attribute vec3 aPosition;
    attribute vec2 aTexCoord;
    varying vec2 vTexCoord;

    void main() {
      gl_Position = vec4(aPosition, 1.0);
      vTexCoord = aTexCoord;
    }
  `;

  const fragmentShaderSource = `
    precision mediump float;
    varying vec2 vTexCoord;
    uniform sampler2D uTexture;

    void main() {
      gl_FragColor = texture2D(uTexture, vTexCoord);
    }
  `;

  const vertexShader = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vertexShader, vertexShaderSource);
  gl.compileShader(vertexShader);

  const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fragmentShader, fragmentShaderSource);
  gl.compileShader(fragmentShader);

  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Could not initialize shaders');
    return;
  }

  gl.useProgram(program);

  // Create buffers and upload point cloud data
  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pointCloud), gl.STATIC_DRAW);

  // Set up texture sampling
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, snapshots[0].image);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  // Render the point cloud with photo projection
  gl.drawArrays(gl.POINTS, 0, pointCloud.length / 3);

  // Retrieve the rendered image
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  return pixels;
}

// Integrate this function into the main photo projection pipeline.
// Example usage:
// const gpuRenderedImage = projectPhotoWithGPU(pointCloud, snapshots);
