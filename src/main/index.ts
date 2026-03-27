import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'path'
import { registerHandlers as registerTerminalHandlers } from './ipc/terminal'
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

// Dialog handlers
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Choose Project Folder',
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
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
  // Placeholder for session save on quit
  // The renderer should trigger SESSION_SAVE before the window closes
})
