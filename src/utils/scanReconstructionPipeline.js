import { buildPhotoColorsForPositions } from './photoMesh'
import { reconstructSurface } from './surfaceReconstruction'

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
  ...reconstruction
} = {}) {
  const mesh = reconstructSurface(buf, { ...reconstruction, yOffset })
  if (!mesh) return null

  const segments = segmentReconstructedMesh(mesh, segmentation)
  if (!snapshots.length) return { mesh, segments }

  const texturedSegments = await Promise.all(segments.map(async (segment) => ({
    ...segment,
    textureColors: await buildPhotoColorsForPositions(segment.positions, segment.colors, snapshots, yOffset) || segment.colors,
  })))

  return { mesh, segments: texturedSegments }
}