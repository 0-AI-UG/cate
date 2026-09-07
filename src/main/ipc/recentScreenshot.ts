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
  let current: RecentScreenshot | null = null
  let expiry: ReturnType<typeof setTimeout> | undefined
  let watcher: FSWatcher | undefined
  let stopped = false
  let directory = ''
  let newestMtime = 0
  const startedAt = Date.now()

  const clear = () => {
    clearTimeout(expiry)
    current = null
    broadcastToAll(RECENT_SCREENSHOT_CHANGED, null)
  }
  const getCurrent = () => {
    if (current && current.expiresAt <= Date.now()) clear()
    return current
  }

  ipcMain.handle(RECENT_SCREENSHOT_GET, wrapHandler('[recentScreenshot:get]', async (event) => {
    const screenshot = getCurrent()
    const win = windowFromEvent(event)
    if (!win || !screenshot) return null
    await grantFileAccess(win.id, screenshot.filePath)
    return getCurrent()?.id === screenshot.id ? screenshot : null
  }))
  ipcMain.handle(RECENT_SCREENSHOT_DRAG, wrapHandler('[recentScreenshot:drag]', async (event, id: string) => {
    const screenshot = getCurrent()
    if (!windowFromEvent(event) || !screenshot || screenshot.id !== id) return
    // Export the actual file, so native file drops work in terminals, panels,
    // and other applications. Consuming the shortcut never deletes the file.
    event.sender.startDrag({
      file: screenshot.filePath,
      icon: nativeImage.createFromDataURL(screenshot.dataUrl),
    })
    if (current?.id === id) clear()
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
      clearTimeout(expiry)
      current = { id: `${filePath}:${info.mtimeMs}`, filePath, dataUrl: thumbnail.toDataURL(), expiresAt: Date.now() + 60_000 }
      broadcastToAll(RECENT_SCREENSHOT_CHANGED, current)
      expiry = setTimeout(clear, 60_000)
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
    watcher.on('unlink', filePath => { if (current?.filePath === filePath) clear() })
    watcher.on('error', error => log.warn('[recentScreenshot] Cannot watch screenshot folder', error))
  }
  void refreshDirectory()
  const refresh = setInterval(() => { void refreshDirectory() }, 5000)
  app.on('will-quit', () => {
    stopped = true
    clearInterval(refresh)
    clearTimeout(expiry)
    void watcher?.close()
  })
}
