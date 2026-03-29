import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } from 'electron'
import path from 'path'
import { WINDOW_DETACH_PANEL, WINDOW_REATTACH_PANEL, WINDOW_DETACHED_CLOSED, SHELL_SHOW_IN_FOLDER, HTTP_FETCH } from '../shared/ipc-channels'
import { registerHandlers as registerTerminalHandlers, flushAllLoggers } from './ipc/terminal'
import { registerHandlers as registerFilesystemHandlers } from './ipc/filesystem'
import { registerHandlers as registerGitHandlers } from './ipc/git'
import { registerHandlers as registerShellHandlers } from './ipc/shell'
import { registerHandlers as registerGitMonitorHandlers } from './ipc/git-monitor'
import { registerHandlers as registerStoreHandlers } from './store'
import { registerHandlers as registerMCPHandlers } from './ipc/mcp'
import { buildApplicationMenu } from './menu'

let mainWindow: BrowserWindow | null = null

// Track detached windows: windowId -> { panelId, panelType }
const detachedWindows = new Map<number, { panelId: string; panelType: string }>()

function createWindow(): void {
  const iconPath = path.join(__dirname, '../../build/icon-1024.png')

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'CanvasIDE',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1E1E24',
    icon: nativeImage.createFromPath(iconPath),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }


  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Register all IPC handlers with mainWindow reference
  registerTerminalHandlers(mainWindow)
  registerFilesystemHandlers(mainWindow)
  registerGitHandlers()
  registerShellHandlers(mainWindow)
  registerGitMonitorHandlers(mainWindow)
  registerStoreHandlers()
  registerMCPHandlers(mainWindow)
}

// Shell: Reveal in Finder
ipcMain.handle(SHELL_SHOW_IN_FOLDER, async (_event, filePath: string) => {
  shell.showItemInFolder(filePath)
})

// HTTP: Fetch from main process (no CORS)
ipcMain.handle(HTTP_FETCH, async (_event, url: string): Promise<{ ok: boolean; status: number; text: string }> => {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'CanvasIDE/1.0' },
    })
    clearTimeout(timeout)
    const text = await res.text()
    return { ok: res.ok, status: res.status, text }
  } catch (err: any) {
    return { ok: false, status: 0, text: err.message || 'Fetch failed' }
  }
})

// Window: Detach Panel (Task 23: Multi-Window Support)
ipcMain.handle(WINDOW_DETACH_PANEL, async (_event, options: {
  panelId: string
  panelType: string
  title: string
  width: number
  height: number
}) => {
  const detachedWindow = new BrowserWindow({
    width: options.width,
    height: options.height,
    title: options.title,
    backgroundColor: '#1E1E24',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  })

  const params = new URLSearchParams({
    detached: 'true',
    panelId: options.panelId,
    panelType: options.panelType,
    title: options.title,
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    detachedWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${params.toString()}`)
  } else {
    detachedWindow.loadFile(path.join(__dirname, '../renderer/index.html'), {
      query: Object.fromEntries(params),
    })
  }

  detachedWindows.set(detachedWindow.id, { panelId: options.panelId, panelType: options.panelType })

  // Notify main window when detached window closes
  detachedWindow.on('closed', () => {
    const info = detachedWindows.get(detachedWindow.id)
    detachedWindows.delete(detachedWindow.id)
    if (mainWindow && !mainWindow.isDestroyed() && info) {
      mainWindow.webContents.send(WINDOW_DETACHED_CLOSED, {
        windowId: detachedWindow.id,
        panelId: info.panelId,
      })
    }
  })

  return detachedWindow.id
})

// Window: Reattach Panel
ipcMain.handle(WINDOW_REATTACH_PANEL, async (_event, windowId: number) => {
  const win = BrowserWindow.fromId(windowId)
  if (win && !win.isDestroyed()) {
    win.close()
  }
})

// Dialog handlers
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose Project Folder',
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('dialog:saveFile', async (_event, options: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) => {
  const result = await dialog.showSaveDialog({
    defaultPath: options.defaultPath,
    filters: options.filters || [{ name: 'JSON', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePath) return null
  return result.filePath
})

// Capture page screenshot for panel previews
ipcMain.handle('capture-page', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  const image = await mainWindow.webContents.capturePage()
  return image.toDataURL()
})

// Set app name before menu and window creation
app.setName('CanvasIDE')

// Build application menu
buildApplicationMenu()

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('before-quit', () => {
  // Flush all terminal loggers so scrollback is persisted to disk
  flushAllLoggers()
})
