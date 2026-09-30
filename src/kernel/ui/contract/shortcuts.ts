// Keyboard shortcut registry: the action catalog, default bindings, key
// normalisation and matching. Custom overrides come from the `customShortcuts`
// client setting; what each action does is bound by client/ui.

export interface StoredShortcut {
  key: string
  command: boolean
  shift: boolean
  option: boolean
  control: boolean
}

/** Build a StoredShortcut with defaults matching the Swift initializer. */
export function storedShortcut(
  key: string,
  mods: { command?: boolean; shift?: boolean; option?: boolean; control?: boolean } = {},
): StoredShortcut {
  return {
    key,
    command: mods.command ?? false,
    shift: mods.shift ?? false,
    option: mods.option ?? false,
    control: mods.control ?? false,
  }
}

/** Convert DOM KeyboardEvent key names to Cate's persisted shortcut keys. */
export function normaliseShortcutKey(key: string): string {
  switch (key) {
    case 'Tab': return '\t'
    case 'Enter': return '\r'
    case ' ': return ' '
    case 'Backspace': return 'Backspace'
    case 'Escape': return 'Escape'
    case 'ArrowLeft': return '\u2190'
    case 'ArrowRight': return '\u2192'
    case 'ArrowDown': return '\u2193'
    case 'ArrowUp': return '\u2191'
    default: return key.toLowerCase()
  }
}

/** Mirrors StoredShortcut.displayString from Swift. */
export function displayString(s: StoredShortcut): string {
  // An empty key means the binding is disabled (see clearShortcut).
  if (!s.key) return 'None'
  const parts: string[] = []
  if (s.control) parts.push('\u2303') // ⌃
  if (s.option) parts.push('\u2325')  // ⌥
  if (s.shift) parts.push('\u21E7')   // ⇧
  if (s.command) parts.push('\u2318') // ⌘
  let keyText: string
  switch (s.key) {
    case '\t':
      keyText = 'TAB'
      break
    case '\r':
      keyText = '\u21A9' // ↩
      break
    case ' ':
      keyText = 'SPACE'
      break
    default:
      keyText = s.key.toUpperCase()
  }
  parts.push(keyText)
  return parts.join('')
}

/** Canonical shortcut-action catalog. Action ids, labels, ordering, and default
 * bindings are derived from this one declaration. */
