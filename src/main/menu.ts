// =============================================================================
// Application menu — standard macOS menu bar
// =============================================================================

import { BrowserWindow, Menu, shell, app } from 'electron'
import { MENU_OPEN_SETTINGS, MENU_TRIGGER_ACTION } from '../shared/ipc-channels'
import type { MenuActionId } from '../shared/types'
import { checkForUpdatesManually } from './auto-updater'
import { listPanelWindows, getWindow, getWindowType } from './windowRegistry'

/** Dispatch a renderer-side menu action to the focused window. Items in the
 *  template use this as their click handler — the renderer's useShortcuts hook
 *  listens for MENU_TRIGGER_ACTION and runs the matching action through the
 *  same code path as the keyboard shortcut. */
function dispatch(action: MenuActionId): () => void {
  return (): void => {
    const win = BrowserWindow.getFocusedWindow()
    if (win) win.webContents.send(MENU_TRIGGER_ACTION, action)
  }
}

// Injected from main/index.ts to avoid a circular import. The menu's
// "New Window" item calls this to spawn another main window.
let newMainWindowFn: (() => BrowserWindow) | null = null
export function setNewMainWindowFn(fn: () => BrowserWindow): void {
  newMainWindowFn = fn
}

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
    // File menu
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: (): void => {
            if (!newMainWindowFn) return
            const focused = BrowserWindow.getFocusedWindow()
            const isMainFocused = focused && getWindowType(focused.id) === 'main'
            const newWin = newMainWindowFn()
            // On macOS, explicitly tab the new window onto the focused main
            // window so tabbing happens regardless of the system "Prefer tabs"
            // setting. Safe no-op when tabbingIdentifier is unset.
            if (process.platform === 'darwin' && isMainFocused && focused && !focused.isDestroyed()) {
              try { focused.addTabbedWindow(newWin) } catch { /* noop */ }
            }
          },
        },
        { type: 'separator' },
        { label: 'New Editor', accelerator: 'CmdOrCtrl+Shift+E', click: dispatch('newEditor') },
        { label: 'New Terminal', accelerator: 'CmdOrCtrl+T', click: dispatch('newTerminal') },
        { label: 'New Browser', accelerator: 'CmdOrCtrl+Shift+B', click: dispatch('newBrowser') },
        { type: 'separator' },
        { label: 'Open Folder...', accelerator: 'CmdOrCtrl+O', click: dispatch('openFolder') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: dispatch('saveFile') },
        { type: 'separator' },
        { label: 'Close Panel', accelerator: 'CmdOrCtrl+W', click: dispatch('closePanel') },
        { role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' },
      ],
    },
    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: dispatch('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: dispatch('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in Files...', accelerator: 'CmdOrCtrl+Shift+H', click: dispatch('globalSearch') },
      ],
    },
    // View menu
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette...', accelerator: 'CmdOrCtrl+K', click: dispatch('commandPalette') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', click: dispatch('toggleSidebar') },
        { label: 'Toggle File Explorer', accelerator: 'CmdOrCtrl+Shift+F', click: dispatch('toggleFileExplorer') },
        { label: 'Toggle Minimap', accelerator: 'CmdOrCtrl+Shift+M', click: dispatch('toggleMinimap') },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: dispatch('zoomIn') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: dispatch('zoomOut') },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: dispatch('zoomReset') },
        { label: 'Zoom to Fit', accelerator: 'CmdOrCtrl+1', click: dispatch('zoomToFit') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
      ],
    },
    // Go menu
    {
      label: 'Go',
      submenu: [
        { label: 'Panel Switcher', accelerator: 'CmdOrCtrl+E', click: dispatch('panelSwitcher') },
        { label: 'Node Switcher', accelerator: 'Ctrl+Space', click: dispatch('nodeSwitcher') },
        { type: 'separator' },
        { label: 'Next Panel', accelerator: 'Ctrl+Tab', click: dispatch('focusNext') },
        { label: 'Previous Panel', accelerator: 'Ctrl+Shift+Tab', click: dispatch('focusPrevious') },
      ],
    },
    // Window menu
    {
      label: 'Window',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: (): void => {
            if (!newMainWindowFn) return
            const focused = BrowserWindow.getFocusedWindow()
            const isMainFocused = focused && getWindowType(focused.id) === 'main'
            const newWin = newMainWindowFn()
            if (process.platform === 'darwin' && isMainFocused && focused && !focused.isDestroyed()) {
              try { focused.addTabbedWindow(newWin) } catch { /* noop */ }
            }
          },
        },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        {
          label: 'Main Window',
          click: (): void => {
            for (const win of BrowserWindow.getAllWindows()) {
              if (win.isDestroyed()) continue
              if (getWindowType(win.id) === 'main') {
                win.show()
                win.focus()
                return
              }
            }
          },
        },
        ...(panelWindowItems.length > 0
          ? [{ type: 'separator' as const }, ...panelWindowItems]
          : []),
      ],
    },
    // Help menu
    {
      label: 'Help',
      role: 'help',
      submenu: [
        {
          label: 'Cate Documentation',
          click: (): void => {
            shell.openExternal('https://github.com/0-AI-UG/cate')
          },
        },
        {
          label: 'Report Issue...',
          click: (): void => {
            shell.openExternal('https://github.com/0-AI-UG/cate/issues')
          },
        },
        { type: 'separator' },
        {
          label: 'Check for Updates...',
          click: (): void => {
            checkForUpdatesManually()
          },
        },
        { role: 'toggleDevTools' },
      ],
    },
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}
