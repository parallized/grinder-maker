export type XY = { x: number; y: number }

export type SpawnXYZ = { id: number; x: number; y: number; z: number }

type SpatialIndex<T> = {
  cellSize: number
  cells: Map<string, T[]>
}

function cellKey(cx: number, cy: number) {
  return `${cx},${cy}`
}

function toCell(value: number, cellSize: number) {
  return Math.floor(value / cellSize)
}

function dist2(a: XY, b: XY) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

function routeCost(route: SpawnXYZ[]) {
  let cost = 0
  for (let index = 0; index + 1 < route.length; index += 1) {
    cost += dist2(route[index], route[index + 1])
  }
  return cost
}

function buildSpatialIndex<T>(items: T[], cellSize: number, getXY: (item: T) => XY): SpatialIndex<T> {
  const cells = new Map<string, T[]>()
  const safeCellSize = Math.max(1e-6, cellSize)

  for (const item of items) {
    const { x, y } = getXY(item)
    const cx = toCell(x, safeCellSize)
    const cy = toCell(y, safeCellSize)
    const key = cellKey(cx, cy)
    const bucket = cells.get(key)
    if (bucket) bucket.push(item)
    else cells.set(key, [item])
  }

  return { cellSize: safeCellSize, cells }
}

function queryPointsWithin(index: SpatialIndex<SpawnXYZ>, center: XY, radius: number) {
  if (!(radius > 0)) return []
  if (index.cells.size === 0) return []

  const r2 = radius * radius
  const cx = toCell(center.x, index.cellSize)
  const cy = toCell(center.y, index.cellSize)
  const range = Math.ceil(radius / index.cellSize)

  const found: SpawnXYZ[] = []

  for (let dy = -range; dy <= range; dy += 1) {
    for (let dx = -range; dx <= range; dx += 1) {
      const bucket = index.cells.get(cellKey(cx + dx, cy + dy))
      if (!bucket) continue
      for (const point of bucket) {
        const dxw = point.x - center.x
        const dyw = point.y - center.y
        if (dxw * dxw + dyw * dyw <= r2) found.push(point)
      }
    }
  }

  return found
}

function dist2PointToSegment(p: XY, a: XY, b: XY) {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const apx = p.x - a.x
  const apy = p.y - a.y

  const abLen2 = abx * abx + aby * aby
  if (abLen2 < 1e-12) return apx * apx + apy * apy

  let t = (apx * abx + apy * aby) / abLen2
  t = Math.max(0, Math.min(1, t))
  const cx = a.x + t * abx
  const cy = a.y + t * aby
  const dx = p.x - cx
  const dy = p.y - cy
  return dx * dx + dy * dy
}

export function computeNeighborCounts(points: SpawnXYZ[], radius: number) {
  const counts = new Map<number, number>()
  if (points.length === 0) return counts

  if (!(radius > 0)) {
    for (const point of points) counts.set(point.id, 1)
    return counts
  }

  const index = buildSpatialIndex(points, radius, (item) => ({ x: item.x, y: item.y }))
  const r2 = radius * radius
  const range = Math.ceil(radius / index.cellSize)

  for (const point of points) {
    const cx = toCell(point.x, index.cellSize)
    const cy = toCell(point.y, index.cellSize)

    let count = 0
    for (let dy = -range; dy <= range; dy += 1) {
      for (let dx = -range; dx <= range; dx += 1) {
        const bucket = index.cells.get(cellKey(cx + dx, cy + dy))
        if (!bucket) continue
        for (const other of bucket) {
          const dxw = other.x - point.x
          const dyw = other.y - point.y
          if (dxw * dxw + dyw * dyw <= r2) count += 1
        }
      }
    }
    counts.set(point.id, count)
  }

  return counts
}

export type AutoRouteSettings = {
  center: XY
  maxAreaRadius: number
  maxStepDistance: number
  maxWaypoints: number
  avoidDenseTravelRadius: number
}

export type AutoRouteStats = {
  total: number
  inArea: number
  denseInArea: number
  safeInArea: number
  picked: number
}

export type AutoRouteResult = {
  route: SpawnXYZ[]
  stats: AutoRouteStats
}

export type TunedAutoRouteParams = {
  clusterRadius: number
  maxAreaRadius: number
  maxStepDistance: number
  avoidDenseTravelRadius: number
  dirtySupportRadius: number
}

