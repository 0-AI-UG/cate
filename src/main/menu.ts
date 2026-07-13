// =============================================================================
// Application menu — standard macOS menu bar
// =============================================================================

import { BrowserWindow, Menu, shell, app } from 'electron'
import { MENU_OPEN_SETTINGS, MENU_TRIGGER_ACTION, MENU_LOAD_LAYOUT, BROWSER_SHORTCUT } from '../shared/ipc-channels'
import {
  SHORTCUT_DISPLAY_NAMES,
  resolveShortcuts,
  type MenuActionId,
  type BrowserShortcutAction,
  type ShortcutAction,
  type StoredShortcut,
} from '../shared/types'
import { checkForUpdatesManually } from './auto-updater'
import { getActiveMainWindow, getFocusedWindow, sendToWindow } from './windowRegistry'
import { getSetting } from './settingsFile'

function shortcutAccelerator(shortcut: StoredShortcut): string | undefined {
  if (!shortcut.key) return undefined
  const parts: string[] = []
  if (shortcut.command) parts.push('CmdOrCtrl')
  if (shortcut.control) parts.push('Ctrl')
  if (shortcut.option) parts.push('Alt')
  if (shortcut.shift) parts.push('Shift')
  const key = ({ '\t': 'Tab', '\r': 'Enter', ' ': 'Space', '↑': 'Up', '↓': 'Down', '←': 'Left', '→': 'Right' } as Record<string, string>)[shortcut.key] ?? shortcut.key
  return [...parts, key].join('+')
}

function actionMeta(action: ShortcutAction): { label: string; accelerator?: string } {
  return {
    label: SHORTCUT_DISPLAY_NAMES[action],
    accelerator: shortcutAccelerator(resolveShortcuts(getSetting('customShortcuts'))[action]),
  }
}

/** Dispatch a renderer-side menu action to the focused window. Items in the
 *  template use this as their click handler — the renderer's useShortcuts hook
 *  listens for MENU_TRIGGER_ACTION and runs the matching action through the
 *  same code path as the keyboard shortcut. Dock windows DO have a container,
 *  so they receive MENU_TRIGGER_ACTION and place the panel locally via the same
 *  renderer placement path as the keyboard shortcut. */
function dispatch(action: MenuActionId): () => void {
  return (): void => {
    const win = getFocusedWindow()
    if (!win) return
    sendToWindow(win.id, MENU_TRIGGER_ACTION, action)
  }
}

/** Dispatch a browser navigation action to the focused window's BrowserPanel.
 *  These items carry no accelerator: the keys (Cmd+R/[/]/L) are handled
 *  panel-locally so they never steal Monaco's Cmd+[ / Cmd+] / Cmd+L. */
function dispatchBrowser(action: BrowserShortcutAction): () => void {
  return (): void => {
    const win = getFocusedWindow()
    if (win) sendToWindow(win.id, BROWSER_SHORTCUT, action)
  }
}

/** Tell the focused renderer to load a named saved layout (replacing the workspace). */
function dispatchLoadLayout(name: string): () => void {
  return (): void => {
    const win = getFocusedWindow()
    if (win) sendToWindow(win.id, MENU_LOAD_LAYOUT, name)
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

// The live application menu, kept so the frameless Windows/Linux title bar can
// render its top-level labels and pop the matching native submenus. Reassigned
// on every buildApplicationMenu() so dynamic submenus (layout names, open panel
// windows) stay current without the renderer re-fetching anything.
let currentMenu: Electron.Menu | null = null

/** Ordered top-level menu labels (App, File, Edit, …) for the custom menu bar.
 *  Empty until the first buildApplicationMenu(). */
export function getMenuBarLabels(): string[] {
  if (!currentMenu) return []
  return currentMenu.items.map((item) => item.label)
}

/** Pop the native submenu of top-level item `index` for `win`, anchored at the
 *  window-relative point (x, y) — directly below its label in the title bar.
 *  Always reads the live menu, so dynamic submenus are fresh. */
export function popupMenuBarItem(index: number, win: BrowserWindow, x: number, y: number): void {
  const item = currentMenu?.items[index]
  if (item?.submenu) item.submenu.popup({ window: win, x, y })
}

export function buildApplicationMenu(): void {
  const newWindow = (): void => {
    if (!newMainWindowFn) return
    newMainWindowFn()
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
            const win = getFocusedWindow()
            if (win) sendToWindow(win.id, MENU_OPEN_SETTINGS)
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
          click: newWindow,
        },
        { type: 'separator' },
        { ...actionMeta('newFile'), click: dispatch('newFile') },
        { ...actionMeta('newEditor'), click: dispatch('newEditor') },
        { ...actionMeta('newTerminal'), click: dispatch('newTerminal') },
        { ...actionMeta('newBrowser'), click: dispatch('newBrowser') },
        { ...actionMeta('newAgent'), click: dispatch('newAgent') },
        { ...actionMeta('newCanvas'), click: dispatch('newCanvas') },
        { type: 'separator' },
        { label: 'Open Folder...', accelerator: 'CmdOrCtrl+O', click: dispatch('openFolder') },
        { label: 'Reload Workspace from Disk', click: dispatch('reloadWorkspace') },
        { type: 'separator' },
        { ...actionMeta('saveFile'), label: 'Save', click: dispatch('saveFile') },
        { type: 'separator' },
        { ...actionMeta('closePanel'), click: dispatch('closePanel') },
        { role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' },
      ],
    },
    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { ...actionMeta('undo'), click: dispatch('undo') },
        { ...actionMeta('redo'), click: dispatch('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        { ...actionMeta('toggleSearch'), label: 'Find in Files...', click: dispatch('toggleSearch') },
      ],
    },
    // View menu
    {
      label: 'View',
      submenu: [
        { ...actionMeta('commandPalette'), label: 'Command Palette...', click: dispatch('commandPalette') },
        // VS Code-style aliases for the same unified palette (fuzzy file search +
        // commands). Hidden so they don't clutter the menu but still bind the key.
        { label: 'Go to File...', accelerator: 'CmdOrCtrl+P', click: dispatch('commandPalette'), visible: false, acceleratorWorksWhenHidden: true },
        { label: 'Show All Commands', accelerator: 'CmdOrCtrl+Shift+P', click: dispatch('commandPalette'), visible: false, acceleratorWorksWhenHidden: true },
        { type: 'separator' },
        { ...actionMeta('toggleSidebar'), click: dispatch('toggleSidebar') },
        { ...actionMeta('toggleFileExplorer'), click: dispatch('toggleFileExplorer') },
        { type: 'separator' },
        { ...actionMeta('zoomIn'), click: dispatch('zoomIn') },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Shift+=', click: dispatch('zoomIn'), visible: false, acceleratorWorksWhenHidden: true },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: dispatch('zoomIn'), visible: false, acceleratorWorksWhenHidden: true },
        { ...actionMeta('zoomOut'), click: dispatch('zoomOut') },
        { ...actionMeta('zoomReset'), click: dispatch('zoomReset') },
        { ...actionMeta('zoomToFit'), click: dispatch('zoomToFit') },
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
        { ...actionMeta('focusNext'), label: 'Next Panel', click: dispatch('focusNext') },
        { ...actionMeta('focusPrevious'), label: 'Previous Panel', click: dispatch('focusPrevious') },
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
          click: newWindow,
        },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        {
          label: 'Main Window',
          click: (): void => {
            const win = getActiveMainWindow()
            if (win) {
              win.show()
              win.focus()
            }
          },
        },
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
  currentMenu = menu
}
