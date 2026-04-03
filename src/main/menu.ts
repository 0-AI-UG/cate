// =============================================================================
// Application menu — standard macOS menu bar
// =============================================================================

import { BrowserWindow, Menu, app } from 'electron'
import { MENU_OPEN_SETTINGS } from '../shared/ipc-channels'
import { checkForUpdatesManually } from './auto-updater'
import { listPanelWindows, getWindow } from './windowRegistry'

/** Rebuild the application menu (call when panel windows open/close). */
export function rebuildApplicationMenu(): void {
  buildApplicationMenu()
}

export function buildApplicationMenu(): void {
  // Collect panel window entries for the Window menu
  const panelWindowItems: Electron.MenuItemConstructorOptions[] = []
  try {
    const panelWindows = listPanelWindows()
    for (const pw of panelWindows) {
      panelWindowItems.push({
        label: `${pw.panel.title || pw.panel.type}`,
        click: (): void => {
          const win = getWindow(pw.windowId)
          if (win) {
            win.show()
            win.focus()
          }
        },
      })
    }
  } catch {
    // listPanelWindows may not be available yet during startup
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates...',
          click: (): void => {
            checkForUpdatesManually()
          },
        },
        { type: 'separator' },
        {
          label: 'Preferences...',
          accelerator: 'Cmd+,',
          click: (): void => {
            const win = BrowserWindow.getFocusedWindow()
            if (win) win.webContents.send(MENU_OPEN_SETTINGS)
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    // View menu
    {
      label: 'View',
      submenu: [
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
        { type: 'separator' },
        {
          label: 'Main Window',
          click: (): void => {
            // Focus the first main window
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed()) {
                win.focus()
                break
              }
            }
          },
        },
        ...(panelWindowItems.length > 0
          ? [{ type: 'separator' as const }, ...panelWindowItems]
          : []),
      ],
    },
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}
