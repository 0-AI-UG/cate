// =============================================================================
// scrollbackCapture — the single capture+replay path for a terminal's buffer.
//
// Capture uses xterm's SerializeAddon: it turns the buffer into a string of
// escape sequences that restores the text, ANSI styling, wrapping and cursor
// position verbatim when written to a fresh xterm. Both consumers go through
// here — the live cross-window transfer (panelTransfer / terminalRemount) and
// session/detached-window persistence (captureAndSaveScrollback) — so a detached
// or restored terminal keeps its exact look, colors included, instead of the
// plain monochrome dump the old translateToString() approach produced.
// =============================================================================

import type { SerializeAddon } from '@xterm/addon-serialize'

/**
 * Serialize a terminal's buffer into a replayable string (text + styling +
 * wrapping + cursor), or undefined when there's nothing to capture.
 *
 * The buffer xterm keeps is already bounded by its `scrollback` option, so all
 * available rows are serialized. The alt buffer and terminal modes are
 * EXCLUDED: a captured frame is replayed both into a live reconnect AND, on the
 * next launch, into a freshly-spawned shell. Restoring a dead full-screen app's
 * alternate screen / modes there would trap the new shell in the alt buffer with
 * stale content. In-place renderers (Claude Code, plain shells) live on the
 * normal buffer, so they are captured fully; only a live `vim`/`htop` transfer
 * loses its frame and repaints from the SIGWINCH the reconnect sends anyway.
 */
export function serializeTerminalState(
  entry: { serializeAddon?: SerializeAddon | null },
): string | undefined {
  const addon = entry.serializeAddon
  if (!addon) return undefined
  try {
    const out = addon.serialize({ excludeModes: true, excludeAltBuffer: true })
    return out.length > 0 ? out : undefined
  } catch {
    return undefined
  }
}
