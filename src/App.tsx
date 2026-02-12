import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { computeNeighborCounts, generateAutoRoute, tuneAutoRouteParams, type SpawnXYZ } from "@/lib/auto-route"

type PixelPoint = { x: number; y: number }
type WorldPoint = { x: number; y: number }

type Calibration = {
  scale: number
  rotationRad: number
  translation: WorldPoint
}

const FIXED_TRANSFORM_BY_MAP: Record<
  string,
  { scale: number; rotationDeg: number; translation?: WorldPoint } | undefined
> = {
  kingdoms: {
    scale: 2.0807279053318206,
    rotationDeg: 37.73901114655402,
    translation: { x: -3346.5013801204836, y: -15760.71644800781 },
  },
}

const MAP_ID_BY_KEY: Record<string, number | undefined> = {
  kingdoms: 0,
  kalimdor: 1,
}

type MapMeta = {
  key: string
  src: string
  width: number
  height: number
  tileSize: number
  maxZoom: number
}

type Viewport = {
  width: number
  height: number
  baseScale: number
  scale: number
  offsetX: number
  offsetY: number
}

type ContextMenuState = {
  open: boolean
  x: number
  y: number
  imagePoint: PixelPoint | null
}

type MarkPoint = {
  id: number
  name: string
  center: [number, number, number]
  radius: number
}

type SpawnPoint = {
  id: number
  positionX: number
  positionY: number
  positionZ: number
  map: number
  faction: number
  levelMin: number
  levelMax: number
}

type ProjectedSpawn = SpawnPoint & { screenX: number; screenY: number; color: string }

type ProjectedMarkPoint = MarkPoint & { screenX: number; screenY: number }

type AnchorKey = "A" | "B" | "C"

type AnchorPoint = {
  key: AnchorKey
  x: number
  y: number
}

