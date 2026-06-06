// =============================================================================
// Panel Transfer — serialize/deserialize PanelTransferSnapshot for cross-window
// panel migration.
// =============================================================================

import type { PanelState, PanelTransferSnapshot, PanelLocation, Point, Size } from '../../shared/types'
import { terminalRegistry } from './terminal/terminalRegistry'
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
      // Exclude the cursor row: the PTY re-sends the prompt line via
      // panelTransferAck on the receiving side, so including it here duplicates
      // the prompt and pushes it below blank viewport rows.
      snapshot.terminalScrollback =
        terminalRegistry.captureScrollback(entry, { excludeCursorRow: true }) ?? ''
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

  // Canvas-specific: capture child nodes + viewport AND the PanelState record
  // for each child panel. Without the PanelStates the receiving window can't
  // resolve child panel types/titles and renders generic "Panel" stubs.
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
      viewportOffset: { ...state.viewportOffset },
      zoomLevel: state.zoomLevel,
      childPanels,
    }
  }

  return snapshot
}

