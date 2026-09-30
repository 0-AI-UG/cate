// Screen capture (the `screenCapture` feature): a capture of the calling
// window, and on macOS the user's recent OS screenshots (watched in the
// screenshot folder) for the screenshot button. Saving an annotated shot is
// the workspace's business (its `screenshots/`), so only bytes leave here.

import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { app, BrowserWindow, nativeImage } from 'electron'
import { watch, type FSWatcher } from 'chokidar'
import { createLogger } from '@kernel/log/contract'
import { DESKTOP_CHANNELS as C, type Bounds, type RecentScreenshot } from '../contract'
import { handle } from './ipc'
import type { WindowRegistry } from './windowRegistry'

const log = createLogger('capture')
const run = promisify(execFile)
const MAX_RECENT = 5

interface Shot extends RecentScreenshot { filePath: string; mtime: number }

export function registerCapture(registry: Pick<WindowRegistry, 'broadcast'>): () => void {
  let shots: Shot[] = []
  const publish = () => registry.broadcast(C.recentScreenshotsChanged, [shots.map(({ id, thumbnail }) => ({ id, thumbnail }))])

  handle(C.captureWindow, async (event, rect?: Bounds) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return null
    const valid = rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0
    const image = await event.sender.capturePage(valid ? {
      x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
    } : undefined)
    return image.isEmpty() ? null : new Uint8Array(image.toPNG())
  })
  handle(C.recentScreenshots, () => shots.map(({ id, thumbnail }) => ({ id, thumbnail })))
  handle(C.recentScreenshotRead, (_event, id: unknown) => {
    const shot = shots.find((s) => s.id === id)
    if (!shot) throw new Error('That screenshot is no longer available.')
    const image = nativeImage.createFromPath(shot.filePath)
    if (image.isEmpty()) throw new Error('Could not read the screenshot.')
    return new Uint8Array(image.toPNG())
  })
  handle(C.recentScreenshotDrag, (event, id: unknown) => {
    const shot = shots.find((s) => s.id === id)
    if (!shot) return
    // Drag the real file, so drops work in terminals and other apps too.
    event.sender.startDrag({ file: shot.filePath, icon: nativeImage.createFromDataURL(shot.thumbnail) })
  })

  if (process.platform !== 'darwin') return () => {}

  const startedAt = Date.now()
  let stopped = false
  let directory = ''
  let watcher: FSWatcher | undefined

  const inspect = async (filePath: string) => {
    if (!/\.(png|jpe?g|tiff?|heic|gif|webp)$/i.test(filePath)) return
    try {
      const info = await stat(filePath)
      const newest = shots[0]?.mtime ?? 0
      if (!info.isFile() || info.mtimeMs < startedAt || info.mtimeMs <= newest) return
      // macOS marks screenshots whatever their (localized or custom) name.
      await run('/usr/bin/xattr', ['-p', 'com.apple.metadata:kMDItemIsScreenCapture', filePath], { timeout: 2000 })
      const thumbnail = await nativeImage.createThumbnailFromPath(filePath, { width: 128, height: 128 })
      if (stopped || thumbnail.isEmpty()) return
      shots = [{ id: `${filePath}:${info.mtimeMs}`, filePath, mtime: info.mtimeMs, thumbnail: thumbnail.toDataURL() },
        ...shots.filter((s) => s.filePath !== filePath)].slice(0, MAX_RECENT)
      publish()
    } catch { /* not a screenshot, or gone already */ }
  }

  const refreshDirectory = async () => {
    let next = app.getPath('desktop')
    try {
      const { stdout } = await run('/usr/bin/defaults', ['read', 'com.apple.screencapture', 'location'], { timeout: 2000 })
      const value = stdout.trim()
      if (value) next = value.startsWith('~/') ? path.join(app.getPath('home'), value.slice(2)) : value
    } catch { /* default: the Desktop */ }
    if (stopped || !path.isAbsolute(next) || next === directory) return
    directory = next
    await watcher?.close()
    if (stopped) return
    watcher = watch(directory, { depth: 0, ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 } })
    watcher.on('add', (file) => { void inspect(file) })
    watcher.on('change', (file) => { void inspect(file) })
    watcher.on('unlink', (file) => {
      if (!shots.some((s) => s.filePath === file)) return
      shots = shots.filter((s) => s.filePath !== file)
      publish()
    })
    watcher.on('error', (error) => log.warn('cannot watch the screenshot folder: %O', error))
  }
  void refreshDirectory()
  const timer = setInterval(() => { void refreshDirectory() }, 5000)
  return () => {
    stopped = true
    clearInterval(timer)
    void watcher?.close()
  }
}
