// The native menu bar as data. The renderer builds it from the declared
// actions (kernel/interaction) and sends it to main, which only renders it: main knows
// no action. The skeleton (which roles and action groups each menu holds, in
// which order) is shared, so main can show a bare bar before a window sends
// its model. Pure.

import type { ActionId, MenuBarId, StoredShortcut } from '@kernel/interaction/contract'

/** Electron menu roles the bar uses. */
export type MenuRole =
  | 'about' | 'services' | 'hide' | 'hideOthers' | 'unhide' | 'quit'
  | 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle' | 'delete' | 'selectAll'
  | 'minimize' | 'zoom'

export type MenuModelItem =
  | { type: 'separator' }
  | { type: 'role'; role: MenuRole }
  | {
    type: 'action'
    action: ActionId
    label: string
    shortcut?: StoredShortcut
    /** False: the key is shown, but the window's own keyboard handler runs
     *  it (a focused editor keeps the key). */
    registerShortcut: boolean
  }
  | { type: 'submenu'; label: string; items: MenuModelItem[] }

export interface MenuModelMenu {
  id: MenuBarId
  label: string
  items: MenuModelItem[]
}

export interface MenuModel {
  bar: MenuModelMenu[]
  /** Keys without a visible item that still answer while a web page has
   *  focus (native accelerators reach guests). */
  hidden: { action: ActionId; label: string; shortcut: StoredShortcut }[]
  /** Keys a web page never gets: the window runs these actions. */
  guestKeys: { action: ActionId; shortcut: StoredShortcut }[]
}

/** One block of a menu: roles and action groups, separated from the next
 *  block. Groups no block names go at the end of their menu. */
export type MenuSkeletonEntry = { role: MenuRole } | { group: string }

export const MENU_SKELETON: Record<MenuBarId, { label: string; blocks: MenuSkeletonEntry[][] }> = {
  // Main shows the app's name.
  app: {
    label: '',
    blocks: [
      [{ role: 'about' }, { group: 'about' }],
      [{ group: 'settings' }],
      [{ role: 'services' }],
      [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }],
      [{ role: 'quit' }],
    ],
  },
  file: { label: 'File', blocks: [[{ group: 'window' }], [{ group: 'new' }], [{ group: 'open' }], [{ group: 'save' }], [{ group: 'close' }]] },
  edit: {
    label: 'Edit',
    blocks: [
      [{ group: 'history' }],
      [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }],
      [{ group: 'find' }],
    ],
  },
  view: { label: 'View', blocks: [[{ group: 'palette' }], [{ group: 'panes' }], [{ group: 'zoom' }], [{ group: 'window' }], [{ group: 'dev' }]] },
  go: { label: 'Go', blocks: [[{ group: 'panels' }], [{ group: 'workspaces' }]] },
  panel: { label: 'Panel', blocks: [] },
  window: { label: 'Window', blocks: [[{ role: 'minimize' }, { role: 'zoom' }], [{ group: 'main' }]] },
  help: { label: 'Help', blocks: [[{ group: 'links' }], [{ group: 'learn' }]] },
}
