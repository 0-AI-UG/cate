// =============================================================================
// terminalKeymap — translate macOS line-editing chords into the literal control
// bytes a shell's line editor (readline / zsh ZLE) understands.
//
// In a Cate terminal, chords like Cmd+Backspace ("delete to line start") must
// behave the way they do in the VS Code / Cursor integrated terminal. xterm.js
// doesn't translate them, and a CSI-u encoding (e.g. `\x1b[127;3u`) isn't
// understood by a plain shell — so we map each chord to the exact byte sequence
// VS Code sends via `workbench.action.terminal.sendSequence` (verified against
// terminalContrib/sendSequence/.../terminal.sendSequence.contribution.ts).
//
// The mapping is a data-driven table so it's self-documenting (each row carries
// a label for docs / a future settings UI) and extends to Windows / Linux by
// adding rows later. This module is pure (no DOM / xterm dependency) so it can
// be unit-tested; the byte writing happens in the caller's xterm
// customKeyEventHandler (see terminalRegistry.ts).
// =============================================================================

/** Minimal keyboard-event shape so this stays unit-testable without a real DOM.
 *  A real `KeyboardEvent` is structurally assignable to this. */
export interface TerminalKeyEvent {
  key: string
  metaKey: boolean
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}

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

/** macOS terminal line-editing chords, mirroring VS Code's defaults. Ctrl and
 *  Shift must both be absent for a row to match (enforced by the resolver). */
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
 * chord, or null when no chord matches (the caller then falls back to its
 * normal handling).
 *
 * Returns null on non-mac platforms so Windows/Linux keep their existing
 * behaviour. Matching is exact on Cmd/Option, and Ctrl/Shift must be absent, so
 * adjacent chords (Cmd+Shift+Backspace, Cmd+Ctrl+Backspace, Cmd+Option+Left, …)
 * are never hijacked. Total function; never throws.
 */
export function resolveTerminalKeySequence(e: TerminalKeyEvent, isMac: boolean): string | null {
  if (!isMac) return null
  if (e.ctrlKey || e.shiftKey) return null
  for (const entry of MAC_TERMINAL_KEYMAP) {
    if (e.key === entry.key && e.metaKey === entry.meta && e.altKey === entry.alt) {
      return entry.send
    }
  }
  return null
}
