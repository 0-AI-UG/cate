// Key bindings: the stored shape, key normalisation, display and matching.
// Which actions exist and their default keys are declared by the modules
// that own them (contract/actions.ts).

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

export function sameShortcut(a: StoredShortcut, b: StoredShortcut): boolean {
  return a.key === b.key &&
    a.command === b.command &&
    a.shift === b.shift &&
    a.option === b.option &&
    a.control === b.control
}

/** A hand-edited stored shortcut, or null when malformed. */
export function parseStoredShortcut(value: unknown): StoredShortcut | null {
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

/** The key fields of a DOM KeyboardEvent, so matching stays pure. */
export interface ShortcutKeyEvent {
  key: string
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
}

/** The key press triggers this binding. A disabled binding (empty key)
 *  never matches. */
export function shortcutMatches(event: ShortcutKeyEvent, stored: StoredShortcut): boolean {
  return !!stored.key &&
    stored.key === normaliseShortcutKey(event.key) &&
    stored.command === event.metaKey &&
    stored.shift === event.shiftKey &&
    stored.option === event.altKey &&
    stored.control === event.ctrlKey
}
