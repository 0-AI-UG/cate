// The application menu and native context menus. The renderer sends the
// menu bar as a model built from its declared actions; this module only
// renders it. A picked item sends its action to the focused window, which
// runs it like the key.

import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { MENU_BAR, type ContextMenuItem, type StoredShortcut } from '@kernel/interaction/contract'
import { DESKTOP_CHANNELS as C, MENU_SKELETON, type MenuModel, type MenuModelItem, type NativeAction } from '../contract'
import type { WindowRegistry } from './windowRegistry'

const DOCUMENTATION_URL = 'https://github.com/0-AI-UG/cate'
const ISSUES_URL = 'https://github.com/0-AI-UG/cate/issues'

export function shortcutAccelerator(shortcut: StoredShortcut | undefined): string | undefined {
  if (!shortcut?.key) return undefined
  const parts: string[] = []
  if (shortcut.command) parts.push('CmdOrCtrl')
  if (shortcut.control) parts.push('Ctrl')
  if (shortcut.option) parts.push('Alt')
  if (shortcut.shift) parts.push('Shift')
  const names: Record<string, string> = { '\t': 'Tab', '\r': 'Enter', ' ': 'Space', '↑': 'Up', '↓': 'Down', '←': 'Left', '→': 'Right' }
  return [...parts, names[shortcut.key] ?? shortcut.key].join('+')
}

/** The bar before any window sent its model: the skeleton's roles only. */
const BARE_MODEL: MenuModel = {
  bar: MENU_BAR.map((id) => ({
    id,
    label: MENU_SKELETON[id].label,
    items: MENU_SKELETON[id].blocks.flatMap((block, i): MenuModelItem[] => {
      const roles = block.flatMap((entry): MenuModelItem[] => ('role' in entry ? [{ type: 'role', role: entry.role }] : []))
      return roles.length && i > 0 ? [{ type: 'separator' }, ...roles] : roles
    }),
  })),
  hidden: [],
  guestKeys: [],
}

export interface AppMenuDeps {
  registry: WindowRegistry<BrowserWindow>
  newMainWindow(): void
}

export interface AppMenu {
  /** Renders a window's model (every window sends the same one). */
  setModel(model: MenuModel): void
  /** The keys a web page never gets (`MenuModel.guestKeys`). */
  guestKeys(): MenuModel['guestKeys']
  barLabels(): string[]
  popupBarItem(index: number, win: BrowserWindow, x: number, y: number): void
  runNativeAction(win: BrowserWindow, action: NativeAction): void
}

export function createAppMenu(deps: AppMenuDeps): AppMenu {
  let current: Menu | null = null
  let model = BARE_MODEL

  const dispatch = (action: string) => () => {
    const win = deps.registry.focused()?.win
    if (win) win.webContents.send(C.menuAction, action)
  }

  const runNativeAction = (win: BrowserWindow, action: NativeAction) => {
    switch (action) {
      case 'newWindow': deps.newMainWindow(); break
      case 'closeWindow': win.close(); break
      case 'showMainWindow': {
        const main = deps.registry.activeMain()?.win
        if (main) { main.show(); main.focus() }
        break
      }
      case 'toggleFullscreen': win.setFullScreen(!win.isFullScreen()); break
      case 'reloadWindow': win.webContents.reloadIgnoringCache(); break
      case 'toggleDevTools': win.webContents.toggleDevTools(); break
      case 'documentation': void shell.openExternal(DOCUMENTATION_URL); break
      case 'reportIssue': void shell.openExternal(ISSUES_URL); break
    }
  }

  const item = (entry: MenuModelItem): MenuItemConstructorOptions => {
    switch (entry.type) {
      case 'separator': return { type: 'separator' }
      case 'role': return { role: entry.role }
      case 'submenu': return { label: entry.label, submenu: entry.items.map(item) }
      case 'action': {
        const accelerator = shortcutAccelerator(entry.shortcut)
        return {
          label: entry.label,
          click: dispatch(entry.action),
          ...(accelerator ? { accelerator, registerAccelerator: entry.registerShortcut } : {}),
        }
      }
    }
  }

  const render = () => {
    const template: MenuItemConstructorOptions[] = model.bar.map((menu) => ({
      label: menu.id === 'app' ? app.name : menu.label,
      ...(menu.id === 'help' ? { role: 'help' as const } : {}),
      submenu: menu.items.map(item),
    }))
    // Keys without a visible item get a hidden one, so they work while a
    // web page has focus.
    const registered = new Set<string>()
    const collect = (items: MenuItemConstructorOptions[]) => {
      for (const option of items) {
        if (typeof option.accelerator === 'string' && option.registerAccelerator !== false) registered.add(option.accelerator)
        if (Array.isArray(option.submenu)) collect(option.submenu)
      }
    }
    collect(template)
    const hidden = model.hidden.flatMap(({ action, label, shortcut }): MenuItemConstructorOptions[] => {
      const accelerator = shortcutAccelerator(shortcut)
      if (!accelerator || registered.has(accelerator)) return []
      registered.add(accelerator)
      return [{ label, accelerator, click: dispatch(action), visible: false, acceleratorWorksWhenHidden: true }]
    })
    const view = template.find((_, i) => model.bar[i].id === 'view') ?? template[template.length - 1]
    if (view && Array.isArray(view.submenu)) view.submenu.push(...hidden)
    current = Menu.buildFromTemplate(template)
    Menu.setApplicationMenu(current)
  }
  render()

  return {
    setModel(next) {
      model = next
      render()
    },
    guestKeys: () => model.guestKeys,
    barLabels: () => current?.items.map((entry) => entry.label) ?? [],
    popupBarItem(index, win, x, y) {
      const entry = current?.items[index]
      if (entry?.submenu) entry.submenu.popup({ window: win, x, y })
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