function uniqueSorted(values: number[]) {
  const cleaned = values.filter((value) => Number.isFinite(value) && value > 0).slice()
  cleaned.sort((a, b) => a - b)
  const result: number[] = []
  let last = -Infinity
  for (const value of cleaned) {
    if (result.length === 0 || Math.abs(value - last) > 1e-9) {
      result.push(value)
      last = value
    }
  }
  return result
}

function estimateBaseSpacing(points: SpawnXYZ[]) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.x > maxX) maxX = point.x
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
  }

  const width = maxX - minX
  const height = maxY - minY
  const area = width * height
  if (area > 0) return Math.sqrt(area / Math.max(1, points.length))

  const extent = Math.max(Math.abs(width), Math.abs(height))
  if (extent > 0) return extent / Math.sqrt(Math.max(1, points.length))

  return 0
}

export function tuneAutoRouteParams(points: SpawnXYZ[], center: XY, maxWaypoints: number): TunedAutoRouteParams | null {
  const cappedWaypoints = Math.max(0, Math.floor(maxWaypoints))
  if (cappedWaypoints === 0) return null
  if (points.length === 0) return null

  const localCount = Math.min(points.length, Math.max(2000, Math.min(5000, cappedWaypoints * 200)))
  const byDistance = points
    .map((point) => ({ point, d2: dist2(center, point) }))
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, localCount)
    .map((item) => item.point)

  const baseSpacingRaw = estimateBaseSpacing(byDistance)
  const baseSpacing = baseSpacingRaw > 0 && Number.isFinite(baseSpacingRaw) ? baseSpacingRaw : 200
  const dirtySupportRadius = baseSpacing * 6

  const dirtyCounts = computeNeighborCounts(points, dirtySupportRadius)
  const dirtyIds = new Set<number>()
  for (const point of points) {
    const count = dirtyCounts.get(point.id) ?? 1
    if (count < 3) dirtyIds.add(point.id)
  }
  const cleanedPoints = points.filter((point) => !dirtyIds.has(point.id))
  const basePoints = cleanedPoints.length >= Math.min(points.length, Math.max(100, cappedWaypoints * 5)) ? cleanedPoints : points

  const clusterCandidates = uniqueSorted([
    baseSpacing * 0.25,
    baseSpacing * 0.35,
    baseSpacing * 0.5,
    baseSpacing * 0.7,
    baseSpacing * 1.0,
    baseSpacing * 1.4,
    baseSpacing * 2.0,
  ])

  type Best = { params: TunedAutoRouteParams; len: number; cost: number }
  let best: Best | null = null

  for (const clusterRadius of clusterCandidates) {
    const counts = computeNeighborCounts(basePoints, clusterRadius)
    const denseIds = new Set<number>()
    for (const point of basePoints) {
      const count = counts.get(point.id) ?? 1
      if (count >= 3) denseIds.add(point.id)
    }

    const safePoints = basePoints.filter((point) => !denseIds.has(point.id))
    if (safePoints.length === 0) continue

    const safeDistances = safePoints.map((point) => Math.sqrt(dist2(center, point)))
    safeDistances.sort((a, b) => a - b)

    const targetSafe = Math.min(
      safeDistances.length,
      Math.max(cappedWaypoints * 6, Math.min(400, cappedWaypoints * 12)),
    )
    const areaBase = safeDistances[targetSafe - 1] ?? safeDistances[safeDistances.length - 1] ?? 0

    const stepCandidates = uniqueSorted([
      baseSpacing * 0.8,
      baseSpacing * 1.0,
      baseSpacing * 1.3,
      baseSpacing * 1.7,
      baseSpacing * 2.2,
      baseSpacing * 3.0,
      clusterRadius * 1.3,
      clusterRadius * 1.8,
      clusterRadius * 2.4,
      clusterRadius * 3.2,
    ]).filter((value) => value > clusterRadius * 1.05)

    for (const maxStepDistance of stepCandidates) {
      const maxAreaRadius = areaBase + maxStepDistance * 0.35
      const avoidDenseTravelRadius = Math.max(clusterRadius * 1.15, maxStepDistance * 0.25)

      const result = generateAutoRoute(basePoints, denseIds, {
        center,
        maxAreaRadius,
        maxStepDistance,
        maxWaypoints: cappedWaypoints,
        avoidDenseTravelRadius,
      })

      const len = result.route.length
      const cost = routeCost(result.route)

      if (!best) {
        best = {
          params: { clusterRadius, maxAreaRadius, maxStepDistance, avoidDenseTravelRadius, dirtySupportRadius },
          len,
          cost,
        }
        continue
      }
      if (len > best.len) {
        best = {
          params: { clusterRadius, maxAreaRadius, maxStepDistance, avoidDenseTravelRadius, dirtySupportRadius },
          len,
          cost,
        }
        continue
      }
      if (len < best.len) continue

      if (maxStepDistance < best.params.maxStepDistance) {
        best = {
          params: { clusterRadius, maxAreaRadius, maxStepDistance, avoidDenseTravelRadius, dirtySupportRadius },
          len,
          cost,
        }
        continue
      }
      if (maxStepDistance > best.params.maxStepDistance) continue

      if (cost < best.cost) {
        best = {
          params: { clusterRadius, maxAreaRadius, maxStepDistance, avoidDenseTravelRadius, dirtySupportRadius },
          len,
          cost,
        }
        continue
      }
    }
  }

  return best?.params ?? null
}

