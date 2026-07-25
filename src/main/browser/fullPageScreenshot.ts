import { nativeImage, type WebContents } from 'electron'

interface PageMetrics {
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  scrollX: number
  scrollY: number
}

interface ScreenshotTile {
  bitmap: Buffer
  width: number
  height: number
  x: number
  y: number
}

const PAGE_METRICS_SCRIPT = `(() => {
  const root = document.documentElement
  const body = document.body
  return {
    width: Math.max(root?.scrollWidth ?? 0, root?.clientWidth ?? 0, body?.scrollWidth ?? 0),
    height: Math.max(root?.scrollHeight ?? 0, root?.clientHeight ?? 0, body?.scrollHeight ?? 0),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  }
})()`

function scrollScript(x: number, y: number): string {
  return `(() => {
    window.scrollTo(${x}, ${y})
    return { x: window.scrollX, y: window.scrollY }
  })()`
}

async function scrollAndSettle(
  wc: WebContents,
  x: number,
  y: number,
): Promise<{ x: number; y: number }> {
  const position = await wc.executeJavaScript(scrollScript(x, y), true) as { x: number; y: number }
  // Force a compositor update and yield two frame intervals in the main
  // process. Guest rAF/timers may be throttled when its panel is in the
  // background, so waiting inside page JavaScript is not reliable here.
  wc.invalidate()
  await new Promise<void>((resolve) => setTimeout(resolve, 32))
  return position
}

function offsets(total: number, viewport: number): number[] {
  const result: number[] = []
  for (let offset = 0; offset < total; offset += viewport) result.push(offset)
  return result
}

export function stitchScreenshotTiles(
  tiles: ScreenshotTile[],
  width: number,
  height: number,
): Buffer {
  const output = Buffer.alloc(width * height * 4)
  for (const tile of tiles) {
    const copyWidth = Math.min(tile.width, width - tile.x)
    const copyHeight = Math.min(tile.height, height - tile.y)
    if (copyWidth <= 0 || copyHeight <= 0) continue
    for (let row = 0; row < copyHeight; row += 1) {
      const sourceStart = row * tile.width * 4
      const targetStart = ((tile.y + row) * width + tile.x) * 4
      tile.bitmap.copy(output, targetStart, sourceStart, sourceStart + copyWidth * 4)
    }
  }
  return output
}

/**
 * Capture the real painted viewport at each scroll position and stitch the
 * tiles. Chromium can return stale surface tiles when one
 * captureBeyondViewport screenshot is requested from a webview guest.
 */
export async function captureFullPageScreenshot(wc: WebContents): Promise<Buffer> {
  const metrics = await wc.executeJavaScript(PAGE_METRICS_SCRIPT, true) as PageMetrics
  if (
    !Number.isFinite(metrics.width)
    || !Number.isFinite(metrics.height)
    || !Number.isFinite(metrics.viewportWidth)
    || !Number.isFinite(metrics.viewportHeight)
    || metrics.width <= 0
    || metrics.height <= 0
    || metrics.viewportWidth <= 0
    || metrics.viewportHeight <= 0
  ) {
    throw new Error('invalid-page-metrics')
  }

  const tiles: ScreenshotTile[] = []
  const capturedPositions = new Set<string>()
  let outputWidth = 0
  let outputHeight = 0
  let scaleX = 1
  let scaleY = 1

  try {
    for (const requestedY of offsets(metrics.height, metrics.viewportHeight)) {
      for (const requestedX of offsets(metrics.width, metrics.viewportWidth)) {
        const position = await scrollAndSettle(wc, requestedX, requestedY)
        const key = `${position.x}:${position.y}`
        if (capturedPositions.has(key)) continue
        capturedPositions.add(key)

        const { data } = await wc.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: false,
        }) as { data: string }
        const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
        if (image.isEmpty()) throw new Error('capture-empty')
        const size = image.getSize()
        if (tiles.length === 0) {
          scaleX = size.width / metrics.viewportWidth
          scaleY = size.height / metrics.viewportHeight
          outputWidth = Math.ceil(metrics.width * scaleX)
          outputHeight = Math.ceil(metrics.height * scaleY)
        }
        tiles.push({
          bitmap: image.toBitmap(),
          width: size.width,
          height: size.height,
          x: Math.round(position.x * scaleX),
          y: Math.round(position.y * scaleY),
        })
      }
    }
  } finally {
    await scrollAndSettle(wc, metrics.scrollX, metrics.scrollY)
  }

  if (tiles.length === 0 || outputWidth <= 0 || outputHeight <= 0) {
    throw new Error('capture-empty')
  }
  const bitmap = stitchScreenshotTiles(tiles, outputWidth, outputHeight)
  return nativeImage.createFromBitmap(bitmap, { width: outputWidth, height: outputHeight }).toPNG()
}
