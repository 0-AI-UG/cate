// The application menu and native context menus. Menu items that are app
// actions send the action to the focused window, which runs it like the
// keyboard shortcut; accelerators follow the user's shortcut settings.

import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { resolveShortcuts, SHORTCUT_ACTIONS, SHORTCUT_DISPLAY_NAMES, type ContextMenuItem, type ShortcutAction, type StoredShortcut } from '@kernel/ui/contract'
import type { BrowserShortcutAction } from '@services/browser/contract'
import { sendBrowserShortcut } from '@services/browser/desktop'
import { DESKTOP_CHANNELS as C, type NativeAction } from '../contract'
import type { WindowRegistry } from './windowRegistry'

const DOCUMENTATION_URL = 'https://github.com/0-AI-UG/cate'
const ISSUES_URL = 'https://github.com/0-AI-UG/cate/issues'

/** Keys the renderer keeps for the focused surface's own editing. */
const RENDERER_ONLY: readonly ShortcutAction[] = ['tidyGrid', 'renamePanel', 'undo', 'redo', 'deleteNode', 'panUp', 'panDown', 'panLeft', 'panRight']

function shortcutAccelerator(shortcut: StoredShortcut): string | undefined {
  if (!shortcut.key) return undefined
  const parts: string[] = []
  if (shortcut.command) parts.push('CmdOrCtrl')
  if (shortcut.control) parts.push('Ctrl')
  if (shortcut.option) parts.push('Alt')
  if (shortcut.shift) parts.push('Shift')
  const names: Record<string, string> = { '\t': 'Tab', '\r': 'Enter', ' ': 'Space', '↑': 'Up', '↓': 'Down', '←': 'Left', '→': 'Right' }
  return [...parts, names[shortcut.key] ?? shortcut.key].join('+')
}

export interface AppMenuDeps {
  registry: WindowRegistry<BrowserWindow>
  customShortcuts(): unknown
  newMainWindow(): void
  checkForUpdates(): void
}

export interface AppMenu {
  rebuild(): void
  barLabels(): string[]
  popupBarItem(index: number, win: BrowserWindow, x: number, y: number): void
  runNativeAction(win: BrowserWindow, action: NativeAction): void
}

