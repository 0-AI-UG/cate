// =============================================================================
// Application menu — standard macOS menu bar
// =============================================================================

import { BrowserWindow, Menu, shell, app } from 'electron'
import { MENU_OPEN_SETTINGS, MENU_TRIGGER_ACTION, BROWSER_SHORTCUT } from '../shared/ipc-channels'
import {
  SHORTCUT_ACTIONS,
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
  const native = (action: import('../shared/types').NativeAction) => (): void => {
    const win = getFocusedWindow()
    if (win) runNativeAction(win, action)
  }
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
          ...actionMeta('checkForUpdates'),
          click: (): void => {
            checkForUpdatesManually()
          },
        },
        { type: 'separator' },
        {
          ...actionMeta('openSettings'),
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
          ...actionMeta('newWindow'),
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
        { ...actionMeta('openFolder'), click: dispatch('openFolder') },
        { ...actionMeta('reloadWorkspace'), click: dispatch('reloadWorkspace') },
        { type: 'separator' },
        { ...actionMeta('saveFile'), label: 'Save', click: dispatch('saveFile') },
        { type: 'separator' },
        // Deliberately no native accelerator: Cmd+R must still reach a focused
        // browser so its panel-local reload handling can take precedence.
        { label: SHORTCUT_DISPLAY_NAMES.renamePanel, click: dispatch('renamePanel') },
        { ...actionMeta('closePanel'), click: dispatch('closePanel') },
        { ...actionMeta('closeWindow'), click: native('closeWindow') },
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
        { ...actionMeta('toggleMinimap'), click: dispatch('toggleMinimap') },
        { type: 'separator' },
        { ...actionMeta('zoomIn'), click: dispatch('zoomIn') },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Shift+=', click: dispatch('zoomIn'), visible: false, acceleratorWorksWhenHidden: true },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: dispatch('zoomIn'), visible: false, acceleratorWorksWhenHidden: true },
        { ...actionMeta('zoomOut'), click: dispatch('zoomOut') },
        { ...actionMeta('zoomReset'), click: dispatch('zoomReset') },
        { ...actionMeta('zoomToFit'), click: dispatch('zoomToFit') },
        { type: 'separator' },
        { ...actionMeta('toggleFullscreen'), click: native('toggleFullscreen') },
        { type: 'separator' },
        { ...actionMeta('reloadWindow'), click: native('reloadWindow') },
        { ...actionMeta('toggleDevTools'), click: native('toggleDevTools') },
      ],
    },
    // Go menu
    {
      label: 'Go',
      submenu: [
        { ...actionMeta('focusNext'), label: 'Next Panel', click: dispatch('focusNext') },
        { ...actionMeta('focusPrevious'), label: 'Previous Panel', click: dispatch('focusPrevious') },
        { type: 'separator' },
        { ...actionMeta('previousWorkspace'), click: dispatch('previousWorkspace') },
        { ...actionMeta('nextWorkspace'), click: dispatch('nextWorkspace') },
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
          ...actionMeta('documentation'),
          click: (): void => {
            shell.openExternal('https://github.com/0-AI-UG/cate')
          },
        },
        {
          ...actionMeta('reportIssue'),
          click: (): void => {
            shell.openExternal('https://github.com/0-AI-UG/cate/issues')
          },
        },
        { type: 'separator' },
        {
          ...actionMeta('checkForUpdates'),
          click: (): void => {
            checkForUpdatesManually()
          },
        },
        { ...actionMeta('toggleDevTools'), click: native('toggleDevTools') },
      ],
    },
  ]

// Native accelerators also reach browser guests. Keep text-sensitive commands
  // in the renderer, where the focused surface can retain its own editing keys.
  const registered = new Set<string>()
  const collect = (items: Electron.MenuItemConstructorOptions[]): void => {
    for (const item of items) {
      if (item.accelerator) registered.add(item.accelerator)
      if (Array.isArray(item.submenu)) collect(item.submenu)
    }
  }
  collect(template)
  const extras = SHORTCUT_ACTIONS.filter(id => ![
    'tidyGrid', 'renamePanel', 'undo', 'redo', 'deleteNode', 'panUp', 'panDown', 'panLeft', 'panRight',
  ].includes(id)).flatMap(id => {
    const meta = actionMeta(id)
    if (!meta.accelerator || registered.has(meta.accelerator)) return []
    registered.add(meta.accelerator)
    return [{ ...meta, visible: false, acceleratorWorksWhenHidden: true, click: dispatch(id) }]
  })
  const view = template.find(item => item.label === 'View')
  if (view && Array.isArray(view.submenu)) view.submenu.push(...extras)
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
  currentMenu = menu
}

/** Commands that need Electron APIs, scoped to the requesting app window. */
export function runNativeAction(win: BrowserWindow, action: import('../shared/types').NativeAction): void {
  switch (action) {
    case 'newWindow': newMainWindowFn?.(); break
    case 'closeWindow': win.close(); break
    case 'toggleFullscreen': win.setFullScreen(!win.isFullScreen()); break
    case 'reloadWindow': win.webContents.reloadIgnoringCache(); break
    case 'toggleDevTools': win.webContents.toggleDevTools(); break
    case 'checkForUpdates': checkForUpdatesManually(); break
    case 'documentation': void shell.openExternal('https://github.com/0-AI-UG/cate'); break
    case 'reportIssue': void shell.openExternal('https://github.com/0-AI-UG/cate/issues'); break
    case 'browser:reload':
    case 'browser:reloadHard':
    case 'browser:back':
    case 'browser:forward':
    case 'browser:focusUrl':
      sendToWindow(win.id, BROWSER_SHORTCUT, action.slice('browser:'.length))
      break
  }
}