type AffineWorldToImage = {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

const KINGDOMS_ANCHOR_WORLD: Record<AnchorKey, WorldPoint> = {
  A: { x: -10629, y: 1037 },
  B: { x: 3149, y: -3400 },
  C: { x: -11143, y: -2100 },
}

const AFFINE_WORLD_TO_IMAGE_BY_MAP: Record<string, AffineWorldToImage | undefined> = {
  kingdoms: undefined,
}

const MIN_ZOOM = 0.05
const MAX_ZOOM = 24

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function levelColor(level: number) {
  const palette = [
    "#ef4444",
    "#22c55e",
    "#3b82f6",
    "#f59e0b",
    "#a855f7",
    "#06b6d4",
  ]
  const index = Math.max(0, (Math.round(level) - 1) % palette.length)
  return palette[index]
}

function solveLinear3x3(matrix: number[][], vector: number[]) {
  const m = matrix.map((row) => row.slice())
  const v = vector.slice()
  for (let index = 0; index < 3; index += 1) {
    let pivot = index
    for (let row = index + 1; row < 3; row += 1) {
      if (Math.abs(m[row][index]) > Math.abs(m[pivot][index])) pivot = row
    }
    if (Math.abs(m[pivot][index]) < 1e-12) return null
    ;[m[index], m[pivot]] = [m[pivot], m[index]]
    ;[v[index], v[pivot]] = [v[pivot], v[index]]

    const factor = m[index][index]
    for (let column = index; column < 3; column += 1) m[index][column] /= factor
    v[index] /= factor

    for (let row = 0; row < 3; row += 1) {
      if (row === index) continue
      const multiplier = m[row][index]
      for (let column = index; column < 3; column += 1) {
        m[row][column] -= multiplier * m[index][column]
      }
      v[row] -= multiplier * v[index]
    }
  }
  return v
}

function App() {
  const viewerRef = useRef<HTMLDivElement | null>(null)
  const pointsCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [maps, setMaps] = useState<MapMeta[]>([])
  const [imageKey, setImageKey] = useState("kalimdor")
  const [viewport, setViewport] = useState<Viewport>({
    width: 0,
    height: 0,
    baseScale: 1,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  })
  const [isPanning, setIsPanning] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    open: false,
    x: 0,
    y: 0,
    imagePoint: null,
  })

  const [pixelA, setPixelA] = useState<PixelPoint | null>(null)
  const [pixelB, setPixelB] = useState<PixelPoint | null>(null)
  const [worldA, setWorldA] = useState<WorldPoint>({ x: 0, y: 0 })
  const [worldB, setWorldB] = useState<WorldPoint>({ x: 100, y: 100 })
  const [spawnPoints, setSpawnPoints] = useState<SpawnPoint[]>([])
  const [importInfo, setImportInfo] = useState<string>("未导入")
  const [levelRange, setLevelRange] = useState<[number, number]>([1, 80])
  const [anchors, setAnchors] = useState<AnchorPoint[]>([
    { key: "A", x: 2172.0848, y: 8522.1001 },
    { key: "B", x: 4300.997, y: 1911.7805 },
    { key: "C", x: 3676.8278, y: 8770.1033 },
  ])
  const [draggingAnchorKey, setDraggingAnchorKey] = useState<AnchorKey | null>(null)
  const [redrawVersion, setRedrawVersion] = useState(0)
  const [markPoints, setMarkPoints] = useState<MarkPoint[]>([])
  const [copied, setCopied] = useState(false)
  const [activeMarkPointId, setActiveMarkPointId] = useState<number | null>(null)
  const [autoClusterRadius, setAutoClusterRadius] = useState(80)
  const [autoMaxAreaRadius, setAutoMaxAreaRadius] = useState(1200)
  const [autoMaxStepDistance, setAutoMaxStepDistance] = useState(350)
  const [autoMaxWaypoints, setAutoMaxWaypoints] = useState(20)
  const [autoWaypointRadius, setAutoWaypointRadius] = useState(60)
  const [autoAvoidTravelRadius, setAutoAvoidTravelRadius] = useState(120)
  const [highlightDenseSpawns, setHighlightDenseSpawns] = useState(true)
  const [autoTuneEnabled, setAutoTuneEnabled] = useState(true)
  const [autoRouteInfo, setAutoRouteInfo] = useState("")

  useEffect(() => {
    fetch("/tiles/meta.json")
      .then((res) => res.json())
      .then((data: { maps: MapMeta[] }) => {
        setMaps(data.maps)
        if (data.maps.length > 0) setImageKey(data.maps[0].key)
      })
      .catch(() => {
        setMaps([
          { key: "kalimdor", src: "/kalimdor.png", width: 7000, height: 12000, tileSize: 512, maxZoom: 5 },
          { key: "kingdoms", src: "/kingdoms.png", width: 7000, height: 12000, tileSize: 512, maxZoom: 5 },
        ])
      })
  }, [])

  const currentMap = useMemo(
    () => maps.find((item) => item.key === imageKey) ?? maps[0] ?? null,
    [imageKey, maps],
  )

  const bakedKingdomsAffine = useMemo(() => {
    const anchorA = anchors.find((anchor) => anchor.key === "A")
    const anchorB = anchors.find((anchor) => anchor.key === "B")
    const anchorC = anchors.find((anchor) => anchor.key === "C")
    if (!anchorA || !anchorB || !anchorC) return null

    const m = [
      [KINGDOMS_ANCHOR_WORLD.A.x, KINGDOMS_ANCHOR_WORLD.A.y, 1],
      [KINGDOMS_ANCHOR_WORLD.B.x, KINGDOMS_ANCHOR_WORLD.B.y, 1],
      [KINGDOMS_ANCHOR_WORLD.C.x, KINGDOMS_ANCHOR_WORLD.C.y, 1],
    ]

    const sx = solveLinear3x3(m, [anchorA.x, anchorB.x, anchorC.x])
    const sy = solveLinear3x3(m, [anchorA.y, anchorB.y, anchorC.y])
    if (!sx || !sy) return null

    return {
      a: sx[0],
      b: sx[1],
      c: sx[2],
      d: sy[0],
      e: sy[1],
      f: sy[2],
    } as AffineWorldToImage
  }, [anchors])

  const currentAffine = useMemo(() => {
    if (!currentMap) return undefined
    if (currentMap.key === "kingdoms") return bakedKingdomsAffine ?? undefined
    return AFFINE_WORLD_TO_IMAGE_BY_MAP[currentMap.key]
  }, [currentMap, bakedKingdomsAffine])

  const currentMapId = currentMap ? MAP_ID_BY_KEY[currentMap.key] : undefined

  const effectiveScale = viewport.baseScale * viewport.scale

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !currentMap) return
    const resize = () => {
      const rect = viewer.getBoundingClientRect()
      const fitScale = Math.min(rect.width / currentMap.width, rect.height / currentMap.height)
      const safeBaseScale = Math.max(fitScale, 1e-6)
      setViewport({
        width: rect.width,
        height: rect.height,
        baseScale: safeBaseScale,
        scale: 1,
        offsetX: (rect.width - currentMap.width * safeBaseScale) / 2,
        offsetY: (rect.height - currentMap.height * safeBaseScale) / 2,
      })
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(viewer)
    return () => observer.disconnect()
  }, [currentMap])

  const calibration = useMemo(() => {
    const fixedTransform = currentMap ? FIXED_TRANSFORM_BY_MAP[currentMap.key] : undefined
    if (fixedTransform) {
      const rotationRad = (fixedTransform.rotationDeg * Math.PI) / 180
      const scale = fixedTransform.scale
      if (fixedTransform.translation) {
        return {
          scale,
          rotationRad,
          translation: fixedTransform.translation,
        } as Calibration
      }
      const cos = Math.cos(rotationRad)
      const sin = Math.sin(rotationRad)

      const translationFromA = pixelA
        ? {
            x: worldA.x - scale * (cos * pixelA.x - sin * pixelA.y),
            y: worldA.y - scale * (sin * pixelA.x + cos * pixelA.y),
          }
        : null

      const translationFromB = pixelB
        ? {
            x: worldB.x - scale * (cos * pixelB.x - sin * pixelB.y),
            y: worldB.y - scale * (sin * pixelB.x + cos * pixelB.y),
          }
        : null

      if (translationFromA && translationFromB) {
        return {
          scale,
          rotationRad,
          translation: {
            x: (translationFromA.x + translationFromB.x) / 2,
            y: (translationFromA.y + translationFromB.y) / 2,
          },
        } as Calibration
      }

      if (translationFromA) {
        return { scale, rotationRad, translation: translationFromA } as Calibration
      }

      if (translationFromB) {
        return { scale, rotationRad, translation: translationFromB } as Calibration
      }

      return null
    }

    if (!pixelA || !pixelB) return null
    const dp = { x: pixelB.x - pixelA.x, y: pixelB.y - pixelA.y }
    const dw = { x: worldB.x - worldA.x, y: worldB.y - worldA.y }
    const pixelDistance = Math.hypot(dp.x, dp.y)
    const worldDistance = Math.hypot(dw.x, dw.y)
    if (pixelDistance < 1e-6 || worldDistance < 1e-6) return null
    const scale = worldDistance / pixelDistance
    const rotationRad = Math.atan2(dw.y, dw.x) - Math.atan2(dp.y, dp.x)
    const cos = Math.cos(rotationRad)
    const sin = Math.sin(rotationRad)
    const rotatedScaledA = {
      x: scale * (cos * pixelA.x - sin * pixelA.y),
      y: scale * (sin * pixelA.x + cos * pixelA.y),
    }
    const translation = { x: worldA.x - rotatedScaledA.x, y: worldA.y - rotatedScaledA.y }
    return { scale, rotationRad, translation } as Calibration
  }, [currentMap, pixelA, pixelB, worldA, worldB])

  const screenToImage = (screenX: number, screenY: number): PixelPoint => ({
    x: (screenX - viewport.offsetX) / effectiveScale,
    y: (screenY - viewport.offsetY) / effectiveScale,
  })

  const onViewerWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (!currentMap) return
    const rect = event.currentTarget.getBoundingClientRect()
    const cursorX = event.clientX - rect.left
    const cursorY = event.clientY - rect.top
    const imageBefore = screenToImage(cursorX, cursorY)
    const factor = Math.exp(-event.deltaY * 0.0015)
    const newScale = clamp(viewport.scale * factor, MIN_ZOOM, MAX_ZOOM)
    const newEffectiveScale = viewport.baseScale * newScale

    setViewport((prev) => ({
      ...prev,
      scale: newScale,
      offsetX: cursorX - imageBefore.x * newEffectiveScale,
      offsetY: cursorY - imageBefore.y * newEffectiveScale,
    }))
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    if (event.target !== event.currentTarget) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsPanning(true)
    setContextMenu((prev) => ({ ...prev, open: false }))
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (draggingAnchorKey && currentMap) {
      const rect = event.currentTarget.getBoundingClientRect()
      const imagePoint = screenToImage(event.clientX - rect.left, event.clientY - rect.top)
      const nextPoint = {
        x: clamp(imagePoint.x, 0, currentMap.width),
        y: clamp(imagePoint.y, 0, currentMap.height),
      }
      setAnchors((prev) =>
        prev.map((anchor) =>
          anchor.key === draggingAnchorKey ? { ...anchor, x: nextPoint.x, y: nextPoint.y } : anchor,
        ),
      )
      return
    }
    if (!isPanning) return
    setViewport((prev) => ({
      ...prev,
      offsetX: prev.offsetX + event.movementX,
      offsetY: prev.offsetY + event.movementY,
    }))
  }

  const onPointerUp = () => {
    if (draggingAnchorKey) {
      setRedrawVersion((value) => value + 1)
    }
    setIsPanning(false)
    setDraggingAnchorKey(null)
  }

  const onViewerContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (!currentMap) return
    const rect = event.currentTarget.getBoundingClientRect()
    const imagePoint = screenToImage(event.clientX - rect.left, event.clientY - rect.top)
    setContextMenu({
      open: true,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      imagePoint: {
        x: clamp(imagePoint.x, 0, currentMap.width),
        y: clamp(imagePoint.y, 0, currentMap.height),
      },
    })
  }

  const setCalibrationPoint = (target: "A" | "B") => {
    if (!contextMenu.imagePoint) return
    if (target === "A") setPixelA(contextMenu.imagePoint)
    if (target === "B") setPixelB(contextMenu.imagePoint)
    setContextMenu((prev) => ({ ...prev, open: false }))
  }

  const centerWorld = useMemo(() => {
    if (!calibration || !currentMap) return null
    const center = screenToImage(viewport.width / 2, viewport.height / 2)
    const cos = Math.cos(calibration.rotationRad)
    const sin = Math.sin(calibration.rotationRad)
    return {
      x: calibration.scale * (cos * center.x - sin * center.y) + calibration.translation.x,
      y: calibration.scale * (sin * center.x + cos * center.y) + calibration.translation.y,
    }
  }, [calibration, currentMap, viewport, effectiveScale])

  const worldToImage = (world: WorldPoint): PixelPoint | null => {
    if (currentAffine) {
      return {
        x: currentAffine.a * world.x + currentAffine.b * world.y + currentAffine.c,
        y: currentAffine.d * world.x + currentAffine.e * world.y + currentAffine.f,
      }
    }
    if (!calibration) return null
    const dx = world.x - calibration.translation.x
    const dy = world.y - calibration.translation.y
    const cos = Math.cos(calibration.rotationRad)
    const sin = Math.sin(calibration.rotationRad)
    return {
      x: (cos * dx + sin * dy) / calibration.scale,
      y: (-sin * dx + cos * dy) / calibration.scale,
    }
  }

  const imageToWorld = (pixel: PixelPoint): WorldPoint | null => {
    if (currentAffine) {
      const a = currentAffine.a
      const b = currentAffine.b
      const c = currentAffine.c
      const d = currentAffine.d
      const e = currentAffine.e
      const f = currentAffine.f
      const det = a * e - b * d
      if (Math.abs(det) < 1e-12) return null
      const px = pixel.x - c
      const py = pixel.y - f
      return {
        x: (e * px - b * py) / det,
        y: (-d * px + a * py) / det,
      }
    }
    if (!calibration) return null
    const dx = pixel.x
    const dy = pixel.y
    const cos = Math.cos(calibration.rotationRad)
    const sin = Math.sin(calibration.rotationRad)
    return {
      x: calibration.translation.x + (cos * dx + sin * dy) / calibration.scale,
      y: calibration.translation.y + (-sin * dx + cos * dy) / calibration.scale,
    }
  }

  const addMarkPointFromContext = () => {
    if (!contextMenu.imagePoint) return
    const world = imageToWorld(contextMenu.imagePoint)
    if (!world) return
    setMarkPoints((prev) => [
      ...prev,
      {
        id: Date.now(),
        name: `点位${prev.length + 1}`,
        center: [world.x, world.y, 0],
        radius: 60,
      },
    ])
    setContextMenu((prev) => ({ ...prev, open: false }))
  }

  const exportedMarkPoints = useMemo(
    () =>
      JSON.stringify(
        markPoints.map((point) => ({
          name: point.name,
          center: [
            Number(point.center[0].toFixed(4)),
            Number(point.center[1].toFixed(4)),
            Number(point.center[2].toFixed(4)),
          ],
          radius: Number(point.radius.toFixed(4)),
        })),
        null,
        2,
      ),
    [markPoints],
  )

  const copyMarkPoints = async () => {
    await navigator.clipboard.writeText(exportedMarkPoints)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  const onImportTxt = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    const text = await file.text()
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    const parsed: SpawnPoint[] = []
    let badLines = 0

    for (const line of lines) {
      const parts = line.split(",").map((part) => part.trim())
      if (parts.length < 8) {
        badLines += 1
        continue
      }

      const values = parts.slice(0, 8).map((part) => Number(part))
      if (values.some((value) => Number.isNaN(value))) {
        badLines += 1
        continue
      }

      parsed.push({
        id: values[0],
        positionX: values[1],
        positionY: values[2],
        positionZ: values[3],
        map: values[4],
        faction: values[5],
        levelMin: values[6],
        levelMax: values[7],
      })
    }

    setSpawnPoints(parsed)
    setImportInfo(`已导入 ${parsed.length} 条${badLines > 0 ? `，跳过 ${badLines} 条坏数据` : ""}`)
    event.target.value = ""
  }

  const filteredSpawns = useMemo(() => {
    if (currentMapId === undefined) return []
    return spawnPoints
      .filter((spawn) => spawn.map === currentMapId)
      .filter((spawn) => spawn.levelMax >= levelRange[0] && spawn.levelMin <= levelRange[1])
  }, [spawnPoints, currentMapId, levelRange])

  const imageSpawns = useMemo(() => {
    if (!currentMap || (!calibration && !currentAffine)) return []
    return filteredSpawns
      .map((spawn) => {
        const imagePoint = worldToImage({ x: spawn.positionX, y: spawn.positionY })
        if (!imagePoint) return null
        if (imagePoint.x < 0 || imagePoint.y < 0 || imagePoint.x > currentMap.width || imagePoint.y > currentMap.height) {
          return null
        }
        const level = Math.round((spawn.levelMin + spawn.levelMax) / 2)
        return { spawn, imageX: imagePoint.x, imageY: imagePoint.y, level }
      })
      .filter((item): item is { spawn: SpawnPoint; imageX: number; imageY: number; level: number } => item !== null)
  }, [filteredSpawns, currentMap, calibration, currentAffine, redrawVersion])

  const routePoints = useMemo<SpawnXYZ[]>(
    () =>
      imageSpawns.map(({ spawn }) => ({
        id: spawn.id,
        x: spawn.positionX,
        y: spawn.positionY,
        z: spawn.positionZ,
      })),
    [imageSpawns],
  )

  const densityInfo = useMemo(() => {
    const counts = computeNeighborCounts(routePoints, autoClusterRadius)
    const denseIds = new Set<number>()
    for (const point of routePoints) {
      const count = counts.get(point.id) ?? 1
      if (count >= 3) denseIds.add(point.id)
    }
    return {
      points: routePoints,
      counts,
      denseIds,
      denseCount: denseIds.size,
      total: routePoints.length,
    }
  }, [routePoints, autoClusterRadius])

  const projectedSpawns = useMemo<(ProjectedSpawn & { isDense: boolean })[]>(() => {
    if (!currentMap || (!calibration && !currentAffine)) return []
    if (currentMapId === undefined) return []

    return imageSpawns.map(({ spawn, imageX, imageY, level }) => {
      const isDense = densityInfo.denseIds.has(spawn.id)
      const baseColor = levelColor(level)
      return {
        ...spawn,
        screenX: viewport.offsetX + imageX * effectiveScale,
        screenY: viewport.offsetY + imageY * effectiveScale,
        isDense,
        color: highlightDenseSpawns && isDense ? "rgba(239,68,68,0.85)" : baseColor,
      }
    })
  }, [
    imageSpawns,
    calibration,
    currentAffine,
    currentMap,
    currentMapId,
    viewport.offsetX,
    viewport.offsetY,
    effectiveScale,
    densityInfo.denseIds,
    highlightDenseSpawns,
    redrawVersion,
  ])

  const projectedMarkPoints = useMemo(() => {
    return markPoints
      .map((point) => {
        const imagePoint = worldToImage({ x: point.center[0], y: point.center[1] })
        if (!imagePoint) return null
        return {
          ...point,
          screenX: viewport.offsetX + imagePoint.x * effectiveScale,
          screenY: viewport.offsetY + imagePoint.y * effectiveScale,
        }
      })
      .filter((item): item is ProjectedMarkPoint => item !== null)
  }, [markPoints, viewport.offsetX, viewport.offsetY, effectiveScale, currentAffine, calibration])

  useEffect(() => {
    const canvas = pointsCanvasRef.current
    if (!canvas) return

    const width = Math.max(1, Math.floor(viewport.width))
    const height = Math.max(1, Math.floor(viewport.height))
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height

    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.clearRect(0, 0, width, height)

    if (projectedMarkPoints.length >= 2) {
      ctx.save()
      ctx.strokeStyle = "rgba(34,211,238,0.9)"
      ctx.fillStyle = "rgba(34,211,238,0.9)"
      ctx.lineWidth = 3
      ctx.setLineDash([10, 8])
      ctx.beginPath()
      ctx.moveTo(projectedMarkPoints[0].screenX, projectedMarkPoints[0].screenY)
      for (let index = 1; index < projectedMarkPoints.length; index += 1) {
        ctx.lineTo(projectedMarkPoints[index].screenX, projectedMarkPoints[index].screenY)
      }
      ctx.stroke()
      ctx.setLineDash([])

      const headLength = 10
      const headAngle = Math.PI / 7
      for (let index = 0; index + 1 < projectedMarkPoints.length; index += 1) {
        const from = projectedMarkPoints[index]
        const to = projectedMarkPoints[index + 1]
        const angle = Math.atan2(to.screenY - from.screenY, to.screenX - from.screenX)
        ctx.beginPath()
        ctx.moveTo(to.screenX, to.screenY)
        ctx.lineTo(
          to.screenX - headLength * Math.cos(angle - headAngle),
          to.screenY - headLength * Math.sin(angle - headAngle),
        )
        ctx.lineTo(
          to.screenX - headLength * Math.cos(angle + headAngle),
          to.screenY - headLength * Math.sin(angle + headAngle),
        )
        ctx.closePath()
        ctx.fill()
      }

      ctx.restore()
    }

    if (projectedSpawns.length === 0) return

    const radius = 4
    ctx.strokeStyle = "#ffffff"
    ctx.lineWidth = 1.2
    ctx.font = "10px sans-serif"
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"

    for (const spawn of projectedSpawns) {
      if (spawn.screenX < -10 || spawn.screenY < -10 || spawn.screenX > width + 10 || spawn.screenY > height + 10) {
        continue
      }
      ctx.fillStyle = spawn.color
      ctx.beginPath()
      ctx.arc(spawn.screenX, spawn.screenY, radius, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()

      const level = Math.round((spawn.levelMin + spawn.levelMax) / 2)
      ctx.strokeStyle = "rgba(0,0,0,0.75)"
      ctx.lineWidth = 2.5
      ctx.strokeText(String(level), spawn.screenX, spawn.screenY - 9)
      ctx.fillStyle = "#ffffff"
      ctx.fillText(String(level), spawn.screenX, spawn.screenY - 9)
      ctx.strokeStyle = "#ffffff"
      ctx.lineWidth = 1.2
    }
  }, [projectedSpawns, projectedMarkPoints, viewport.width, viewport.height, redrawVersion])

  const createAutoRoute = () => {
    const worldCenter = imageToWorld(screenToImage(viewport.width / 2, viewport.height / 2))
    if (!worldCenter) {
      setAutoRouteInfo("需要先完成标定/变换后才能生成路线（让地图能换算世界坐标）。")
      return
    }
    if (densityInfo.points.length === 0) {
      setAutoRouteInfo("当前过滤条件下没有可用的怪物点位。")
      return
    }

    let clusterRadius = autoClusterRadius
    let maxAreaRadius = autoMaxAreaRadius
    let maxStepDistance = autoMaxStepDistance
    let avoidDenseTravelRadius = autoAvoidTravelRadius
    let dirtySupportRadius = Math.max(maxStepDistance * 2, clusterRadius * 4)

    if (autoTuneEnabled) {
      const limit = 8000
      let tunePoints = densityInfo.points
      if (densityInfo.points.length > limit) {
        const stride = Math.ceil(densityInfo.points.length / limit)
        const sampled: SpawnXYZ[] = []
        for (let index = 0; index < densityInfo.points.length; index += stride) {
          sampled.push(densityInfo.points[index])
        }
        tunePoints = sampled
      }

      const tuned = tuneAutoRouteParams(tunePoints, worldCenter, autoMaxWaypoints)
      if (tuned) {
        clusterRadius = Math.max(0, tuned.clusterRadius)
        maxAreaRadius = Math.max(0, tuned.maxAreaRadius)
        maxStepDistance = Math.max(0, tuned.maxStepDistance)
        avoidDenseTravelRadius = Math.max(0, tuned.avoidDenseTravelRadius)
        dirtySupportRadius = Math.max(0, tuned.dirtySupportRadius)

        setAutoClusterRadius(clusterRadius)
        setAutoMaxAreaRadius(maxAreaRadius)
        setAutoMaxStepDistance(maxStepDistance)
        setAutoAvoidTravelRadius(avoidDenseTravelRadius)
      }
    }

    const minSupportCount = 3
    const dirtyCounts = computeNeighborCounts(densityInfo.points, dirtySupportRadius)
    let dirtyIds = new Set<number>()
    for (const point of densityInfo.points) {
      const count = dirtyCounts.get(point.id) ?? 1
      if (count < minSupportCount) dirtyIds.add(point.id)
    }
    let usablePoints = densityInfo.points.filter((point) => !dirtyIds.has(point.id))
    let usedSupportCount = minSupportCount
    if (usablePoints.length < Math.min(densityInfo.points.length, Math.max(60, autoMaxWaypoints * 3))) {
      const relaxedMin = 2
      const relaxedDirtyIds = new Set<number>()
      for (const point of densityInfo.points) {
        const count = dirtyCounts.get(point.id) ?? 1
        if (count < relaxedMin) relaxedDirtyIds.add(point.id)
      }
      const relaxedUsable = densityInfo.points.filter((point) => !relaxedDirtyIds.has(point.id))
      if (relaxedUsable.length >= usablePoints.length) {
        usablePoints = relaxedUsable
        dirtyIds = relaxedDirtyIds
        usedSupportCount = relaxedMin
      }
    }

    const denseCounts = computeNeighborCounts(usablePoints, clusterRadius)
    const denseIds = new Set<number>()
    for (const point of usablePoints) {
      const count = denseCounts.get(point.id) ?? 1
      if (count >= 3) denseIds.add(point.id)
    }

    const result = generateAutoRoute(usablePoints, denseIds, {
      center: worldCenter,
      maxAreaRadius,
      maxStepDistance,
      maxWaypoints: autoMaxWaypoints,
      avoidDenseTravelRadius,
    })

    const createdAt = Date.now()
    const nextMarks: MarkPoint[] = result.route.map((point, index) => ({
      id: createdAt + index,
      name: `自动${index + 1}`,
      center: [point.x, point.y, point.z],
      radius: autoWaypointRadius,
    }))

    setMarkPoints(nextMarks)
    setActiveMarkPointId(nextMarks[0]?.id ?? null)

    const safeCount = usablePoints.length - denseIds.size
    const fmt = (value: number) => (Number.isFinite(value) ? Number(value.toFixed(2)) : value)
    const dirtyText = `脏点过滤：半径=${fmt(dirtySupportRadius)} 最小邻居=${usedSupportCount} 过滤=${dirtyIds.size}/${densityInfo.points.length}，可用=${usablePoints.length}。`
    const paramsText = `参数：密集半径=${fmt(clusterRadius)} 步长=${fmt(maxStepDistance)} 路线半径=${fmt(maxAreaRadius)} 绕开=${fmt(avoidDenseTravelRadius)}。${dirtyText}`

    if (result.route.length === 0) {
      setAutoRouteInfo(
        `未找到可用路线：安全点 ${safeCount}/${usablePoints.length}，区域内安全点 ${result.stats.safeInArea}/${result.stats.inArea}，密集点 ${result.stats.denseInArea}。${paramsText}`,
      )
    } else {
      setAutoRouteInfo(
        `已生成 ${result.stats.picked} 个点位：安全点 ${safeCount}/${usablePoints.length}，区域内安全 ${result.stats.safeInArea}/${result.stats.inArea}，密集 ${result.stats.denseInArea}。${paramsText}`,
      )
    }
  }

  const visibleTiles = useMemo(() => {
    if (!currentMap) return []
    const { tileSize, maxZoom } = currentMap
    const zoomLevel = clamp(Math.round(maxZoom + Math.log2(effectiveScale)), 0, maxZoom)
    const levelScale = 2 ** (zoomLevel - maxZoom)
    const levelWidth = Math.max(1, Math.ceil(currentMap.width * levelScale))
    const levelHeight = Math.max(1, Math.ceil(currentMap.height * levelScale))

    const imageLeft = (0 - viewport.offsetX) / effectiveScale
    const imageTop = (0 - viewport.offsetY) / effectiveScale
    const imageRight = (viewport.width - viewport.offsetX) / effectiveScale
    const imageBottom = (viewport.height - viewport.offsetY) / effectiveScale

    const levelLeft = Math.max(0, imageLeft * levelScale)
    const levelTop = Math.max(0, imageTop * levelScale)
    const levelRight = Math.min(levelWidth, imageRight * levelScale)
    const levelBottom = Math.min(levelHeight, imageBottom * levelScale)

    const minX = Math.max(0, Math.floor(levelLeft / tileSize))
    const minY = Math.max(0, Math.floor(levelTop / tileSize))
    const maxX = Math.floor(levelRight / tileSize)
    const maxY = Math.floor(levelBottom / tileSize)

    const tiles: Array<{ key: string; src: string; style: React.CSSProperties }> = []

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const imageTileX = (x * tileSize) / levelScale
        const imageTileY = (y * tileSize) / levelScale
        const levelTileWidth = Math.min(tileSize, levelWidth - x * tileSize)
        const levelTileHeight = Math.min(tileSize, levelHeight - y * tileSize)
        const imageTileWidth = levelTileWidth / levelScale
        const imageTileHeight = levelTileHeight / levelScale

        tiles.push({
          key: `${currentMap.key}-${zoomLevel}-${x}-${y}`,
          src: `/tiles/${currentMap.key}/${zoomLevel}/${x}_${y}.webp`,
          style: {
            position: "absolute",
            left: viewport.offsetX + imageTileX * effectiveScale,
            top: viewport.offsetY + imageTileY * effectiveScale,
            width: imageTileWidth * effectiveScale,
            height: imageTileHeight * effectiveScale,
            imageRendering: "auto",
            userSelect: "none",
            pointerEvents: "none",
          },
        })
      }
    }

    return tiles
  }, [currentMap, viewport, effectiveScale])

  return (
    <main className="h-screen overflow-hidden bg-background p-6 text-foreground">
      <div className="grid h-full min-h-0 w-full gap-6 grid-cols-[380px_minmax(0,1fr)]">
        <Card className="flex h-full flex-col overflow-hidden">
          <CardHeader className="shrink-0">
            <CardTitle>地图标定控制台（动态瓦片）</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 min-h-0 space-y-4 overflow-y-auto">
            <div className="space-y-2">
              <Label>地图</Label>
              <div className="flex gap-2">
                {maps.map((item) => (
                  <Button
                    key={item.key}
                    variant={imageKey === item.key ? "default" : "outline"}
                    size="sm"
                    onClick={() => {
                      setImageKey(item.key)
                      setPixelA(null)
                      setPixelB(null)
                    }}
                  >
                    {item.key}
                  </Button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label>缩放: {viewport.scale.toFixed(3)}x（相对适配）</Label>
              <Slider
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={0.001}
                value={[viewport.scale]}
                onValueChange={(value) => {
                  const next = clamp(value[0] ?? viewport.scale, MIN_ZOOM, MAX_ZOOM)
                  setViewport((prev) => ({ ...prev, scale: next }))
                }}
              />
              <p className="text-xs text-muted-foreground">仅加载当前视口可见瓦片，而不是整张大图。</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="spawn-file">导入点位 TXT（id,x,y,z,map,faction,level_min,level_max）</Label>
              <Input id="spawn-file" type="file" accept=".txt,.csv,text/plain" onChange={onImportTxt} />
              <p className="text-xs text-muted-foreground">{importInfo}</p>
            </div>

            <div className="space-y-2">
              <Label>3 个 Anchor（可拖拽）</Label>
              <div className="space-y-1 text-xs text-muted-foreground">
                {anchors.map((anchor) => (
                  <p key={anchor.key}>
                    {anchor.key}: ({anchor.x.toFixed(4)}, {anchor.y.toFixed(4)})
                  </p>
                ))}
              </div>
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <Label>点位列表（右键地图添加）</Label>
                <Button size="sm" variant="outline" onClick={copyMarkPoints}>
                  {copied ? "已复制" : "复制导出"}
                </Button>
              </div>
              <div className="max-h-44 space-y-2 overflow-auto">
                {markPoints.length === 0 ? (
                  <p className="text-xs text-muted-foreground">暂无点位，右键地图后点“添加点位”。</p>
                ) : (
                  markPoints.map((point) => (
                    <div
                      key={point.id}
                      className={`grid grid-cols-[1fr_90px_28px] items-center gap-2 rounded p-1 text-xs ${
                        activeMarkPointId === point.id ? "bg-muted" : ""
                      }`}
                      onClick={() => setActiveMarkPointId(point.id)}
                    >
                      <Input
                        value={point.name}
                        onChange={(event) =>
                          setMarkPoints((prev) =>
                            prev.map((item) =>
                              item.id === point.id ? { ...item, name: event.target.value } : item,
                            ),
                          )
                        }
                      />
                      <Input
                        type="number"
                        value={point.radius}
                        onChange={(event) =>
                          setMarkPoints((prev) =>
                            prev.map((item) =>
                              item.id === point.id
                                ? { ...item, radius: Number(event.target.value) || 0 }
                                : item,
                            ),
                          )
                        }
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setMarkPoints((prev) => prev.filter((item) => item.id !== point.id))
                        }
                      >
                        ×
                      </Button>
                    </div>
                  ))
                )}
              </div>
              <textarea
                className="h-28 w-full rounded-md border bg-background p-2 font-mono text-xs"
                readOnly
                value={exportedMarkPoints}
              />
            </div>

            <div className="space-y-2">
              <Label>等级范围过滤</Label>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="level-min">最小等级</Label>
                  <Input
                    id="level-min"
                    type="number"
                    min={1}
                    max={80}
                    step={1}
                    value={levelRange[0]}
                    onChange={(event) => {
                      const nextMin = clamp(Number(event.target.value || 1), 1, 80)
                      setLevelRange(([_, max]) => [Math.min(nextMin, max), max])
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="level-max">最大等级</Label>
                  <Input
                    id="level-max"
                    type="number"
                    min={1}
                    max={80}
                    step={1}
                    value={levelRange[1]}
                    onChange={(event) => {
                      const nextMax = clamp(Number(event.target.value || 80), 1, 80)
                      setLevelRange(([min]) => [min, Math.max(min, nextMax)])
                    }}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">显示与区间有交集的点位（level_min ~ level_max）。</p>
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <Label>自动打怪路线</Label>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant={autoTuneEnabled ? "secondary" : "outline"}
                    onClick={() => setAutoTuneEnabled((value) => !value)}
                  >
                    {autoTuneEnabled ? "自动调参开" : "自动调参关"}
                  </Button>
                  <Button size="sm" onClick={createAutoRoute}>
                    生成路线
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label>密集判定半径</Label>
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    value={autoClusterRadius}
                    onChange={(event) => setAutoClusterRadius(Math.max(0, Number(event.target.value) || 0))}
                  />
                </div>
                <div className="space-y-1">
                  <Label>最大路线半径</Label>
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    value={autoMaxAreaRadius}
                    onChange={(event) => setAutoMaxAreaRadius(Math.max(0, Number(event.target.value) || 0))}
                  />
                </div>
                <div className="space-y-1">
                  <Label>最大步长</Label>
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    value={autoMaxStepDistance}
                    onChange={(event) => setAutoMaxStepDistance(Math.max(0, Number(event.target.value) || 0))}
                  />
                </div>
                <div className="space-y-1">
                  <Label>绕开密集半径</Label>
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    value={autoAvoidTravelRadius}
                    onChange={(event) => setAutoAvoidTravelRadius(Math.max(0, Number(event.target.value) || 0))}
                  />
                </div>
                <div className="space-y-1">
                  <Label>点位数量上限</Label>
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={autoMaxWaypoints}
                    onChange={(event) =>
                      setAutoMaxWaypoints(Math.max(0, Math.floor(Number(event.target.value) || 0)))
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label>点位半径</Label>
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={autoWaypointRadius}
                    onChange={(event) => setAutoWaypointRadius(Math.max(0, Number(event.target.value) || 0))}
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={highlightDenseSpawns ? "default" : "outline"}
                  onClick={() => setHighlightDenseSpawns((value) => !value)}
                >
                  {highlightDenseSpawns ? "已高亮密集点" : "高亮密集点"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setMarkPoints([])}>
                  清空点位
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                目标：在怪尽量多（可串起更多安全点）的前提下避开密集聚落；密集点判定为“密集判定半径”内点位数 ≥ 3；路线中心使用当前视图中心，且每一步不超过“最大步长”。
              </p>
              <p className="text-xs text-muted-foreground">
                当前可用点位：{densityInfo.total}，密集点：{densityInfo.denseCount}。
              </p>
              {autoRouteInfo ? <p className="text-xs text-muted-foreground">{autoRouteInfo}</p> : null}
            </div>

            {currentMap?.key === "kingdoms" ? null : <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>点 A 世界坐标 X</Label>
                <Input type="number" value={worldA.x} onChange={(e) => setWorldA((v) => ({ ...v, x: Number(e.target.value) }))} />
              </div>
              <div className="space-y-2">
                <Label>点 A 世界坐标 Y</Label>
                <Input type="number" value={worldA.y} onChange={(e) => setWorldA((v) => ({ ...v, y: Number(e.target.value) }))} />
              </div>
              <div className="space-y-2">
                <Label>点 B 世界坐标 X</Label>
                <Input type="number" value={worldB.x} onChange={(e) => setWorldB((v) => ({ ...v, x: Number(e.target.value) }))} />
              </div>
              <div className="space-y-2">
                <Label>点 B 世界坐标 Y</Label>
                <Input type="number" value={worldB.y} onChange={(e) => setWorldB((v) => ({ ...v, y: Number(e.target.value) }))} />
              </div>
            </div>}

            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => { setPixelA(null); setPixelB(null) }}>
                清空标定点
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (!currentMap) return
                  const fitScale = clamp(
                    Math.min(viewport.width / currentMap.width, viewport.height / currentMap.height),
                    1e-6,
                    1,
                  )
                  setViewport((prev) => ({
                    ...prev,
                    baseScale: fitScale,
                    scale: 1,
                    offsetX: (prev.width - currentMap.width * fitScale) / 2,
                    offsetY: (prev.height - currentMap.height * fitScale) / 2,
                  }))
                }}
              >
                适配窗口
              </Button>
            </div>

            <div className="space-y-1 text-xs text-muted-foreground">
              <p>{currentMap?.key === "kingdoms" ? "左键拖拽平移；滚轮缩放。" : "左键拖拽平移；滚轮缩放；右键菜单设置 A/B 像素点。"}</p>
              <p>当前地图 map={currentMapId ?? "?"}（kingdoms=0, kalimdor=1）</p>
              <p>{currentMap?.key === "kingdoms" && currentAffine
                ? `kingdoms 已烘焙(A/B/C): a=${currentAffine.a.toFixed(6)} b=${currentAffine.b.toFixed(6)} c=${currentAffine.c.toFixed(2)} d=${currentAffine.d.toFixed(6)} e=${currentAffine.e.toFixed(6)} f=${currentAffine.f.toFixed(2)}`
                : "当前地图使用 A/B 两点完整求解变换"}</p>
              <p>等级色标: 每一级换色，使用 6 种高对比颜色循环。</p>
              {currentMap?.key === "kingdoms" ? null : <p>A 像素: {pixelA ? `${pixelA.x.toFixed(1)}, ${pixelA.y.toFixed(1)}` : "未设置"}</p>}
              {currentMap?.key === "kingdoms" ? null : <p>B 像素: {pixelB ? `${pixelB.x.toFixed(1)}, ${pixelB.y.toFixed(1)}` : "未设置"}</p>}
              <p>
                变换: {calibration ? `scale=${calibration.scale.toFixed(6)} rot=${((calibration.rotationRad * 180) / Math.PI).toFixed(2)}°` : "未完成"}
              </p>
              <p>当前地图已投影点数: {projectedSpawns.length}</p>
            </div>
          </CardContent>
        </Card>

        <Card className="flex h-full min-w-0 flex-col overflow-hidden">
          <CardHeader className="shrink-0">
            <CardTitle>地图视图</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-1 min-h-0 flex-col">
            <div
              ref={viewerRef}
              className="relative flex-1 min-h-0 overflow-hidden rounded-md border bg-black overscroll-none"
              onWheel={onViewerWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
              onContextMenu={onViewerContextMenu}
              onClick={() => setContextMenu((prev) => ({ ...prev, open: false }))}
              style={{ cursor: isPanning ? "grabbing" : "grab" }}
            >
              {visibleTiles.map((tile) => (
                <img key={tile.key} src={tile.src} alt="tile" draggable={false} style={tile.style} />
              ))}
              {anchors.map((anchor) => (
                <button
                  key={anchor.key}
                  type="button"
                  className="absolute z-20 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-blue-600 text-[10px] font-semibold text-white shadow"
                  style={{
                    left: viewport.offsetX + anchor.x * effectiveScale,
                    top: viewport.offsetY + anchor.y * effectiveScale,
                    cursor: "move",
                  }}
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    event.preventDefault()
                    event.currentTarget.setPointerCapture(event.pointerId)
                    setDraggingAnchorKey(anchor.key)
                    setContextMenu((prev) => ({ ...prev, open: false }))
                  }}
                  onContextMenu={(event) => event.preventDefault()}
                  title={`Anchor ${anchor.key}`}
                >
                  {anchor.key}
                </button>
              ))}
              <canvas
                ref={pointsCanvasRef}
                className="absolute inset-0 z-10"
                style={{ pointerEvents: "none" }}
              />
              {projectedMarkPoints.map((point) => (
                <div
                  key={point.id}
                  className={`absolute z-20 -translate-x-1/2 -translate-y-1/2 rounded-full border ${
                    activeMarkPointId === point.id
                      ? "h-4 w-4 border-yellow-300 bg-yellow-500 shadow-[0_0_0_4px_rgba(234,179,8,0.35)]"
                      : "h-3 w-3 border-white bg-emerald-500"
                  }`}
                  style={{ left: point.screenX, top: point.screenY }}
                  title={`${point.name} (${point.center[0].toFixed(2)}, ${point.center[1].toFixed(2)}, ${point.center[2].toFixed(2)})`}
                />
              ))}
              {contextMenu.open ? (
                <div
                  className="absolute z-20 min-w-44 rounded-md border bg-card p-1 text-sm text-card-foreground shadow-lg"
                  style={{ left: contextMenu.x, top: contextMenu.y }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    className="block w-full rounded px-3 py-2 text-left hover:bg-muted"
                    onClick={(event) => {
                      event.stopPropagation()
                      addMarkPointFromContext()
                    }}
                  >
                    添加点位
                  </button>
                  {currentMap?.key === "kingdoms" ? null : (
                    <>
                  <button
                    type="button"
                    className="block w-full rounded px-3 py-2 text-left hover:bg-muted"
                    onClick={(event) => {
                      event.stopPropagation()
                      setCalibrationPoint("A")
                    }}
                  >
                    设置为第一个点 (A)
                  </button>
                  <button
                    type="button"
                    className="block w-full rounded px-3 py-2 text-left hover:bg-muted"
                    onClick={(event) => {
                      event.stopPropagation()
                      setCalibrationPoint("B")
                    }}
                  >
                    设置为第二个点 (B)
                  </button>
                    </>
                  )}
                </div>
              ) : null}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {centerWorld
                ? `视图中心估算世界坐标: (${centerWorld.x.toFixed(2)}, ${centerWorld.y.toFixed(2)})`
                : "完成 A/B 两点标定后，可自动推算任意像素对应世界坐标。"}
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}

export default App
