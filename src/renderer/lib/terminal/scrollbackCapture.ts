// =============================================================================
// scrollbackCapture — the canonical xterm buffer->string extraction reused by
// every call site that previously hand-rolled the baseY+cursorY /
// translateToString(true) / trailing-trim loop.
// =============================================================================

import type { Terminal } from '@xterm/xterm'

export interface CaptureScrollbackOptions {
  /**
   * Exclude the cursor row from the capture. Used by the cross-window transfer /
   * session-persistence paths: the PTY re-sends the prompt line on the receiving
   * side (panelTransferAck) or on replay, so including the cursor row here would
   * duplicate the prompt and push it to the bottom behind blank viewport rows.
   * Defaults to false (include the cursor row), which is what an in-place
   * follow-output capture wants so it keeps its freshest line.
   */
  excludeCursorRow?: boolean
}

/**
 * Extract an xterm buffer's scrollback (including the visible viewport) as a
 * newline-joined string, trimming trailing blank lines. Short-circuits to a
 * previously-captured `entry.scrollback` if present.
 *
 * This is the canonical buffer->string extraction, reused by every call site
 * that previously hand-rolled the same baseY+cursorY / translateToString(true) /
 * trailing-trim loop. Pass `excludeCursorRow` for the transfer/persistence
 * variant that must not duplicate the re-sent prompt line.
 */
export function captureScrollback(
  entry: { terminal?: Terminal; scrollback?: string },
  options: CaptureScrollbackOptions = {},
): string | undefined {
  if (typeof entry.scrollback === 'string') return entry.scrollback
  const terminal = entry.terminal
  if (!terminal) return undefined
  try {
    const buffer = terminal.buffer.active
    // Capture scrollback + the active viewport (baseY rows of history plus the
    // cursor row), so a follow-output terminal keeps its freshest lines. The
    // transfer/persistence variant stops one row short of the cursor.
    const lastRow = buffer.baseY + buffer.cursorY
    const endRow = options.excludeCursorRow ? lastRow : lastRow + 1
    const lines: string[] = []
    let current = ''
    for (let i = 0; i < endRow; i++) {
      const line = buffer.getLine(i)
      // A logical line wider than the terminal is stored as several buffer rows;
      // xterm flags every continuation row `isWrapped`. If the NEXT row
      // continues this one, this segment is not the end of its logical line:
      // keep its FULL width (no trailing-space trim — those spaces are real
      // inter-column padding, e.g. `ls`/`git status`) and don't break the line.
      // Coalescing the wrapped rows back into one logical line lets the
      // destination terminal re-wrap at ITS own width on replay. Joining each
      // buffer row with a hard '\n' (the old behaviour) instead bakes the SOURCE
      // window's wrap points in; a narrower target then wraps each segment AGAIN,
      // scattering multi-column output across the panel.
      const next = buffer.getLine(i + 1)
      const continues = i + 1 < endRow && next != null && next.isWrapped
      current += line ? line.translateToString(!continues) : ''
      if (!continues) {
        lines.push(current)
        current = ''
      }
    }
    // Trim trailing blank lines so a freshly-cleared terminal doesn't carry a
    // wall of empty rows across a transfer / save.
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    return lines.length > 0 ? lines.join('\n') : undefined
  } catch {
    return undefined
  }
}
