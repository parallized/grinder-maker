import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import sharp from "sharp"

const ROOT = process.cwd()
const TILE_SIZE = 512
const WEBP_QUALITY = 70
const CONCURRENCY = Math.max(2, Math.min(12, os.cpus().length))

const MAPS = [
  { key: "kalimdor", input: "kalimdor.png" },
  { key: "kingdoms", input: "kingdoms.png" },
]

const ensureDir = (target) => fs.mkdir(target, { recursive: true })

async function runWithConcurrency(tasks, limit) {
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (tasks.length > 0) {
      const task = tasks.pop()
      if (!task) return
      await task()
    }
  })
  await Promise.all(workers)
}

async function buildMap(map) {
  const startedAt = Date.now()
  const inputPath = path.join(ROOT, map.input)
  const metadata = await sharp(inputPath).metadata()
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (!width || !height) {
    throw new Error(`Invalid size for ${map.input}`)
  }

  const maxDim = Math.max(width, height)
  const maxZoom = Math.ceil(Math.log2(maxDim / TILE_SIZE))
  const outBase = path.join(ROOT, "public", "tiles", map.key)
  await ensureDir(outBase)

  let totalTiles = 0
  for (let z = 0; z <= maxZoom; z += 1) {
    const scale = 2 ** (z - maxZoom)
    const levelWidth = Math.max(1, Math.ceil(width * scale))
    const levelHeight = Math.max(1, Math.ceil(height * scale))
    totalTiles += Math.ceil(levelWidth / TILE_SIZE) * Math.ceil(levelHeight / TILE_SIZE)
  }

  console.log(
    `[${map.key}] start: ${width}x${height}, levels=0..${maxZoom}, tiles=${totalTiles}, concurrency=${CONCURRENCY}, quality=${WEBP_QUALITY}`,
  )

  let generatedTiles = 0

  for (let z = 0; z <= maxZoom; z += 1) {
    const levelStartedAt = Date.now()
    const scale = 2 ** (z - maxZoom)
    const levelWidth = Math.max(1, Math.ceil(width * scale))
    const levelHeight = Math.max(1, Math.ceil(height * scale))

    const levelImage = sharp(inputPath).resize(levelWidth, levelHeight, {
      kernel: "lanczos3",
      fit: "fill",
    })

    const cols = Math.ceil(levelWidth / TILE_SIZE)
    const rows = Math.ceil(levelHeight / TILE_SIZE)
    const levelTiles = cols * rows
    const zDir = path.join(outBase, String(z))
    await ensureDir(zDir)

    console.log(`[${map.key}] z=${z} -> ${cols}x${rows} (${levelTiles} tiles)`)

    let levelDone = 0
    const levelTotal = levelTiles
    let nextLogAt = Math.min(25, levelTotal)
    const tasks = []

    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const left = x * TILE_SIZE
        const top = y * TILE_SIZE
        const tileWidth = Math.min(TILE_SIZE, levelWidth - left)
        const tileHeight = Math.min(TILE_SIZE, levelHeight - top)
        const tilePath = path.join(zDir, `${x}_${y}.webp`)

        tasks.push(async () => {
          await levelImage
            .clone()
            .extract({ left, top, width: tileWidth, height: tileHeight })
            .webp({ quality: WEBP_QUALITY })
            .toFile(tilePath)

          levelDone += 1
          generatedTiles += 1

          if (levelDone >= nextLogAt || levelDone === levelTotal) {
            const pct = ((levelDone / levelTotal) * 100).toFixed(1)
            const totalPct = ((generatedTiles / totalTiles) * 100).toFixed(1)
            console.log(
              `[${map.key}] z=${z} ${levelDone}/${levelTotal} (${pct}%) total ${generatedTiles}/${totalTiles} (${totalPct}%)`,
            )
            nextLogAt = Math.min(levelTotal, nextLogAt + Math.max(25, Math.floor(levelTotal * 0.1)))
          }
        })
      }
    }

    await runWithConcurrency(tasks, CONCURRENCY)
    console.log(`[${map.key}] z=${z} done in ${((Date.now() - levelStartedAt) / 1000).toFixed(1)}s`)
  }

  console.log(`[${map.key}] complete in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)

  return {
    key: map.key,
    src: `/${map.input}`,
    width,
    height,
    tileSize: TILE_SIZE,
    maxZoom,
  }
}

async function main() {
  const allStartedAt = Date.now()
  const maps = []
  for (const map of MAPS) {
    maps.push(await buildMap(map))
  }

  const metaPath = path.join(ROOT, "public", "tiles", "meta.json")
  await fs.writeFile(metaPath, JSON.stringify({ maps }, null, 2), "utf-8")
  console.log(`Generated tiles for ${maps.length} maps -> ${metaPath}`)
  console.log(`All done in ${((Date.now() - allStartedAt) / 1000).toFixed(1)}s`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
