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
const FUSION_MAX_CANDIDATES = 1
const COLOR_GATE_L1 = 0.33
const MIN_PROJECTION_SCORE = 0.2
const VIEW_EDGE_SIGMA = 0.85
const VIEW_EDGE_HARD_RADIUS2 = 2.2
const AMBIGUITY_SCORE_RATIO = 0.92
const AMBIGUITY_COLOR_L1 = 0.26

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
  const YIELD_EVERY = 200_000               // yield to browser every 200 K pts

  // ── Precompute per-snapshot data ──────────────────────────────────────────
  // views[si]  = column-major 4×4 world→camera matrix (inverse of cam→world)
  // intrs[si]  = [fx, fy, cx, cy, imgW, imgH]
  const views = snapshots.map(s => invertRigid(s.transform))
  const intrs = snapshots.map((s, index) => normalizeIntrinsicsForImage(s.intrinsics, pixMaps[index].width, pixMaps[index].height))
  const atlases = await buildVisibilityAtlases(buf, views, intrs)

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
  } : null

  // Per-point single-view assignment with ambiguity rejection.
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % YIELD_EVERY === 0) {
      await new Promise(r => setTimeout(r, 0))
    }

    const b  = i * 6
    const wx = D[b],  wy = D[b+1], wz = D[b+2]   // original world coords (no yOffset)
    const or = D[b+3], og = D[b+4], ob = D[b+5]   // depth-sensor fallback colour

    let best = null
    let second = null

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
      const weightedScore = proj.score * center.weight

      if (weightedScore < MIN_PROJECTION_SCORE) {
        if (stats) stats.scoreRejected++
        continue
      }

      const px = pixMaps[si]
      const color = bilinearSampleRGBA(px.data, px.width, px.height, proj.u, proj.v)
      const candidate = { si, score: weightedScore, depthResidual, proj, color }

      if (!best || candidate.score > best.score || (Math.abs(candidate.score - best.score) < 1e-9 && candidate.depthResidual < best.depthResidual)) {
        second = best
        best = candidate
      } else if (!second || candidate.score > second.score || (Math.abs(candidate.score - second.score) < 1e-9 && candidate.depthResidual < second.depthResidual)) {
        second = candidate
      }
    }

    if (best) {
      // If two views are similarly plausible but disagree in colour, projection is ambiguous.
      // Keep fallback colour here to avoid duplicate/ghost overlays.
      if (second) {
        const ratio = second.score / (best.score + 1e-6)
        const disagreement =
          Math.abs(best.color[0] - second.color[0]) +
          Math.abs(best.color[1] - second.color[1]) +
          Math.abs(best.color[2] - second.color[2])
        if (ratio >= AMBIGUITY_SCORE_RATIO && disagreement >= AMBIGUITY_COLOR_L1) {
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
      }
    } else {
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
    })
  }

  return newColors
}
