// =============================================================================
// terminalKeymap — macOS line-editing key translation for terminals
//
// xterm.js does not emit readline-style control sequences for Cmd/Option
// chords, so a plain shell never sees "delete to line start", "delete word",
// or word/line navigation. This module maps those chords to the exact byte
// sequences VS Code's integrated terminal sends (verified against
// terminalContrib/sendSequence/.../terminal.sendSequence.contribution.ts), so
// behaviour matches VS Code / Cursor.
//
// Pure + dependency-free (reads only the event's key + modifier flags) so it
// is trivially unit-testable. The xterm customKeyEventHandler calls
// resolveTerminalKeySequence() and writes the result to the PTY.
//
// macOS-only for now; the table is data-driven and extends to Win/Linux (Ctrl
// chords) by adding rows later.
// =============================================================================

export interface TerminalKeymapEntry {
  /** KeyboardEvent.key this row matches (e.g. 'Backspace', 'ArrowLeft', 'Delete'). */
  key: string
  /** Required Cmd (meta) state — matched exactly. */
  meta: boolean
  /** Required Option (alt) state — matched exactly. */
  alt: boolean
  /** Bytes written to the PTY when this row matches. */
  send: string
  /** Human-readable description (docs / future settings UI). */
  label: string
}

const ESC = '\x1b'

/** macOS terminal line-editing chords, mirroring VS Code's defaults.
 *  Ctrl and Shift must both be absent for a row to match (see resolver). */
export const MAC_TERMINAL_KEYMAP: readonly TerminalKeymapEntry[] = [
  { key: 'Backspace', meta: true, alt: false, send: '\x15', label: 'Delete to line start' },
  { key: 'Backspace', meta: false, alt: true, send: '\x17', label: 'Delete word left' },
  { key: 'Delete', meta: false, alt: true, send: `${ESC}d`, label: 'Delete word right' },
  { key: 'ArrowLeft', meta: true, alt: false, send: '\x01', label: 'Move to line start' },
  { key: 'ArrowRight', meta: true, alt: false, send: '\x05', label: 'Move to line end' },
  { key: 'ArrowLeft', meta: false, alt: true, send: `${ESC}b`, label: 'Move word left' },
  { key: 'ArrowRight', meta: false, alt: true, send: `${ESC}f`, label: 'Move word right' },
]

/**
 * Resolve a keyboard event to the PTY byte sequence for a macOS line-editing
 * chord, or null when no chord matches.
 *
 * Returns null on non-mac platforms so Windows/Linux keep their existing
 * behaviour. Matching is exact on all four modifiers — Ctrl and Shift must be
 * absent — so adjacent chords (Cmd+Shift+Backspace, Cmd+Ctrl+Backspace, …) are
 * never hijacked. Total function; never throws.
 */
export function resolveTerminalKeySequence(event: KeyboardEvent, isMac: boolean): string | null {
  if (!isMac) return null
  if (event.ctrlKey || event.shiftKey) return null
  for (const entry of MAC_TERMINAL_KEYMAP) {
    if (event.key === entry.key && event.metaKey === entry.meta && event.altKey === entry.alt) {
      return entry.send
    }
  }
  return null
}