export const SHORTCUT_DEFINITIONS = {
  newTerminal: { label: 'New Terminal', shortcut: storedShortcut('t', { command: true }) },
  newBrowser: { label: 'New Browser', shortcut: storedShortcut('b', { command: true, shift: true }) },
  newEditor: { label: 'New Files Panel', shortcut: storedShortcut('e', { command: true, shift: true }) },
  newAgent: { label: 'New T3 Code conversation', shortcut: storedShortcut('a', { command: true, shift: true }) },
  newCanvas: { label: 'New Canvas', shortcut: storedShortcut('c', { command: true, shift: true }) },
  newFile: { label: 'New File', shortcut: storedShortcut('n', { command: true }) },
  closePanel: { label: 'Close Panel', shortcut: storedShortcut('w', { command: true }) },
  toggleSidebar: { label: 'Toggle Sidebar', shortcut: storedShortcut('b', { command: true }) },
  toggleFileExplorer: { label: 'Toggle File Explorer', shortcut: storedShortcut('x', { command: true, shift: true }) },
  toggleSearch: { label: 'Toggle Search', shortcut: storedShortcut('f', { command: true, shift: true }) },
  toggleMinimap: { label: 'Toggle Minimap', shortcut: storedShortcut('m', { command: true, shift: true }) },
  commandPalette: { label: 'Command Palette', shortcut: storedShortcut('k', { command: true }) },
  nextWorkspace: { label: 'Next Workspace', shortcut: storedShortcut('→', { command: true, option: true }) },
  previousWorkspace: { label: 'Previous Workspace', shortcut: storedShortcut('←', { command: true, option: true }) },
  zoomIn: { label: 'Zoom In', shortcut: storedShortcut('=', { command: true }) },
  zoomOut: { label: 'Zoom Out', shortcut: storedShortcut('-', { command: true }) },
  zoomReset: { label: 'Reset Zoom', shortcut: storedShortcut('0', { command: true }) },
  focusNext: { label: 'Focus Next Panel', shortcut: storedShortcut('\t', { control: true }) },
  focusPrevious: { label: 'Focus Previous Panel', shortcut: storedShortcut('\t', { shift: true, control: true }) },
  saveFile: { label: 'Save File', shortcut: storedShortcut('s', { command: true }) },
  renamePanel: { label: 'Rename Focused Panel', shortcut: storedShortcut('r', { command: true }) },
  zoomToFit: { label: 'Zoom to Fit', shortcut: storedShortcut('1', { command: true }) },
  zoomToSelection: { label: 'Zoom to Selection', shortcut: storedShortcut('2', { command: true }) },
  autoLayout: { label: 'Auto Layout Canvas', shortcut: storedShortcut('l', { command: true, shift: true }) },
  undo: { label: 'Undo', shortcut: storedShortcut('z', { command: true }) },
  redo: { label: 'Redo', shortcut: storedShortcut('z', { command: true, shift: true }) },
  deleteNode: { label: 'Delete Focused Panel', shortcut: storedShortcut('Backspace', { command: true }) },
  // Control+Space is safe while typing; Shift+Space used to swallow ordinary spaces.
  toggleTool: { label: 'Toggle Select / Hand Tool', shortcut: storedShortcut(' ', { control: true }) },
  navigateUp: { label: 'Navigate to Panel Above', shortcut: storedShortcut('↑', { command: true }) },
  navigateDown: { label: 'Navigate to Panel Below', shortcut: storedShortcut('↓', { command: true }) },
  navigateLeft: { label: 'Navigate to Panel Left', shortcut: storedShortcut('←', { command: true }) },
  navigateRight: { label: 'Navigate to Panel Right', shortcut: storedShortcut('→', { command: true }) },
  panUp: { label: 'Pan Canvas Up', shortcut: storedShortcut('↑', { shift: true }) },
  panDown: { label: 'Pan Canvas Down', shortcut: storedShortcut('↓', { shift: true }) },
  panLeft: { label: 'Pan Canvas Left', shortcut: storedShortcut('←', { shift: true }) },
  panRight: { label: 'Pan Canvas Right', shortcut: storedShortcut('→', { shift: true }) },
  selectTool: { label: 'Select Tool', shortcut: storedShortcut('1', { command: true, option: true }) },
  handTool: { label: 'Hand Tool', shortcut: storedShortcut('2', { command: true, option: true }) },
  toggleKeepAwake: { label: 'Toggle Keep Awake', shortcut: storedShortcut('k', { command: true, option: true }) },
  openWorktreeMenu: { label: 'Parallel Worktrees', shortcut: storedShortcut('w', { command: true, option: true }) },
  openConversationMenu: { label: 'T3 Code Conversations', shortcut: storedShortcut('a', { command: true, option: true }) },
  toggleCanvasToolbar: { label: 'Expand / Collapse Canvas Toolbar', shortcut: storedShortcut('b', { command: true, option: true }) },
  tidyGrid: { label: 'Tidy Selected Panels into Grid', shortcut: storedShortcut('g', { command: true }) },
  newWorkspace: { label: 'New Workspace', shortcut: storedShortcut('') },
  openFolder: { label: 'Open Folder…', shortcut: storedShortcut('o', { command: true }) },
  openSettings: { label: 'Settings / Preferences…', shortcut: storedShortcut(',', { command: true }) },
  openRepository: { label: 'Repository / Source Control Changes', shortcut: storedShortcut('g', { command: true, shift: true }) },
  openPullRequests: { label: 'Pull Requests', shortcut: storedShortcut('g', { command: true, option: true }) },
  openUsage: { label: 'Usage', shortcut: storedShortcut('u', { command: true, option: true }) },
  skills: { label: 'Skills…', shortcut: storedShortcut('s', { command: true, option: true }) },
  showTutorial: { label: 'Show Tutorial', shortcut: storedShortcut('') },
  reloadWorkspace: { label: 'Reload Workspace from Disk', shortcut: storedShortcut('') },
  deleteRuntime: { label: 'Delete Runtime', shortcut: storedShortcut('') },
  newWindow: { label: 'New Window', shortcut: storedShortcut('n', { command: true, shift: true }) },
  closeWindow: { label: 'Close Window', shortcut: storedShortcut('w', { command: true, shift: true }) },
  toggleFullscreen: { label: 'Toggle Full Screen', shortcut: storedShortcut('f', { command: true, control: true }) },
  reloadWindow: { label: 'Force Reload Window', shortcut: storedShortcut('') },
  toggleDevTools: { label: 'Toggle Developer Tools', shortcut: storedShortcut('i', { command: true, option: true }) },
  checkForUpdates: { label: 'Check for Updates…', shortcut: storedShortcut('') },
  documentation: { label: 'Cate Documentation', shortcut: storedShortcut('') },
  reportIssue: { label: 'Report Issue…', shortcut: storedShortcut('') },
} as const satisfies Record<string, { label: string; shortcut: StoredShortcut }>

