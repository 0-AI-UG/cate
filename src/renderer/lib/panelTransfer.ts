// =============================================================================
// Panel Transfer — serialize/deserialize PanelTransferSnapshot for cross-window
// panel migration.
// =============================================================================

import type { PanelState, PanelTransferSnapshot, PanelLocation, Point, Size } from '../../shared/types'
import { terminalRegistry } from './terminalRegistry'

/**
 * Create a PanelTransferSnapshot from a panel's current state.
 *
 * For terminals: captures the PTY ID and current scrollback content.
 * For editors: captures cursor position, scroll position, and unsaved content.
 * For browsers: captures the current URL.
 */
export function createTransferSnapshot(
  panel: PanelState,
  sourceLocation: PanelLocation,
  geometry: { origin: Point; size: Size },
): PanelTransferSnapshot {
  const snapshot: PanelTransferSnapshot = {
    panel: { ...panel },
    geometry,
    sourceLocation,
  }

  // Terminal-specific: capture PTY ID and scrollback
  if (panel.type === 'terminal') {
    const entry = terminalRegistry.getEntry(panel.id)
    if (entry) {
      snapshot.terminalPtyId = entry.ptyId

      // Capture current scrollback content from the xterm buffer.
      // Only capture up to the cursor row — buffer.length includes empty
      // viewport rows below the cursor which would create spurious blank
      // lines in the new terminal, pushing the prompt to the bottom.
      const terminal = entry.terminal
      const buffer = terminal.buffer.active
      // Exclude the cursor row — the PTY will re-send the prompt line
      // via panelTransferAck, so including it here causes duplication.
      const lastRow = buffer.baseY + buffer.cursorY
      const lines: string[] = []
      for (let i = 0; i < lastRow; i++) {
        const line = buffer.getLine(i)
        if (line) {
          lines.push(line.translateToString(true))
        }
      }
      // Trim any trailing empty lines from the captured content
      while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop()
      }
      snapshot.terminalScrollback = lines.join('\n')
    }
  }

  // Browser-specific: capture URL
  if (panel.type === 'browser' && panel.url) {
    snapshot.browserState = {
      url: panel.url,
      canGoBack: false,
      canGoForward: false,
    }
  }

  return snapshot
}

/**
 * After a transfer snapshot is received and the panel is created in the target
 * window, call this to finalize the transfer (ACK terminal buffering, etc.).
 */
export async function acknowledgeTransfer(snapshot: PanelTransferSnapshot): Promise<void> {
  if (snapshot.terminalPtyId) {
    await window.electronAPI.panelTransferAck(snapshot.terminalPtyId)
  }
}
