// Screen capture (the `screenCapture` feature): a capture of the calling
// window, and on macOS the user's recent OS screenshots (watched in the
// screenshot folder) for the screenshot button. Saving an annotated shot is
// the workspace's business (its `screenshots/`): the renderer stores it there
// and hands its ref here, so the one recent list reaches every window.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { app, BrowserWindow, nativeImage } from 'electron'
import { watch, type FSWatcher } from 'chokidar'
import { createLogger } from '@kernel/log/contract'
import type { FileRef } from '@workspace/files/contract'
import { DESKTOP_CHANNELS as C, type Bounds, type RecentScreenshot } from '../contract'
import { handle } from './ipc'
import type { WindowRegistry } from './windowRegistry'

const log = createLogger('capture')
const run = promisify(execFile)
const MAX_RECENT = 5
const THUMBNAIL = 128

const isFileRef = (value: unknown): value is FileRef =>
  !!value && typeof (value as FileRef).workspaceId === 'string' && typeof (value as FileRef).path === 'string'

/** An OS capture has its `filePath`; an annotated copy has its `ref` and no
 *  file on this device. */
interface Shot extends RecentScreenshot { filePath: string; mtime: number }

export function registerCapture(registry: Pick<WindowRegistry, 'broadcast'>): () => void {
  let shots: Shot[] = []
  const listed = () => shots.map(({ id, thumbnail, ref }): RecentScreenshot => (ref ? { id, thumbnail, ref } : { id, thumbnail }))
  const publish = () => registry.broadcast(C.recentScreenshotsChanged, [listed()])

  handle(C.captureWindow, async (event, rect?: Bounds) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return null
    const valid = rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0
    const image = await event.sender.capturePage(valid ? {
      x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
    } : undefined)
    return image.isEmpty() ? null : new Uint8Array(image.toPNG())
  })
  handle(C.recentScreenshots, listed)
  handle(C.recentScreenshotRead, (_event, id: unknown) => {
    const shot = shots.find((s) => s.id === id && !s.ref)
    if (!shot) throw new Error('That screenshot is no longer available.')
    const image = nativeImage.createFromPath(shot.filePath)
    if (image.isEmpty()) throw new Error('Could not read the screenshot.')
    return new Uint8Array(image.toPNG())
  })
  handle(C.recentScreenshotDrag, (event, id: unknown) => {
    const shot = shots.find((s) => s.id === id && !s.ref)
    if (!shot) return
    // Drag the real file, so drops work in terminals and other apps too.
    event.sender.startDrag({ file: shot.filePath, icon: nativeImage.createFromDataURL(shot.thumbnail) })
  })
  handle(C.recentScreenshotAddAnnotated, (_event, ref: unknown, png: unknown) => {
    if (!isFileRef(ref) || !(png instanceof Uint8Array)) throw new Error('Expected a file ref and PNG bytes.')
    const image = nativeImage.createFromBuffer(Buffer.from(png))
    if (image.isEmpty()) throw new Error('Could not read the annotated image.')
    const { width, height } = image.getSize()
    const thumbnail = image.resize(width >= height ? { width: THUMBNAIL } : { height: THUMBNAIL }).toDataURL()
    const shot: Shot = { id: `annotated:${randomUUID()}`, thumbnail, ref: { workspaceId: ref.workspaceId, path: ref.path }, filePath: '', mtime: Date.now() }
    shots = [shot, ...shots].slice(0, MAX_RECENT)
    publish()
    return { id: shot.id, thumbnail, ref: shot.ref }
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
      const newest = shots.find((s) => !s.ref)?.mtime ?? 0
      if (!info.isFile() || info.mtimeMs < startedAt || info.mtimeMs <= newest) return
      // macOS marks screenshots whatever their (localized or custom) name.
      await run('/usr/bin/xattr', ['-p', 'com.apple.metadata:kMDItemIsScreenCapture', filePath], { timeout: 2000 })
      const thumbnail = await nativeImage.createThumbnailFromPath(filePath, { width: THUMBNAIL, height: THUMBNAIL })
      if (stopped || thumbnail.isEmpty()) return
      shots = [{ id: `${filePath}:${info.mtimeMs}`, filePath, mtime: info.mtimeMs, thumbnail: thumbnail.toDataURL() },
        ...shots.filter((s) => s.ref || s.filePath !== filePath)].slice(0, MAX_RECENT)
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
      if (!shots.some((s) => !s.ref && s.filePath === file)) return
      shots = shots.filter((s) => s.ref || s.filePath !== file)
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