export type ShortcutAction = keyof typeof SHORTCUT_DEFINITIONS

export const SHORTCUT_ACTIONS = Object.keys(SHORTCUT_DEFINITIONS) as ShortcutAction[]

export const SHORTCUT_DISPLAY_NAMES = Object.fromEntries(
  SHORTCUT_ACTIONS.map((action) => [action, SHORTCUT_DEFINITIONS[action].label]),
) as Record<ShortcutAction, string>

export const DEFAULT_SHORTCUTS = Object.fromEntries(
  SHORTCUT_ACTIONS.map((action) => [action, SHORTCUT_DEFINITIONS[action].shortcut]),
) as Record<ShortcutAction, StoredShortcut>

function parseStoredShortcut(value: unknown): StoredShortcut | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.key !== 'string') return null
  return storedShortcut(candidate.key, {
    command: candidate.command === true,
    shift: candidate.shift === true,
    option: candidate.option === true,
    control: candidate.control === true,
  })
}

/** Resolve persisted overrides over built-ins in every process from one parser. */
export function resolveShortcuts(raw: unknown): Record<ShortcutAction, StoredShortcut> {
  const shortcuts = { ...DEFAULT_SHORTCUTS }
  if (typeof raw !== 'object' || raw === null) return shortcuts
  for (const action of SHORTCUT_ACTIONS) {
    const parsed = parseStoredShortcut((raw as Record<string, unknown>)[action])
    if (parsed) shortcuts[action] = parsed
  }
  return shortcuts
}

export function sameShortcut(a: StoredShortcut, b: StoredShortcut): boolean {
  return a.key === b.key &&
    a.command === b.command &&
    a.shift === b.shift &&
    a.option === b.option &&
    a.control === b.control
}

/** The part of a resolved binding table that differs from the defaults, which
 *  is what `customShortcuts` stores. */
export function shortcutOverrides(
  shortcuts: Record<ShortcutAction, StoredShortcut>,
): Partial<Record<ShortcutAction, StoredShortcut>> {
  const overrides: Partial<Record<ShortcutAction, StoredShortcut>> = {}
  for (const action of SHORTCUT_ACTIONS) {
    if (!sameShortcut(shortcuts[action], DEFAULT_SHORTCUTS[action])) overrides[action] = shortcuts[action]
  }
  return overrides
}

/** The key fields of a DOM KeyboardEvent, so matching stays pure. */
export interface ShortcutKeyEvent {
  key: string
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
}

/** The first action (in catalog order) bound to this key press. Disabled
 *  bindings (empty key) never match. */
export function matchShortcut(
  event: ShortcutKeyEvent,
  shortcuts: Record<ShortcutAction, StoredShortcut>,
): ShortcutAction | null {
  const key = normaliseShortcutKey(event.key)
  for (const action of SHORTCUT_ACTIONS) {
    const stored = shortcuts[action]
    if (!stored.key) continue
    if (stored.key === key &&
        stored.command === event.metaKey &&
        stored.shift === event.shiftKey &&
        stored.option === event.altKey &&
        stored.control === event.ctrlKey) return action
  }
  return null
}