export function createAppMenu(deps: AppMenuDeps): AppMenu {
  let current: Menu | null = null

  const focused = () => deps.registry.focused()?.win
  const dispatch = (action: ShortcutAction) => () => {
    const win = focused()
    if (win) win.webContents.send(C.menuAction, action)
  }
  const browser = (action: BrowserShortcutAction) => () => {
    const win = focused()
    if (win) sendBrowserShortcut(win.webContents, action)
  }

  const runNativeAction = (win: BrowserWindow, action: NativeAction) => {
    switch (action) {
      case 'newWindow': deps.newMainWindow(); break
      case 'closeWindow': win.close(); break
      case 'toggleFullscreen': win.setFullScreen(!win.isFullScreen()); break
      case 'reloadWindow': win.webContents.reloadIgnoringCache(); break
      case 'toggleDevTools': win.webContents.toggleDevTools(); break
      case 'checkForUpdates': deps.checkForUpdates(); break
      case 'documentation': void shell.openExternal(DOCUMENTATION_URL); break
      case 'reportIssue': void shell.openExternal(ISSUES_URL); break
    }
  }
  const native = (action: NativeAction) => () => {
    const win = focused()
    if (win) runNativeAction(win, action)
  }

  const rebuild = () => {
    const shortcuts = resolveShortcuts(deps.customShortcuts())
    const meta = (action: ShortcutAction) => ({ label: SHORTCUT_DISPLAY_NAMES[action], accelerator: shortcutAccelerator(shortcuts[action]) })
    const hidden = (label: string, accelerator: string, click: () => void): MenuItemConstructorOptions =>
      ({ label, accelerator, click, visible: false, acceleratorWorksWhenHidden: true })

    const template: MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { ...meta('checkForUpdates'), click: () => deps.checkForUpdates() },
          { type: 'separator' },
          { ...meta('openSettings'), click: dispatch('openSettings') },
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
      {
        label: 'File',
        submenu: [
          { ...meta('newWindow'), click: () => deps.newMainWindow() },
          { type: 'separator' },
          { ...meta('newFile'), click: dispatch('newFile') },
          { ...meta('newEditor'), click: dispatch('newEditor') },
          { ...meta('newTerminal'), click: dispatch('newTerminal') },
          { ...meta('newBrowser'), click: dispatch('newBrowser') },
          { ...meta('newAgent'), click: dispatch('newAgent') },
          { ...meta('newCanvas'), click: dispatch('newCanvas') },
          { type: 'separator' },
          { ...meta('openFolder'), click: dispatch('openFolder') },
          { type: 'separator' },
          { ...meta('saveFile'), label: 'Save', click: dispatch('saveFile') },
          { type: 'separator' },
          // No accelerator: Cmd+R must still reach a focused browser.
          { label: SHORTCUT_DISPLAY_NAMES.renamePanel, click: dispatch('renamePanel') },
          { ...meta('closePanel'), click: dispatch('closePanel') },
          { ...meta('closeWindow'), click: native('closeWindow') },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { ...meta('undo'), click: dispatch('undo') },
          { ...meta('redo'), click: dispatch('redo') },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
          { type: 'separator' },
          { ...meta('toggleSearch'), label: 'Find in Files...', click: dispatch('toggleSearch') },
        ],
      },
      {
        label: 'View',
        submenu: [
          { ...meta('commandPalette'), label: 'Command Palette...', click: dispatch('commandPalette') },
          hidden('Go to File...', 'CmdOrCtrl+P', dispatch('commandPalette')),
          hidden('Show All Commands', 'CmdOrCtrl+Shift+P', dispatch('commandPalette')),
          { type: 'separator' },
          { ...meta('toggleSidebar'), click: dispatch('toggleSidebar') },
          { ...meta('toggleFileExplorer'), click: dispatch('toggleFileExplorer') },
          { ...meta('toggleMinimap'), click: dispatch('toggleMinimap') },
          { type: 'separator' },
          { ...meta('zoomIn'), click: dispatch('zoomIn') },
          hidden('Zoom In', 'CmdOrCtrl+Shift+=', dispatch('zoomIn')),
          hidden('Zoom In', 'CmdOrCtrl+Plus', dispatch('zoomIn')),
          { ...meta('zoomOut'), click: dispatch('zoomOut') },
          { ...meta('zoomReset'), click: dispatch('zoomReset') },
          { ...meta('zoomToFit'), click: dispatch('zoomToFit') },
          { type: 'separator' },
          { ...meta('toggleFullscreen'), click: native('toggleFullscreen') },
          { type: 'separator' },
          { ...meta('reloadWindow'), click: native('reloadWindow') },
          { ...meta('toggleDevTools'), click: native('toggleDevTools') },
        ],
      },
      {
        label: 'Go',
        submenu: [
          { ...meta('focusNext'), label: 'Next Panel', click: dispatch('focusNext') },
          { ...meta('focusPrevious'), label: 'Previous Panel', click: dispatch('focusPrevious') },
          { type: 'separator' },
          { ...meta('previousWorkspace'), click: dispatch('previousWorkspace') },
          { ...meta('nextWorkspace'), click: dispatch('nextWorkspace') },
        ],
      },
      {
        // No accelerators: these keys are panel-local so Monaco keeps Cmd+[ ] L.
        label: 'Browser',
        submenu: [
          { label: 'Reload (⌘R)', click: browser('reload') },
          { label: 'Force Reload (⌘⇧R)', click: browser('reloadHard') },
          { type: 'separator' },
          { label: 'Back (⌘[)', click: browser('back') },
          { label: 'Forward (⌘])', click: browser('forward') },
          { type: 'separator' },
          { label: 'Focus Address Bar (⌘L)', click: browser('focusUrl') },
        ],
      },
      {
        label: 'Window',
        submenu: [
          { label: 'New Window', click: () => deps.newMainWindow() },
          { type: 'separator' },
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          {
            label: 'Main Window',
            click: () => {
              const main = deps.registry.activeMain()?.win
              if (main) { main.show(); main.focus() }
            },
          },
        ],
      },
      {
        label: 'Help',
        role: 'help',
        submenu: [
          { ...meta('documentation'), click: native('documentation') },
          { ...meta('reportIssue'), click: native('reportIssue') },
          { type: 'separator' },
          { ...meta('checkForUpdates'), click: () => deps.checkForUpdates() },
          { ...meta('toggleDevTools'), click: native('toggleDevTools') },
        ],
      },
    ]

    // Every other bound action gets a hidden item so its key works even while
    // a guest page has focus (native accelerators reach guests).
    const registered = new Set<string>()
    const collect = (items: MenuItemConstructorOptions[]) => {
      for (const item of items) {
        if (typeof item.accelerator === 'string') registered.add(item.accelerator)
        if (Array.isArray(item.submenu)) collect(item.submenu)
      }
    }
    collect(template)
    const extras = SHORTCUT_ACTIONS.filter((action) => !RENDERER_ONLY.includes(action)).flatMap((action) => {
      const { label, accelerator } = meta(action)
      if (!accelerator || registered.has(accelerator)) return []
      registered.add(accelerator)
      return [hidden(label, accelerator, dispatch(action))]
    })
    const view = template.find((item) => item.label === 'View')
    if (view && Array.isArray(view.submenu)) view.submenu.push(...extras)
    current = Menu.buildFromTemplate(template)
    Menu.setApplicationMenu(current)
  }

  return {
    rebuild,
    barLabels: () => current?.items.map((item) => item.label) ?? [],
    popupBarItem(index, win, x, y) {
      const item = current?.items[index]
      if (item?.submenu) item.submenu.popup({ window: win, x, y })
    },
    runNativeAction,
  }
}

/** A native context menu; resolves with the picked id, or null. */
export function showContextMenu(win: BrowserWindow, items: ContextMenuItem[]): Promise<string | null> {
  return new Promise((resolve) => {
    let chosen: string | null = null
    const build = (list: ContextMenuItem[]): MenuItemConstructorOptions[] => list.map((item) => {
      if (item.type === 'separator') return { type: 'separator' }
      const option: MenuItemConstructorOptions = { label: item.label ?? '', enabled: item.enabled !== false }
      if (item.accelerator) option.accelerator = item.accelerator
      if (item.submenu?.length) option.submenu = build(item.submenu)
      else if (item.id) {
        const id = item.id
        option.click = () => { chosen = id }
      }
      return option
    })
    Menu.buildFromTemplate(build(Array.isArray(items) ? items : [])).popup({ window: win, callback: () => resolve(chosen) })
  })
}
