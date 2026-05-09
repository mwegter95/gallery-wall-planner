export const MAX_POINT_CLOUD_PREVIEW_POINTS = 900_000
export const MAX_POINT_CLOUD_PREVIEW_SNAPSHOTS = 24
export const POINT_CLOUD_PREVIEW_CELL_SIZE = 0.08

export function getPreviewStride(pointCount, maxPreviewPoints = MAX_POINT_CLOUD_PREVIEW_POINTS) {
  if (!Number.isFinite(pointCount) || pointCount <= 0) return 1
  return Math.max(1, Math.ceil(pointCount / maxPreviewPoints))
}

function hashVoxel(ix, iy, iz) {
  return `${ix}:${iy}:${iz}`
}

export function buildPointCloudPreview(rawData, pointCount, {
  maxPreviewPoints = MAX_POINT_CLOUD_PREVIEW_POINTS,
  cellSize = POINT_CLOUD_PREVIEW_CELL_SIZE,
} = {}) {
  if (!(rawData instanceof Float32Array) || !Number.isFinite(pointCount) || pointCount <= 0) {
    return {
      positions: new Float32Array(0),
      colors: new Float32Array(0),
      splatScales: new Float32Array(0),
      normals: new Float32Array(0),
      yOffset: 0,
    }
  }

  const cellInv = 1 / cellSize
  const voxelMap = new Map()
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity

  for (let i = 0, b = 0; i < pointCount; i++, b += 6) {
    const x = rawData[b]
    const y = rawData[b + 1]
    const z = rawData[b + 2]
    const r = rawData[b + 3]
    const g = rawData[b + 4]
    const blue = rawData[b + 5]

    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z

    const ix = Math.floor(x * cellInv)
    const iy = Math.floor(y * cellInv)
    const iz = Math.floor(z * cellInv)
    const key = hashVoxel(ix, iy, iz)
    let voxel = voxelMap.get(key)
    if (!voxel) {
      voxel = { sumX: 0, sumY: 0, sumZ: 0, sumR: 0, sumG: 0, sumB: 0, count: 0 }
      voxelMap.set(key, voxel)
    }
    voxel.sumX += x
    voxel.sumY += y
    voxel.sumZ += z
    voxel.sumR += r
    voxel.sumG += g
    voxel.sumB += blue
    voxel.count += 1
  }

  const voxels = [...voxelMap.values()]
  if (voxels.length === 0) {
    return {
      positions: new Float32Array(0),
      colors: new Float32Array(0),
      splatScales: new Float32Array(0),
      normals: new Float32Array(0),
      yOffset: 0,
    }
  }

  voxels.sort((left, right) => right.count - left.count)
  const selected = voxels.slice(0, maxPreviewPoints)
  const yOffset = Number.isFinite(minY) ? -minY : 0
  const roomCenterX = (minX + maxX) * 0.5
  const roomCenterZ = (minZ + maxZ) * 0.5
  const roomHeight = Number.isFinite(maxY) && Number.isFinite(minY) ? (maxY - minY) : 1
  const floorTop = minY + roomHeight * 0.2
  const ceilBottom = maxY - roomHeight * 0.2

  const positions = new Float32Array(selected.length * 3)
  const colors = new Float32Array(selected.length * 3)
  const splatScales = new Float32Array(selected.length)
  const normals = new Float32Array(selected.length * 3)

  for (let i = 0; i < selected.length; i++) {
    const voxel = selected[i]
    const inv = 1 / voxel.count
    const px = voxel.sumX * inv
    const py = voxel.sumY * inv
    const pz = voxel.sumZ * inv

    positions[i * 3] = px
    positions[i * 3 + 1] = py + yOffset
    positions[i * 3 + 2] = pz
    colors[i * 3] = voxel.sumR * inv
    colors[i * 3 + 1] = voxel.sumG * inv
    colors[i * 3 + 2] = voxel.sumB * inv
    splatScales[i] = Math.max(0.55, Math.min(1.8, 1.9 / Math.sqrt(voxel.count)))

    if (py <= floorTop) {
      normals[i * 3] = 0
      normals[i * 3 + 1] = 1
      normals[i * 3 + 2] = 0
    } else if (py >= ceilBottom) {
      normals[i * 3] = 0
      normals[i * 3 + 1] = -1
      normals[i * 3 + 2] = 0
    } else {
      const nx = px - roomCenterX
      const nz = pz - roomCenterZ
      const len = Math.hypot(nx, nz) || 1
      normals[i * 3] = nx / len
      normals[i * 3 + 1] = 0
      normals[i * 3 + 2] = nz / len
    }
  }

  return { positions, colors, splatScales, normals, yOffset }
}

export function selectPreviewSnapshots(snapshots, maxSnapshots = MAX_POINT_CLOUD_PREVIEW_SNAPSHOTS) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return []
  if (snapshots.length <= maxSnapshots) return snapshots
  if (maxSnapshots <= 1) return [snapshots[0]]

  const selected = []
  let lastIndex = -1
  for (let i = 0; i < maxSnapshots; i++) {
    const index = Math.round((i * (snapshots.length - 1)) / (maxSnapshots - 1))
    if (index === lastIndex) continue
    selected.push(snapshots[index])
    lastIndex = index
  }
  return selected
}