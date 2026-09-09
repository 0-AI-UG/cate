import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { stat } from 'node:fs/promises'
import { watch, type FSWatcher } from 'chokidar'
import type { RecentScreenshot } from '../../shared/recentScreenshot'
import { RECENT_SCREENSHOT_GET, RECENT_SCREENSHOT_CHANGED, RECENT_SCREENSHOT_DRAG } from '../../shared/ipc-channels'
import { broadcastToAll, windowFromEvent } from '../windowRegistry'
import { grantFileAccess } from './pathValidation'
import { wrapHandler } from './handlerError'
import log from '../logger'

const run = promisify(execFile)

export function registerRecentScreenshotHandlers(): void {
  let current: RecentScreenshot[] = []
  let watcher: FSWatcher | undefined
  let stopped = false
  let directory = ''
  let newestMtime = 0
  const startedAt = Date.now()

  ipcMain.handle(RECENT_SCREENSHOT_GET, wrapHandler('[recentScreenshot:get]', async (event) => {
    const win = windowFromEvent(event)
    if (!win) return []
    await Promise.all(current.map(screenshot => grantFileAccess(win.id, screenshot.filePath)))
    return current
  }))
  ipcMain.handle(RECENT_SCREENSHOT_DRAG, wrapHandler('[recentScreenshot:drag]', async (event, id: string) => {
    const screenshot = current.find(screenshot => screenshot.id === id)
    if (!windowFromEvent(event) || !screenshot) return
    // Export the actual file, so native file drops work in terminals, panels,
    // and other applications. Keep the shortcut available even when a drag is cancelled.
    event.sender.startDrag({
      file: screenshot.filePath,
      icon: nativeImage.createFromDataURL(screenshot.dataUrl),
    })
  }))

  if (process.platform !== 'darwin') return

  const inspect = async (filePath: string) => {
    if (!/\.(png|jpe?g|tiff?|heic|gif|webp)$/i.test(filePath)) return
    try {
      const info = await stat(filePath)
      if (!info.isFile() || info.mtimeMs < startedAt || info.mtimeMs <= newestMtime) return
      // macOS marks screenshots independently of their localized/custom name.
      await run('/usr/bin/xattr', ['-p', 'com.apple.metadata:kMDItemIsScreenCapture', filePath], { timeout: 2000 })
      const thumbnail = await nativeImage.createThumbnailFromPath(filePath, { width: 128, height: 128 })
      if (stopped || thumbnail.isEmpty() || info.mtimeMs <= newestMtime) return
      await Promise.all(BrowserWindow.getAllWindows().map(win => grantFileAccess(win.id, filePath)))
      if (stopped || info.mtimeMs <= newestMtime) return
      newestMtime = info.mtimeMs
      current = [{ id: `${filePath}:${info.mtimeMs}`, filePath, dataUrl: thumbnail.toDataURL() },
        ...current.filter(screenshot => screenshot.filePath !== filePath)].slice(0, 5)
      broadcastToAll(RECENT_SCREENSHOT_CHANGED, current)
    } catch {
      // Ordinary images have no screenshot attribute; files may also disappear
      // before inspection when the user moves or deletes them.
    }
  }

  const refreshDirectory = async () => {
    let next = app.getPath('desktop')
    try {
      const { stdout } = await run('/usr/bin/defaults', ['read', 'com.apple.screencapture', 'location'], { timeout: 2000 })
      const value = stdout.trim()
      if (value) next = value.startsWith('~/') ? path.join(app.getPath('home'), value.slice(2)) : value
    } catch { /* No custom location: macOS defaults to Desktop. */ }
    if (stopped || !path.isAbsolute(next) || next === directory) return
    directory = next
    await watcher?.close()
    if (stopped) return
    watcher = watch(directory, { depth: 0, ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 } })
    watcher.on('add', filePath => { void inspect(filePath) })
    watcher.on('change', filePath => { void inspect(filePath) })
    watcher.on('unlink', filePath => {
      if (!current.some(screenshot => screenshot.filePath === filePath)) return
      current = current.filter(screenshot => screenshot.filePath !== filePath)
      broadcastToAll(RECENT_SCREENSHOT_CHANGED, current)
    })
    watcher.on('error', error => log.warn('[recentScreenshot] Cannot watch screenshot folder', error))
  }
  void refreshDirectory()
  const refresh = setInterval(() => { void refreshDirectory() }, 5000)
  app.on('will-quit', () => {
    stopped = true
    clearInterval(refresh)
    void watcher?.close()
  })
}
