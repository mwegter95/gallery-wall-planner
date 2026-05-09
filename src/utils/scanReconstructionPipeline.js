import { buildPhotoColorsForPositions } from './photoMesh'

const EPSILON = 1e-6

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function length(vector) {
  return Math.hypot(vector[0], vector[1], vector[2])
}

function normalize(vector) {
  const magnitude = length(vector)
  if (magnitude < EPSILON) return [0, 0, 0]
  return [vector[0] / magnitude, vector[1] / magnitude, vector[2] / magnitude]
}

function quantize(value, step) {
  return Math.round(value / step)
}

export function classifySurfaceNormal(normal, horizontalThreshold = 0.85) {
  const unit = normalize(normal)
  if (Math.abs(unit[1]) >= horizontalThreshold) return unit[1] >= 0 ? 'floor' : 'ceiling'
  if (Math.hypot(unit[0], unit[2]) >= 0.5) return 'wall'
  return 'other'
}

export function computeUvBasis(normal) {
  const unit = normalize(normal)
  const up = Math.abs(unit[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const tangent = normalize(cross(up, unit))
  const bitangent = normalize(cross(unit, tangent))
  return { tangent, bitangent }
}

function pointFromRoomFrame(frame, u, v, y) {
  return [
    frame.origin[0] + frame.axisU[0] * u + frame.axisV[0] * v,
    y,
    frame.origin[2] + frame.axisU[2] * u + frame.axisV[2] * v,
  ]
}

function pushQuad(out, segmentId, classification, normal, corners, colors) {
  const positions = new Float32Array([
    ...corners[0],
    ...corners[1],
    ...corners[2],
    ...corners[3],
  ])
  const indices = Uint32Array.from([0, 1, 2, 0, 2, 3])
  const colorArray = new Float32Array([
    ...colors[0],
    ...colors[1],
    ...colors[2],
    ...colors[3],
  ])
  out.push({
    id: segmentId,
    classification,
    normal,
    positions,
    colors: colorArray,
    indices,
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  })
}

function computeRoomFrame(buf) {
  const D = buf._data
  const n = buf.pointCount
  const INF = Infinity
  let minY = INF, maxY = -INF
  let minX = INF, maxX = -INF
  let minZ = INF, maxZ = -INF
  let sumX = 0, sumZ = 0, sumXX = 0, sumXZ = 0, sumZZ = 0

  for (let i = 0, b = 0; i < n; i++, b += 6) {
    const x = D[b]
    const y = D[b + 1]
    const z = D[b + 2]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
    sumX += x; sumZ += z
    sumXX += x * x; sumXZ += x * z; sumZZ += z * z
  }

  const meanX = n > 0 ? sumX / n : 0
  const meanZ = n > 0 ? sumZ / n : 0
  const covXX = n > 0 ? sumXX / n - meanX * meanX : 1
  const covXZ = n > 0 ? sumXZ / n - meanX * meanZ : 0
  const covZZ = n > 0 ? sumZZ / n - meanZ * meanZ : 1

  const angle = 0.5 * Math.atan2(2 * covXZ, covXX - covZZ)
  let axisU = [Math.cos(angle), 0, Math.sin(angle)]
  let axisV = [-Math.sin(angle), 0, Math.cos(angle)]
  if (axisU[0] < 0) {
    axisU = [-axisU[0], 0, -axisU[2]]
    axisV = [-axisV[0], 0, -axisV[2]]
  }

  const origin = [meanX, 0, meanZ]
  const frame = { origin, axisU, axisV }

  let uMin = INF, uMax = -INF, vMin = INF, vMax = -INF
  let floorMinY = INF, floorMaxY = -INF, ceilMinY = INF, ceilMaxY = -INF
  let wallUMinVMin = INF, wallUMinVMax = -INF, wallUMinYMin = INF, wallUMinYMax = -INF
  let wallUMaxVMin = INF, wallUMaxVMax = -INF, wallUMaxYMin = INF, wallUMaxYMax = -INF
  let wallVMinUMin = INF, wallVMinUMax = -INF, wallVMinYMin = INF, wallVMinYMax = -INF
  let wallVMaxUMin = INF, wallVMaxUMax = -INF, wallVMaxYMin = INF, wallVMaxYMax = -INF

  for (let i = 0, b = 0; i < n; i++, b += 6) {
    const x = D[b]
    const y = D[b + 1]
    const z = D[b + 2]
    const dx = x - meanX
    const dz = z - meanZ
    const u = dx * axisU[0] + dz * axisU[2]
    const v = dx * axisV[0] + dz * axisV[2]
    if (u < uMin) uMin = u
    if (u > uMax) uMax = u
    if (v < vMin) vMin = v
    if (v > vMax) vMax = v
  }

  const yOffset = Number.isFinite(minY) ? -minY : 0
  const displayMinY = minY + yOffset
  const displayMaxY = maxY + yOffset
  const yBand = Math.max(0.05, (displayMaxY - displayMinY) * 0.08)
  const uvBand = Math.max(0.05, Math.max(uMax - uMin, vMax - vMin) * 0.08)

  for (let i = 0, b = 0; i < n; i++, b += 6) {
    const x = D[b]
    const y = D[b + 1] + yOffset
    const z = D[b + 2]
    const r = D[b + 3]
    const g = D[b + 4]
    const blue = D[b + 5]
    const dx = x - meanX
    const dz = z - meanZ
    const u = dx * axisU[0] + dz * axisU[2]
    const v = dx * axisV[0] + dz * axisV[2]

    if (Math.abs(y - displayMinY) <= yBand) {
      if (y < floorMinY) floorMinY = y
      if (y > floorMaxY) floorMaxY = y
    }
    if (Math.abs(y - displayMaxY) <= yBand) {
      if (y < ceilMinY) ceilMinY = y
      if (y > ceilMaxY) ceilMaxY = y
    }

    if (Math.abs(u - uMin) <= uvBand) {
      if (v < wallUMinVMin) wallUMinVMin = v
      if (v > wallUMinVMax) wallUMinVMax = v
      if (y < wallUMinYMin) wallUMinYMin = y
      if (y > wallUMinYMax) wallUMinYMax = y
    }
    if (Math.abs(u - uMax) <= uvBand) {
      if (v < wallUMaxVMin) wallUMaxVMin = v
      if (v > wallUMaxVMax) wallUMaxVMax = v
      if (y < wallUMaxYMin) wallUMaxYMin = y
      if (y > wallUMaxYMax) wallUMaxYMax = y
    }
    if (Math.abs(v - vMin) <= uvBand) {
      if (u < wallVMinUMin) wallVMinUMin = u
      if (u > wallVMinUMax) wallVMinUMax = u
      if (y < wallVMinYMin) wallVMinYMin = y
      if (y > wallVMinYMax) wallVMinYMax = y
    }
    if (Math.abs(v - vMax) <= uvBand) {
      if (u < wallVMaxUMin) wallVMaxUMin = u
      if (u > wallVMaxUMax) wallVMaxUMax = u
      if (y < wallVMaxYMin) wallVMaxYMin = y
      if (y > wallVMaxYMax) wallVMaxYMax = y
    }
  }

  const avgPointColor = (filterFn) => {
    let sr = 0, sg = 0, sb = 0, count = 0
    for (let i = 0, b = 0; i < n; i++, b += 6) {
      if (!filterFn(b)) continue
      sr += D[b + 3]
      sg += D[b + 4]
      sb += D[b + 5]
      count++
    }
    const inv = count > 0 ? 1 / count : 1
    return [sr * inv || 0.5, sg * inv || 0.5, sb * inv || 0.5]
  }

  const segments = []
  const floorColor = avgPointColor(b => Math.abs((D[b + 1] + yOffset) - displayMinY) <= yBand)
  const ceilColor = avgPointColor(b => Math.abs((D[b + 1] + yOffset) - displayMaxY) <= yBand)
  const wallUminColor = avgPointColor(b => {
    const dx = D[b] - meanX
    const dz = D[b + 2] - meanZ
    const u = dx * axisU[0] + dz * axisU[2]
    return Math.abs(u - uMin) <= uvBand
  })
  const wallUmaxColor = avgPointColor(b => {
    const dx = D[b] - meanX
    const dz = D[b + 2] - meanZ
    const u = dx * axisU[0] + dz * axisU[2]
    return Math.abs(u - uMax) <= uvBand
  })
  const wallVminColor = avgPointColor(b => {
    const dx = D[b] - meanX
    const dz = D[b + 2] - meanZ
    const v = dx * axisV[0] + dz * axisV[2]
    return Math.abs(v - vMin) <= uvBand
  })
  const wallVmaxColor = avgPointColor(b => {
    const dx = D[b] - meanX
    const dz = D[b + 2] - meanZ
    const v = dx * axisV[0] + dz * axisV[2]
    return Math.abs(v - vMax) <= uvBand
  })

  const floorY = Number.isFinite(floorMinY) ? floorMinY : displayMinY
  const ceilY = Number.isFinite(ceilMaxY) ? ceilMaxY : displayMaxY
  const wallYMin = Number.isFinite(wallUMinYMin) ? Math.min(wallUMinYMin, wallUMaxYMin, wallVMinYMin, wallVMaxYMin) : floorY
  const wallYMax = Number.isFinite(wallUMinYMax) ? Math.max(wallUMinYMax, wallUMaxYMax, wallVMinYMax, wallVMaxYMax) : ceilY
  const wallUMinVMinSafe = Number.isFinite(wallUMinVMin) ? wallUMinVMin : vMin
  const wallUMinVMaxSafe = Number.isFinite(wallUMinVMax) ? wallUMinVMax : vMax
  const wallUMaxVMinSafe = Number.isFinite(wallUMaxVMin) ? wallUMaxVMin : vMin
  const wallUMaxVMaxSafe = Number.isFinite(wallUMaxVMax) ? wallUMaxVMax : vMax
  const wallVMinUMinSafe = Number.isFinite(wallVMinUMin) ? wallVMinUMin : uMin
  const wallVMinUMaxSafe = Number.isFinite(wallVMinUMax) ? wallVMinUMax : uMax
  const wallVMaxUMinSafe = Number.isFinite(wallVMaxUMin) ? wallVMaxUMin : uMin
  const wallVMaxUMaxSafe = Number.isFinite(wallVMaxUMax) ? wallVMaxUMax : uMax

  pushQuad(
    segments,
    'floor',
    'floor',
    [0, 1, 0],
    [
      pointFromRoomFrame(frame, uMin, vMin, floorY),
      pointFromRoomFrame(frame, uMax, vMin, floorY),
      pointFromRoomFrame(frame, uMax, vMax, floorY),
      pointFromRoomFrame(frame, uMin, vMax, floorY),
    ],
    [floorColor, floorColor, floorColor, floorColor],
  )

  pushQuad(
    segments,
    'ceiling',
    'ceiling',
    [0, -1, 0],
    [
      pointFromRoomFrame(frame, uMin, vMin, ceilY),
      pointFromRoomFrame(frame, uMin, vMax, ceilY),
      pointFromRoomFrame(frame, uMax, vMax, ceilY),
      pointFromRoomFrame(frame, uMax, vMin, ceilY),
    ],
    [ceilColor, ceilColor, ceilColor, ceilColor],
  )

  pushQuad(
    segments,
    'wall-u-min',
    'wall',
    [-axisU[0], 0, -axisU[2]],
    [
      pointFromRoomFrame(frame, uMin, wallUMinVMinSafe, wallYMin),
      pointFromRoomFrame(frame, uMin, wallUMinVMaxSafe, wallYMin),
      pointFromRoomFrame(frame, uMin, wallUMinVMaxSafe, wallYMax),
      pointFromRoomFrame(frame, uMin, wallUMinVMinSafe, wallYMax),
    ],
    [wallUminColor, wallUminColor, wallUminColor, wallUminColor],
  )

  pushQuad(
    segments,
    'wall-u-max',
    'wall',
    [axisU[0], 0, axisU[2]],
    [
      pointFromRoomFrame(frame, uMax, wallUMaxVMinSafe, wallYMin),
      pointFromRoomFrame(frame, uMax, wallUMaxVMinSafe, wallYMax),
      pointFromRoomFrame(frame, uMax, wallUMaxVMaxSafe, wallYMax),
      pointFromRoomFrame(frame, uMax, wallUMaxVMaxSafe, wallYMin),
    ],
    [wallUmaxColor, wallUmaxColor, wallUmaxColor, wallUmaxColor],
  )

  pushQuad(
    segments,
    'wall-v-min',
    'wall',
    [-axisV[0], 0, -axisV[2]],
    [
      pointFromRoomFrame(frame, wallVMinUMinSafe, vMin, wallYMin),
      pointFromRoomFrame(frame, wallVMinUMaxSafe, vMin, wallYMin),
      pointFromRoomFrame(frame, wallVMinUMaxSafe, vMin, wallYMax),
      pointFromRoomFrame(frame, wallVMinUMinSafe, vMin, wallYMax),
    ],
    [wallVminColor, wallVminColor, wallVminColor, wallVminColor],
  )

  pushQuad(
    segments,
    'wall-v-max',
    'wall',
    [axisV[0], 0, axisV[2]],
    [
      pointFromRoomFrame(frame, wallVMaxUMinSafe, vMax, wallYMin),
      pointFromRoomFrame(frame, wallVMaxUMinSafe, vMax, wallYMax),
      pointFromRoomFrame(frame, wallVMaxUMaxSafe, vMax, wallYMax),
      pointFromRoomFrame(frame, wallVMaxUMaxSafe, vMax, wallYMin),
    ],
    [wallVmaxColor, wallVmaxColor, wallVmaxColor, wallVmaxColor],
  )

  return { segments, yOffset, frame }
}

function finalizeSegment(segment) {
  const { tangent, bitangent } = computeUvBasis(segment.normal)
  const vertexCount = segment.positions.length / 3
  const projected = new Float32Array(vertexCount * 2)
  let minU = Infinity
  let maxU = -Infinity
  let minV = Infinity
  let maxV = -Infinity

  for (let i = 0; i < vertexCount; i++) {
    const point = [
      segment.positions[i * 3],
      segment.positions[i * 3 + 1],
      segment.positions[i * 3 + 2],
    ]
    const u = dot(point, tangent)
    const v = dot(point, bitangent)
    projected[i * 2] = u
    projected[i * 2 + 1] = v
    if (u < minU) minU = u
    if (u > maxU) maxU = u
    if (v < minV) minV = v
    if (v > maxV) maxV = v
  }

  const width = Math.max(EPSILON, maxU - minU)
  const height = Math.max(EPSILON, maxV - minV)
  const uvs = new Float32Array(vertexCount * 2)
  for (let i = 0; i < vertexCount; i++) {
    uvs[i * 2] = (projected[i * 2] - minU) / width
    uvs[i * 2 + 1] = (projected[i * 2 + 1] - minV) / height
  }

  return {
    ...segment,
    uvs,
    basis: { tangent, bitangent },
    extent: { width, height },
  }
}

export function segmentReconstructedMesh(mesh, {
  minTriangles = 12,
  normalTolerance = 0.12,
  planeTolerance = 0.18,
} = {}) {
  if (!mesh?.positions?.length || !mesh?.indices?.length) return []

  const segments = new Map()
  const positions = mesh.positions
  const colors = mesh.colors
  const indices = mesh.indices

  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i]
    const ib = indices[i + 1]
    const ic = indices[i + 2]

    const a = [positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2]]
    const b = [positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2]]
    const c = [positions[ic * 3], positions[ic * 3 + 1], positions[ic * 3 + 2]]

    let normal = normalize(cross(subtract(b, a), subtract(c, a)))
    if (length(normal) < EPSILON) continue

    const classification = classifySurfaceNormal(normal)
    if (classification === 'wall' && (normal[0] < 0 || (!normal[0] && normal[2] < 0))) {
      normal = [-normal[0], -normal[1], -normal[2]]
    }

    const centroid = [
      (a[0] + b[0] + c[0]) / 3,
      (a[1] + b[1] + c[1]) / 3,
      (a[2] + b[2] + c[2]) / 3,
    ]
    const planeOffset = dot(normal, centroid)
    const key = [
      classification,
      quantize(normal[0], normalTolerance),
      quantize(normal[1], normalTolerance),
      quantize(normal[2], normalTolerance),
      quantize(planeOffset, planeTolerance),
    ].join(':')

    let segment = segments.get(key)
    if (!segment) {
      segment = {
        id: key,
        classification,
        normalSum: [0, 0, 0],
        planeOffsetSum: 0,
        planeSamples: 0,
        positions: [],
        colors: [],
        indices: [],
        vertexMap: new Map(),
        triangleCount: 0,
      }
      segments.set(key, segment)
    }

    const appendVertex = (sourceIndex) => {
      const cached = segment.vertexMap.get(sourceIndex)
      if (cached != null) return cached
      const nextIndex = segment.positions.length / 3
      segment.vertexMap.set(sourceIndex, nextIndex)
      segment.positions.push(
        positions[sourceIndex * 3],
        positions[sourceIndex * 3 + 1],
        positions[sourceIndex * 3 + 2],
      )
      segment.colors.push(
        colors[sourceIndex * 3],
        colors[sourceIndex * 3 + 1],
        colors[sourceIndex * 3 + 2],
      )
      return nextIndex
    }

    segment.indices.push(appendVertex(ia), appendVertex(ib), appendVertex(ic))
    segment.normalSum[0] += normal[0]
    segment.normalSum[1] += normal[1]
    segment.normalSum[2] += normal[2]
    segment.planeOffsetSum += planeOffset
    segment.planeSamples += 1
    segment.triangleCount += 1
  }

  return [...segments.values()]
    .filter(segment => segment.triangleCount >= minTriangles)
    .map(segment => finalizeSegment({
      id: segment.id,
      classification: segment.classification,
      normal: normalize(segment.normalSum),
      planeOffset: segment.planeOffsetSum / Math.max(1, segment.planeSamples),
      triangleCount: segment.triangleCount,
      positions: new Float32Array(segment.positions),
      colors: new Float32Array(segment.colors),
      indices: Uint32Array.from(segment.indices),
    }))
}

