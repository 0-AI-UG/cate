// =============================================================================
// CLI permission matrix — the single source of truth for what the first-party
// `cate` CLI may do, shared by the main-process gate (cateApiHandlers) and the
// settings UI (Settings → CLI).
//
// Shape: surface (row) × access level (column). Read observes, Control acts.
// Each cell is one boolean setting; a method is matched to its cell by
// namespace prefix, and anything in a covered namespace that is not listed as a
// read method counts as control — so a NEW verb lands in the stricter cell
// rather than escaping the matrix.
//
// This is the fine-grained first-party layer on top of the extension scope
// system (see requiredScopeFor / GRANTED_SCOPES): scopes say which namespaces a
// caller may touch at all, permissions say which half of a namespace the user
// has allowed the CLI. Extensions are unaffected — they are governed by their
// manifest scopes plus consent prompts.
// =============================================================================

import type { AppSettings } from './types'

export type CliPermissionKey = Extract<
  keyof AppSettings,
  | 'cliBrowserReadEnabled'
  | 'cliBrowserControlEnabled'
  | 'cliTerminalReadEnabled'
  | 'cliTerminalInputEnabled'
  | 'cliPanelReadEnabled'
  | 'cliPanelControlEnabled'
  | 'cliEditorReadEnabled'
  | 'cliEditorControlEnabled'
  | 'cliNotifyEnabled'
>

export interface CliPermissionCell {
  key: CliPermissionKey
  /** 'Read' | 'Control' — the column, used in the error text and the matrix. */
  access: 'Read' | 'Control'
  /** Stable error slug returned when this cell is off. */
  code: string
  /** What the cell allows, shown as the cell's tooltip in settings. */
  detail: string
}

export interface CliPermissionSurface {
  /** Row label in the matrix, and the first half of the error text. */
  label: string
  /** cate.* method prefixes this row governs. */
  prefixes: string[]
  /** Methods under those prefixes that only observe. Everything else is control. */
  readMethods: string[]
  read?: CliPermissionCell
  control?: CliPermissionCell
}

export const CLI_PERMISSIONS: CliPermissionSurface[] = [
  {
    label: 'Browser',
    prefixes: ['cate.browser.'],
    readMethods: [
      'cate.browser.current',
      'cate.browser.list',
      'cate.browser.screenshot',
      'cate.browser.snapshot',
      'cate.browser.wait',
    ],
    read: {
      key: 'cliBrowserReadEnabled',
      access: 'Read',
      code: 'browser-read-disabled',
      detail:
        '`cate browser screenshot / snapshot / wait` — see the page in the built-in browser panel, which shows your live logged-in sessions.',
    },
    control: {
      key: 'cliBrowserControlEnabled',
      access: 'Control',
      code: 'browser-control-disabled',
      detail:
        '`cate browser open / reload / click / type / press` — act on the page in the built-in browser panel, using your live logged-in sessions.',
    },
  },
  {
    label: 'Terminal',
    prefixes: ['cate.terminal.'],
    readMethods: ['cate.terminal.read'],
    read: {
      key: 'cliTerminalReadEnabled',
      access: 'Read',
      code: 'terminal-read-disabled',
      detail:
        '`cate terminal read` — read the rendered screen and scrollback of terminal panels, which may contain secrets printed there.',
    },
    control: {
      key: 'cliTerminalInputEnabled',
      access: 'Control',
      code: 'terminal-input-disabled',
      detail:
        '`cate terminal type / press` — send keystrokes to terminal panels; input goes to whatever runs there, including your shell.',
    },
  },
  {
    label: 'Panels',
    // canvas.createPanel is the host method behind `cate panel create`, so the
    // canvas namespace belongs to this row too.
    prefixes: ['cate.panel.', 'cate.canvas.'],
    readMethods: ['cate.panel.list'],
    read: {
      key: 'cliPanelReadEnabled',
      access: 'Read',
      code: 'panel-read-disabled',
      detail:
        '`cate panel list` — enumerate the open panels across your windows, including each browser panel’s url.',
    },
    control: {
      key: 'cliPanelControlEnabled',
      access: 'Control',
      code: 'panel-control-disabled',
      detail:
        '`cate panel create / focus / close / set-title` — add panels to the canvas, focus, close and rename them.',
    },
  },
  {
    label: 'Editor',
    prefixes: ['cate.editor.'],
    readMethods: ['cate.editor.active'],
    read: {
      key: 'cliEditorReadEnabled',
      access: 'Read',
      code: 'editor-read-disabled',
      detail: 'Read which file the active editor panel is showing.',
    },
    control: {
      key: 'cliEditorControlEnabled',
      access: 'Control',
      code: 'editor-control-disabled',
      detail:
        '`cate editor open <path[:line]>` — open a file in an editor panel (a PDF or docx opens a document panel).',
    },
  },
  {
    label: 'Notifications',
    prefixes: ['cate.ui.'],
    readMethods: [],
    control: {
      key: 'cliNotifyEnabled',
      access: 'Control',
      code: 'notify-disabled',
      detail: '`cate notify <message>` — post a desktop notification from a terminal.',
    },
  },
]

/** The cell governing `method`, or undefined when no row covers its namespace
 *  (those methods are governed by scopes alone). A method under a covered
 *  namespace that is not a listed read method resolves to that row's control
 *  cell — new verbs fail into the stricter half. */
export function cliPermissionForMethod(method: string): CliPermissionCell | undefined {
  for (const surface of CLI_PERMISSIONS) {
    if (!surface.prefixes.some((p) => method.startsWith(p))) continue
    const cell = surface.readMethods.includes(method) ? surface.read : surface.control
    // A row without the matching cell (e.g. Notifications has no read half)
    // leaves the method ungated rather than permanently denied.
    return cell
  }
  return undefined
}

/** The cell owning a setting key. Every key in CliPermissionKey has one. */
export function cliPermissionCellByKey(key: CliPermissionKey): CliPermissionCell {
  for (const surface of CLI_PERMISSIONS) {
    if (surface.read?.key === key) return surface.read
    if (surface.control?.key === key) return surface.control
  }
  throw new Error(`no CLI permission cell for ${key}`)
}

/** Error returned when a cell is off. Names the cell so the caller can fix it. */
export function cliPermissionDenied(cell: CliPermissionCell): string {
  const surface = CLI_PERMISSIONS.find((s) => s.read === cell || s.control === cell)
  return `${cell.code}: enable ${surface?.label} → ${cell.access} in Cate Settings → CLI`
}
