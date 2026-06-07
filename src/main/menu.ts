// =============================================================================
// Application menu — standard macOS menu bar
// =============================================================================

import { BrowserWindow, Menu, shell, app } from 'electron'
import { MENU_OPEN_SETTINGS, MENU_TRIGGER_ACTION, MENU_LOAD_LAYOUT, MENU_CREATE_PANEL, BROWSER_SHORTCUT } from '../shared/ipc-channels'
import type { MenuActionId, BrowserShortcutAction } from '../shared/types'
import { checkForUpdatesManually } from './auto-updater'
import { listPanelWindows, getWindow, getWindowType, getActiveMainWindow, getWindowWorkspaceId, focusWindow } from './windowRegistry'

/** Panel-creation actions. These add a panel to the workspace's canvas, so they
 *  have nowhere to go in a detached dock/panel window (no canvas there) —
 *  `dispatch` re-routes them to the main window. */
const PANEL_CREATE_ACTIONS = new Set<MenuActionId>(['newTerminal', 'newEditor', 'newBrowser', 'newFile', 'newAgent', 'newCanvas'])

/** Dispatch a renderer-side menu action to the focused window. Items in the
 *  template use this as their click handler — the renderer's useShortcuts hook
 *  listens for MENU_TRIGGER_ACTION and runs the matching action through the
 *  same code path as the keyboard shortcut.
 *
 *  Exception: a panel-creation action fired while a detached dock/panel window
 *  is focused has nowhere to put the new panel. Route it to the workspace's
 *  main window (which owns the canvas) and bring that window forward so the new
 *  panel is visible. Without this, New Terminal/Editor/Browser silently do
 *  nothing whenever focus is outside a main window. */
function dispatch(action: MenuActionId): () => void {
  return (): void => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return
    if (PANEL_CREATE_ACTIONS.has(action) && getWindowType(win.id) !== 'main') {
      const mainWin = getActiveMainWindow()
      if (mainWin) {
        mainWin.webContents.send(MENU_CREATE_PANEL, { action, workspaceId: getWindowWorkspaceId(win.id) })
        focusWindow(mainWin)
        return
      }
    }
    win.webContents.send(MENU_TRIGGER_ACTION, action)
  }
}

/** Dispatch a browser navigation action to the focused window's BrowserPanel.
 *  These items carry no accelerator: the keys (Cmd+R/[/]/L) are handled
 *  panel-locally so they never steal Monaco's Cmd+[ / Cmd+] / Cmd+L. */
function dispatchBrowser(action: BrowserShortcutAction): () => void {
  return (): void => {
    const win = BrowserWindow.getFocusedWindow()
    if (win) win.webContents.send(BROWSER_SHORTCUT, action)
  }
}

/** Tell the focused renderer to load a named saved layout (replacing the workspace). */
function dispatchLoadLayout(name: string): () => void {
  return (): void => {
    const win = BrowserWindow.getFocusedWindow()
    if (win) win.webContents.send(MENU_LOAD_LAYOUT, name)
  }
}

// Saved-layout names, kept in sync by store.ts so the Layouts menu can list
// them. Mutating it triggers a menu rebuild.
let layoutNames: string[] = []
export function setLayoutNames(names: string[]): void {
  layoutNames = names
  buildApplicationMenu()
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
            newMainWindowFn()
          },
        },
        { type: 'separator' },
        { label: 'New File', accelerator: 'CmdOrCtrl+N', click: dispatch('newFile') },
        { label: 'New Editor', accelerator: 'CmdOrCtrl+Shift+E', click: dispatch('newEditor') },
        { label: 'New Terminal', accelerator: 'CmdOrCtrl+T', click: dispatch('newTerminal') },
        { label: 'New Browser', accelerator: 'CmdOrCtrl+Shift+B', click: dispatch('newBrowser') },
        { label: 'New Cate Agent', accelerator: 'CmdOrCtrl+Shift+A', click: dispatch('newAgent') },
        { label: 'New Canvas', accelerator: 'CmdOrCtrl+Shift+C', click: dispatch('newCanvas') },
        { type: 'separator' },
        { label: 'Open Folder...', accelerator: 'CmdOrCtrl+O', click: dispatch('openFolder') },
        { label: 'Reload Workspace from Disk', click: dispatch('reloadWorkspace') },
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
        { label: 'Find in Files...', accelerator: 'CmdOrCtrl+Shift+F', click: dispatch('commandPalette') },
      ],
    },
    // View menu
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette...', accelerator: 'CmdOrCtrl+K', click: dispatch('commandPalette') },
        // VS Code-style aliases for the same unified palette (fuzzy file search +
        // commands). Hidden so they don't clutter the menu but still bind the key.
        { label: 'Go to File...', accelerator: 'CmdOrCtrl+P', click: dispatch('commandPalette'), visible: false, acceleratorWorksWhenHidden: true },
        { label: 'Show All Commands', accelerator: 'CmdOrCtrl+Shift+P', click: dispatch('commandPalette'), visible: false, acceleratorWorksWhenHidden: true },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: dispatch('toggleSidebar') },
        // Secondary sidebar binding (legacy / VS Code split-editor key) kept as an alias.
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', click: dispatch('toggleSidebar'), visible: false, acceleratorWorksWhenHidden: true },
        { label: 'Toggle File Explorer', accelerator: 'CmdOrCtrl+Shift+X', click: dispatch('toggleFileExplorer') },
        { label: 'Toggle Minimap', accelerator: 'CmdOrCtrl+Shift+M', click: dispatch('toggleMinimap') },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: dispatch('zoomIn') },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Shift+=', click: dispatch('zoomIn'), visible: false, acceleratorWorksWhenHidden: true },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: dispatch('zoomIn'), visible: false, acceleratorWorksWhenHidden: true },
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
        { label: 'Node Switcher', accelerator: 'Ctrl+Space', click: dispatch('nodeSwitcher') },
        { type: 'separator' },
        { label: 'Next Panel', accelerator: 'Ctrl+Tab', click: dispatch('focusNext') },
        { label: 'Previous Panel', accelerator: 'Ctrl+Shift+Tab', click: dispatch('focusPrevious') },
      ],
    },
    // Layouts menu — save / manage / load named canvas layouts. The list is
    // populated from store.ts via setLayoutNames().
    {
      label: 'Layouts',
      submenu: [
        { label: 'Save Current Canvas…', click: dispatch('manageLayouts') },
        { label: 'Manage Layouts…', click: dispatch('manageLayouts') },
        ...(layoutNames.length > 0
          ? [
              { type: 'separator' as const },
              ...layoutNames.map((name) => ({ label: name, click: dispatchLoadLayout(name) })),
            ]
          : []),
      ],
    },
    // Browser menu — acts on the focused browser panel. No accelerators: the
    // keys are handled panel-locally so they don't collide with Monaco.
    {
      label: 'Browser',
      submenu: [
        { label: 'Reload (⌘R)', click: dispatchBrowser('reload') },
        { label: 'Force Reload (⌘⇧R)', click: dispatchBrowser('reloadHard') },
        { type: 'separator' },
        { label: 'Back (⌘[)', click: dispatchBrowser('back') },
        { label: 'Forward (⌘])', click: dispatchBrowser('forward') },
        { type: 'separator' },
        { label: 'Focus Address Bar (⌘L)', click: dispatchBrowser('focusUrl') },
      ],
    },
    // Window menu
    {
      label: 'Window',
      submenu: [
        {
          label: 'New Window',
          click: (): void => {
            if (!newMainWindowFn) return
            newMainWindowFn()
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