function segmentAvoidsDense(
  a: XY,
  b: XY,
  denseIndex: SpatialIndex<SpawnXYZ> | null,
  avoidRadius: number,
) {
  if (!denseIndex) return true
  if (!(avoidRadius > 0)) return true
  if (denseIndex.cells.size === 0) return true

  const minX = Math.min(a.x, b.x) - avoidRadius
  const maxX = Math.max(a.x, b.x) + avoidRadius
  const minY = Math.min(a.y, b.y) - avoidRadius
  const maxY = Math.max(a.y, b.y) + avoidRadius

  const minCx = toCell(minX, denseIndex.cellSize)
  const maxCx = toCell(maxX, denseIndex.cellSize)
  const minCy = toCell(minY, denseIndex.cellSize)
  const maxCy = toCell(maxY, denseIndex.cellSize)

  const r2 = avoidRadius * avoidRadius

  for (let cy = minCy; cy <= maxCy; cy += 1) {
    for (let cx = minCx; cx <= maxCx; cx += 1) {
      const bucket = denseIndex.cells.get(cellKey(cx, cy))
      if (!bucket) continue
      for (const dense of bucket) {
        const d2 = dist2PointToSegment({ x: dense.x, y: dense.y }, a, b)
        if (d2 <= r2) return false
      }
    }
  }

  return true
}

