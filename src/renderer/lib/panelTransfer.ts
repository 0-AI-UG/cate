// =============================================================================
// Panel Transfer — serialize/deserialize PanelTransferSnapshot for cross-window
// panel migration.
// =============================================================================

import type { PanelState, PanelTransferSnapshot, PanelLocation, Point, Size } from '../../shared/types'
import { terminalRegistry } from './terminalRegistry'
import { getOrCreateCanvasStoreForPanel } from '../stores/canvasStore'

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
  options: { resolveChildPanel?: (panelId: string) => PanelState | undefined } = {},
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

  // Editor-specific: capture unsaved content
  if (panel.type === 'editor') {
    snapshot.editorState = {
      cursorPosition: { line: 1, column: 1 },
      scrollTop: 0,
      unsavedContent: panel.unsavedContent,
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

  // Canvas-specific: capture child nodes + regions + viewport AND the PanelState
  // record for each child panel. Without the PanelStates the receiving window
  // can't resolve child panel types/titles and renders generic "Panel" stubs.
  if (panel.type === 'canvas') {
    const store = getOrCreateCanvasStoreForPanel(panel.id)
    const state = store.getState()
    const childPanels: Record<string, PanelState> = {}
    if (options.resolveChildPanel) {
      for (const node of Object.values(state.nodes)) {
        const childPanel = options.resolveChildPanel(node.panelId)
        if (childPanel) childPanels[node.panelId] = { ...childPanel }
      }
    }
    snapshot.canvasState = {
      nodes: { ...state.nodes },
      regions: { ...state.regions },
      viewportOffset: { ...state.viewportOffset },
      zoomLevel: state.zoomLevel,
      childPanels,
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

