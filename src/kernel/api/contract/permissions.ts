// Permission areas of the `cate` API (architecture 8 and 14). Each area maps
// the `read` and `control` access classes to a workspace setting; `cliEnabled`
// is the master switch. They apply to CLI and harness callers only.

export const CLI_MASTER_KEY = 'cliEnabled'

export type CliPermissionKey =
  | 'cliBrowserReadEnabled'
  | 'cliBrowserControlEnabled'
  | 'cliTerminalReadEnabled'
  | 'cliTerminalInputEnabled'
  | 'cliPanelReadEnabled'
  | 'cliPanelControlEnabled'
  | 'cliEditorReadEnabled'
  | 'cliEditorControlEnabled'
  | 'cliNotifyEnabled'
  | 'cliAgentReadEnabled'
  | 'cliAgentControlEnabled'

export type ApiAccess = 'read' | 'control'

export interface CliPermissionCell {
  key: CliPermissionKey
  /** Stable error slug returned when this cell is off. */
  code: string
  /** What the cell allows, for the settings page. */
  detail: string
}

export interface CliPermissionArea {
  /** Row label in Settings, and part of the denial text. */
  label: string
  /** An area without a read cell leaves its read methods behind the master switch only. */
  read?: CliPermissionCell
  control: CliPermissionCell
}

export const CLI_PERMISSION_AREAS = {
  browser: {
    label: 'Browser',
    read: {
      key: 'cliBrowserReadEnabled',
      code: 'browser-read-disabled',
      detail:
        'Accessibility state, element attributes, screenshots, tabs and waits: inspect the page in the built-in browser panel, which shows your live logged-in sessions.',
    },
    control: {
      key: 'cliBrowserControlEnabled',
      code: 'browser-control-disabled',
      detail: 'Browser JavaScript sessions and actions: act on the page through the live browser panel.',
    },
  },
  terminal: {
    label: 'Terminal',
    read: {
      key: 'cliTerminalReadEnabled',
      code: 'terminal-read-disabled',
      detail:
        '`cate terminal read`: read the screen and scrollback of terminal panels, which may contain secrets printed there.',
    },
    control: {
      key: 'cliTerminalInputEnabled',
      code: 'terminal-input-disabled',
      detail:
        '`cate terminal type / press`: send keystrokes to terminal panels; input goes to whatever runs there, including your shell.',
    },
  },
  panel: {
    label: 'Panels',
    read: {
      key: 'cliPanelReadEnabled',
      code: 'panel-read-disabled',
      detail: '`cate panel list`: enumerate the open panels, including each browser panel\'s url.',
    },
    control: {
      key: 'cliPanelControlEnabled',
      code: 'panel-control-disabled',
      detail: '`cate panel create / close`: add browser, terminal or canvas panels and close panels.',
    },
  },
  editor: {
    label: 'Files',
    read: {
      key: 'cliEditorReadEnabled',
      code: 'editor-read-disabled',
      detail: 'Read which file the active editor panel is showing.',
    },
    control: {
      key: 'cliEditorControlEnabled',
      code: 'editor-control-disabled',
      detail: '`cate editor open <path[:line]>`: open a file in Files, including image, PDF and DOCX previews.',
    },
  },
  notify: {
    label: 'Notifications',
    control: {
      key: 'cliNotifyEnabled',
      code: 'notify-disabled',
      detail: '`cate notify <message>`: post a notification from a terminal.',
    },
  },
  agent: {
    label: 'Agents & reviews',
    read: {
      key: 'cliAgentReadEnabled',
      code: 'agent-read-disabled',
      detail:
        '`cate agent list / wait / read` and `cate review inspect`: observe workers, their conversations and terminal output, and review state.',
    },
    control: {
      key: 'cliAgentControlEnabled',
      code: 'agent-control-disabled',
      detail:
        '`cate agent send` and `cate review note / complete`: steer live terminal or chat agents and record review results.',
    },
  },
} as const satisfies Record<string, CliPermissionArea>

export type CliArea = keyof typeof CLI_PERMISSION_AREAS

export const CLI_DISABLED_MESSAGE =
  'cli-disabled: enable Command-line control (cate CLI) in Cate Settings → CLI'

/** The cell that governs `access` in `area`, if any. */
export function cliPermissionCell(area: CliArea | undefined, access: ApiAccess): CliPermissionCell | undefined {
  if (!area) return undefined
  const row: CliPermissionArea = CLI_PERMISSION_AREAS[area]
  return access === 'read' ? row.read : row.control
}

/** Error text for a cell that is off. Names the cell so the user can fix it. */
export function cliPermissionDenied(area: CliArea, access: ApiAccess): string {
  const row: CliPermissionArea = CLI_PERMISSION_AREAS[area]
  const cell = cliPermissionCell(area, access)!
  return `${cell.code}: enable ${row.label} → ${access === 'read' ? 'Read' : 'Control'} in Cate Settings → CLI`
}

/**
 * Checks the master switch and the area cell. Returns the denial text, or
 * null when allowed. `setting` reads a workspace setting; anything but `true`
 * counts as off.
 */
export function cliAccessDenied(
  area: CliArea | undefined,
  access: ApiAccess,
  setting: (key: string) => unknown,
): string | null {
  if (setting(CLI_MASTER_KEY) !== true) return CLI_DISABLED_MESSAGE
  const cell = cliPermissionCell(area, access)
  if (cell && setting(cell.key) !== true) return cliPermissionDenied(area!, access)
  return null
}