export async function reconstructPlanarSurfaces(buf, {
  snapshots = [],
  yOffset = 0,
  segmentation,
} = {}) {
  const room = computeRoomFrame(buf)
  if (!room?.segments?.length) return null

  const segments = segmentation ? room.segments.filter(segment => {
    if (segment.classification === 'wall') return true
    return true
  }) : room.segments

  if (!snapshots.length) {
    return {
      mesh: combineSegments(segments),
      segments,
    }
  }

  const texturedSegments = await Promise.all(segments.map(async (segment) => ({
    ...segment,
    textureColors: await buildPhotoColorsForPositions(segment.positions, segment.colors, snapshots, room.yOffset) || segment.colors,
  })))

  return {
    mesh: combineSegments(texturedSegments),
    segments: texturedSegments,
  }
}

function combineSegments(segments) {
  let positionTotal = 0
  let colorTotal = 0
  let indexTotal = 0
  for (const segment of segments) {
    positionTotal += segment.positions.length
    colorTotal += segment.colors.length
    indexTotal += segment.indices.length
  }
  const positions = new Float32Array(positionTotal)
  const colors = new Float32Array(colorTotal)
  const indices = new Uint32Array(indexTotal)
  let p = 0, c = 0, i = 0, vertexOffset = 0
  for (const segment of segments) {
    positions.set(segment.positions, p); p += segment.positions.length
    colors.set(segment.textureColors || segment.colors, c); c += segment.colors.length
    for (let j = 0; j < segment.indices.length; j++) indices[i + j] = segment.indices[j] + vertexOffset
    i += segment.indices.length
    vertexOffset += segment.positions.length / 3
  }
  return { positions, colors, indices }
}