export function generateAutoRoute(
  points: SpawnXYZ[],
  denseIds: Set<number>,
  settings: AutoRouteSettings,
) : AutoRouteResult {
  const total = points.length
  const safeMax = Math.max(0, Math.floor(settings.maxWaypoints))
  const maxWaypoints = safeMax > 0 ? safeMax : 0
  const maxAreaRadius = settings.maxAreaRadius
  const maxStep = settings.maxStepDistance
  const avoidRadius = settings.avoidDenseTravelRadius

  const maxAreaR2 = maxAreaRadius > 0 ? maxAreaRadius * maxAreaRadius : Infinity

  const inArea = points.filter((point) => dist2(settings.center, point) <= maxAreaR2)
  const denseInArea = inArea.filter((point) => denseIds.has(point.id))
  const safeInArea = inArea.filter((point) => !denseIds.has(point.id))

  const travelR2 =
    maxAreaRadius > 0 && avoidRadius > 0
      ? (maxAreaRadius + avoidRadius) * (maxAreaRadius + avoidRadius)
      : Infinity

  const denseForTravel =
    avoidRadius > 0
      ? points.filter((point) => denseIds.has(point.id) && dist2(settings.center, point) <= travelR2)
      : []

  const denseIndex =
    avoidRadius > 0 && denseForTravel.length > 0
      ? buildSpatialIndex(denseForTravel, avoidRadius, (item) => ({ x: item.x, y: item.y }))
      : null

  if (maxWaypoints === 0 || safeInArea.length === 0) {
    return {
      route: [],
      stats: {
        total,
        inArea: inArea.length,
        denseInArea: denseInArea.length,
        safeInArea: safeInArea.length,
        picked: 0,
      },
    }
  }

  const maxStep2 = maxStep > 0 ? maxStep * maxStep : Infinity
  const safeIndex =
    maxStep > 0
      ? buildSpatialIndex(safeInArea, maxStep, (item) => ({ x: item.x, y: item.y }))
      : null
  const stepNeighborCounts = maxStep > 0 ? computeNeighborCounts(safeInArea, maxStep) : new Map<number, number>()

  const closestToCenter = (() => {
    let best: SpawnXYZ | null = null
    let bestD2 = Infinity
    for (const point of safeInArea) {
      const d2 = dist2(settings.center, point)
      if (d2 < bestD2) {
        bestD2 = d2
        best = point
      }
    }
    return best
  })()

  const scoredStarts = safeInArea
    .map((point) => ({
      point,
      local: (stepNeighborCounts.get(point.id) ?? 1) - 1,
      centerD2: dist2(settings.center, point),
    }))
    .sort((a, b) => {
      if (a.local !== b.local) return b.local - a.local
      if (a.centerD2 !== b.centerD2) return a.centerD2 - b.centerD2
      return a.point.id - b.point.id
    })

  const startCandidates: SpawnXYZ[] = []
  const maxStartCandidates = Math.min(12, scoredStarts.length)
  for (let index = 0; index < maxStartCandidates; index += 1) {
    startCandidates.push(scoredStarts[index].point)
  }
  if (closestToCenter && !startCandidates.some((point) => point.id === closestToCenter.id)) {
    startCandidates.push(closestToCenter)
  }

  const buildGreedyPath = (start: SpawnXYZ) => {
    const visited = new Set<number>()
    const route: SpawnXYZ[] = []
    route.push(start)
    visited.add(start.id)

    while (route.length < maxWaypoints) {
      const current = route[route.length - 1]

      const candidates =
        safeIndex && maxStep > 0 && Number.isFinite(maxStep2)
          ? queryPointsWithin(safeIndex, current, maxStep)
          : safeInArea.slice()

      let best: SpawnXYZ | null = null
      let bestDegree = -1
      let bestLocal = -1
      let bestStepD2 = Infinity
      let bestCenterD2 = Infinity

      for (const candidate of candidates) {
        if (candidate.id === current.id) continue
        if (visited.has(candidate.id)) continue

        const stepD2 = dist2(current, candidate)
        if (stepD2 > maxStep2) continue
        if (!segmentAvoidsDense(current, candidate, denseIndex, avoidRadius)) continue

        let degree = 0
        if (safeIndex && maxStep > 0 && Number.isFinite(maxStep2)) {
          const neighbors = queryPointsWithin(safeIndex, candidate, maxStep)
          for (const neighbor of neighbors) {
            if (neighbor.id === candidate.id) continue
            if (visited.has(neighbor.id)) continue
            degree += 1
          }
        } else {
          degree = safeInArea.length - visited.size
        }

        const local = (stepNeighborCounts.get(candidate.id) ?? 1) - 1
        const centerD2 = dist2(settings.center, candidate)

        if (degree > bestDegree) {
          best = candidate
          bestDegree = degree
          bestLocal = local
          bestStepD2 = stepD2
          bestCenterD2 = centerD2
          continue
        }
        if (degree < bestDegree) continue

        if (local > bestLocal) {
          best = candidate
          bestLocal = local
          bestStepD2 = stepD2
          bestCenterD2 = centerD2
          continue
        }
        if (local < bestLocal) continue

        if (stepD2 < bestStepD2) {
          best = candidate
          bestStepD2 = stepD2
          bestCenterD2 = centerD2
          continue
        }
        if (stepD2 > bestStepD2) continue

        if (centerD2 < bestCenterD2) {
          best = candidate
          bestCenterD2 = centerD2
          continue
        }
      }

      if (!best) break
      route.push(best)
      visited.add(best.id)
    }

    return route
  }

  let bestRoute = buildGreedyPath(startCandidates[0] ?? safeInArea[0])
  let bestCost = routeCost(bestRoute)

  for (const start of startCandidates.slice(1)) {
    const route = buildGreedyPath(start)
    if (route.length > bestRoute.length) {
      bestRoute = route
      bestCost = routeCost(route)
      continue
    }
    if (route.length === bestRoute.length) {
      const cost = routeCost(route)
      if (cost < bestCost) {
        bestRoute = route
        bestCost = cost
      }
    }
  }

  return {
    route: bestRoute,
    stats: {
      total,
      inArea: inArea.length,
      denseInArea: denseInArea.length,
      safeInArea: safeInArea.length,
      picked: bestRoute.length,
    },
  }
}
