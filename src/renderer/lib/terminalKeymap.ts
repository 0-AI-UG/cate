// =============================================================================
// terminalKeymap — translate macOS line-editing chords into the literal control
// bytes a shell's line editor (readline / zsh ZLE) understands.
//
// In a Cate terminal, chords like Cmd+Backspace ("delete to line start") must
// behave the way they do in the VS Code / Cursor integrated terminal. xterm.js
// doesn't translate them, and a CSI-u encoding (e.g. `\x1b[127;3u`) isn't
// understood by a plain shell — so we map each chord to the exact byte sequence
// VS Code sends via `workbench.action.terminal.sendSequence`.
//
// This module is pure (no DOM / xterm dependency) so it can be unit-tested and
// later extended to Windows / Linux. The byte writing happens in the caller's
// xterm customKeyEventHandler (see terminalRegistry.ts).
// =============================================================================

/** Minimal keyboard-event shape so this stays unit-testable without a real DOM. */
export interface TerminalKeyEvent {
  key: string
  metaKey: boolean
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}

/**
 * Resolve a macOS line-editing chord to the bytes to write to the PTY, or null
 * when the event isn't one of the handled chords (the caller then falls back to
 * its normal handling). Verified against VS Code's macOS terminal defaults:
 *
 *   Cmd+Backspace   → \x15 (Ctrl+U)  delete to line start
 *   Option+Backspace→ \x17 (Ctrl+W)  delete word left
 *   Option+Delete   → \x1bd (ESC d)  delete word right (forward)
 *   Cmd+Left        → \x01 (Ctrl+A)  line start
 *   Cmd+Right       → \x05 (Ctrl+E)  line end
 *   Option+Left     → \x1bb (ESC b)  word left
 *   Option+Right    → \x1bf (ESC f)  word right
 *
 * Only macOS is handled for now; on other platforms this always returns null so
 * the standard xterm path is unchanged. Ctrl or Shift held disqualifies the
 * chord (those are distinct, unbound combos — matching VS Code exactly).
 */
export function resolveTerminalKeySequence(e: TerminalKeyEvent, isMac: boolean): string | null {
  if (!isMac) return null
  if (e.ctrlKey || e.shiftKey) return null

  const cmd = e.metaKey && !e.altKey
  const opt = e.altKey && !e.metaKey
  if (!cmd && !opt) return null

  switch (e.key) {
    case 'Backspace':
      if (cmd) return '\x15' // delete to line start
      if (opt) return '\x17' // delete word left
      return null
    case 'Delete': // forward delete (Fn+Delete / full-keyboard Del)
      if (opt) return '\x1bd' // delete word right
      return null
    case 'ArrowLeft':
      if (cmd) return '\x01' // line start
      if (opt) return '\x1bb' // word left
      return null
    case 'ArrowRight':
      if (cmd) return '\x05' // line end
      if (opt) return '\x1bf' // word right
      return null
    default:
      return null
  }
}
