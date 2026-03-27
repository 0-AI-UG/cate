import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'path'
import { WINDOW_DETACH_PANEL } from '../shared/ipc-channels'
import { registerHandlers as registerTerminalHandlers, flushAllLoggers } from './ipc/terminal'
import { registerHandlers as registerFilesystemHandlers } from './ipc/filesystem'
import { registerHandlers as registerGitHandlers } from './ipc/git'
import { registerHandlers as registerShellHandlers } from './ipc/shell'
import { registerHandlers as registerGitMonitorHandlers } from './ipc/git-monitor'
import { registerHandlers as registerStoreHandlers } from './store'
import { buildApplicationMenu } from './menu'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1E1E24',
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

  // Debug: open DevTools to see console errors
  mainWindow.webContents.openDevTools()

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
}

// Window: Detach Panel (Task 23: Multi-Window Support scaffold)
ipcMain.handle(WINDOW_DETACH_PANEL, async (_event, options: { title: string; width: number; height: number }) => {
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

  if (process.env.ELECTRON_RENDERER_URL) {
    detachedWindow.loadURL(process.env.ELECTRON_RENDERER_URL + '?detached=true')
  } else {
    detachedWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return detachedWindow.id
})

// Dialog handlers
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
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
