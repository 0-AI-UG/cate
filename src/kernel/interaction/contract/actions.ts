// Actions: what a module can do on a person's request (a key, a menu item, a
// palette entry, a toolbar button). Each module declares its actions once
// with `defineActions` next to the code that runs them; panel types get
// theirs from their definitions. Menus, the palette, the shortcuts settings
// and tooltips are generated from the declarations. Pure.

import type { IconName } from './icons'
import type { StoredShortcut } from './shortcuts'

/** An action's id: `zoomIn`, `panel.new.terminal`. Stored as the key of a
 *  custom shortcut. */
export type ActionId = string

/** When a matched key yields to what has focus instead of running. */
export interface ActionKeyPolicy {
  /** A held chord does not repeat it. */
  noRepeat?: boolean
  /** A focused text field keeps the key (native undo, word motion). */
  yieldToText?: boolean
  /** A panel that owns the keyboard (a shell) keeps the key. */
  yieldToKeyboardOwner?: boolean
  /** An open palette or overlay keeps the key (arrows). */
  yieldToOverlay?: boolean
  /** A focused list that handles its own keys (the sidebar) keeps the key. */
  yieldToList?: boolean
  /** The key also runs while a web page has focus (it never reaches the
   *  window otherwise). */
  fromGuests?: boolean
  /** Only the window's own keyboard handler runs it: no native menu
   *  accelerator, which would take the key from a focused editor. */
  windowOnly?: boolean
}

/** The native menu bar's menus, in bar order. */
export const MENU_BAR = ['app', 'file', 'edit', 'view', 'go', 'panel', 'window', 'help'] as const
export type MenuBarId = (typeof MENU_BAR)[number]

/** Where an action sits in the native menu bar: a menu, a group inside it
 *  (groups are separated) and its order in the group. */
export interface ActionMenuPlacement {
  bar: MenuBarId
  group: string
  order?: number
  /** A submenu of `bar` the item goes into (a panel type's commands). */
  submenu?: string
}

/** Context menus an action is offered in (the canvas's empty-space menu). */
export type ActionContextMenu = 'canvas'

export interface ActionSpec {
  title: string
  /** Default binding; none when omitted. */
  key?: StoredShortcut
  /** Further fixed keys the native menu also answers (Cmd+Plus for zoom). */
  aliasKeys?: readonly StoredShortcut[]
  /** A key the focused panel handles itself, shown next to the title. */
  keyHint?: string
  icon?: IconName
  /** Listed in the command palette (default true). */
  palette?: boolean
  /** Listed on the welcome page with its key. */
  welcome?: boolean
  menu?: ActionMenuPlacement
  contextMenus?: readonly ActionContextMenu[]
  keys?: ActionKeyPolicy
}

export type ActionSpecs = Record<ActionId, ActionSpec>

export function defineActions<T extends ActionSpecs>(specs: T): T {
  return specs
}
