// =============================================================================
// Panel Transfer — serialize/deserialize PanelTransferSnapshot for cross-window
// panel migration.
// =============================================================================

import type { PanelState, PanelTransferSnapshot, PanelLocation, Point, Size, WorktreeMeta } from '../../shared/types'
import { collectPanelIds } from '../../shared/collectPanelIds'
import { terminalRegistry } from './terminal/terminalRegistry'
import { terminalRestoreData } from './terminal/terminalRestoreData'
import { getOrCreateCanvasStoreForPanel } from '../stores/canvasStore'
import { getNodeDockLayout } from './workspace/canvasAccess'
import { applyCanvasChildPanels } from './canvas/applyCanvasChildPanels'

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
  options: {
    resolveChildPanel?: (panelId: string) => PanelState | undefined
    /** Source workspace root, threaded so a detached window's stub workspace
     *  can resolve a cwd for new terminals. */
    workspaceRootPath?: string
    /** Source workspace's worktree registry, threaded so the receiving window can
     *  resolve worktree accent colors for this panel (and a canvas's children). */
    worktrees?: WorktreeMeta[]
  } = {},
): PanelTransferSnapshot {
  const snapshot: PanelTransferSnapshot = {
    panel: { ...panel },
    geometry,
    sourceLocation,
    rootPath: options.workspaceRootPath,
    worktrees: options.worktrees && options.worktrees.length > 0 ? options.worktrees : undefined,
  }

  // Terminal-specific: capture PTY ID and scrollback
  if (panel.type === 'terminal') {
    const entry = terminalRegistry.getEntry(panel.id)
    if (entry) {
      snapshot.terminalPtyId = entry.ptyId
      // Serialize the buffer (text + styling + cursor) so the receiving window
      // reconstructs the terminal verbatim, colors and all.
      snapshot.terminalScrollback = terminalRegistry.serializeTerminalState(entry) ?? ''
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

  // Canvas-specific: capture child nodes + viewport AND, for every child panel
  // the canvas hosts, its PanelState (so the receiver renders real panels, not
  // "Panel" stubs) and — for terminals — its live PTY id + scrollback (so the
  // receiver reconnects to the running process instead of spawning a fresh
  // shell). Walk each node's mini-dock layout so TABBED children transfer too,
  // not just the node's seed panel.
  if (panel.type === 'canvas') {
    const store = getOrCreateCanvasStoreForPanel(panel.id)
    const state = store.getState()
    const childPanels: Record<string, PanelState> = {}
    const childTerminals: Record<string, { ptyId: string; scrollback?: string }> = {}
    for (const node of Object.values(state.nodes)) {
      const childIds = new Set<string>()
      collectPanelIds(getNodeDockLayout(panel.id, node.id), childIds)
      if (node.panelId) childIds.add(node.panelId)
      for (const childId of childIds) {
        const childPanel = options.resolveChildPanel?.(childId)
        // Canvas-on-canvas is unsupported (nodesSlice rejects it at the UI
        // layer). Defensively skip a canvas child so a malformed snapshot can't
        // leave a dangling nested-canvas record in the receiver.
        if (childPanel?.type === 'canvas') continue
        if (childPanel) childPanels[childId] = { ...childPanel }
        const entry = terminalRegistry.getEntry(childId)
        if (entry?.ptyId) {
          childTerminals[childId] = {
            ptyId: entry.ptyId,
            scrollback: terminalRegistry.serializeTerminalState(entry) ?? '',
          }
        }
      }
    }
    snapshot.canvasState = {
      nodes: { ...state.nodes },
      viewportOffset: { ...state.viewportOffset },
      zoomLevel: state.zoomLevel,
      childPanels,
      childTerminals,
    }
  }

  return snapshot
}

/**
 * Receiver side: arm each canvas child terminal for restore when its
 * TerminalPanel mounts, instead of spawning a bare fresh shell. Must run during
 * canvas hydration — before the canvas renders its child nodes — so the hint is
 * in place when getOrCreate() runs. Mirrors the top-level terminal's restore
 * wiring in the shells' PANEL_RECEIVE handlers.
 *
 * LIVE transfer only (`ptyId`): reconnect to the still-running PTY
 * (setPendingTransfer). Cold session restore does NOT flow through here — the
 * receiving shell arms scrollback replay for every terminal panel (children
 * included) by its stable panelId, mirroring the main window.
 */
export function depositCanvasChildTransfers(
  canvasState: PanelTransferSnapshot['canvasState'] | undefined,
): void {
  for (const [panelId, t] of Object.entries(canvasState?.childTerminals ?? {})) {
    if (t.ptyId) terminalRegistry.setPendingTransfer(panelId, t.ptyId, t.scrollback)
  }
}

// =============================================================================
// Receive side — the canonical "a panel arrived in this window" preamble.
//
// Every receive site (dock window receive + init, cross-window drop, and the
// main window's dock-back / cross-window handlers) used to copy-paste the same
// block: deposit the terminal hand-off, then for a canvas panel hydrate its
// per-panel store + child PanelStates + child PTYs. The copies had drifted, so
// these three helpers are now the single source for that block.
// =============================================================================

/** Deposit a transferred/restored panel's terminal hand-off BEFORE it mounts, so
 *  TerminalPanel reconnects to the live PTY (or replays saved scrollback) instead
 *  of spawning a bare shell. No-ops for non-terminal panels. */
export function depositPanelTerminalTransfer(snapshot: PanelTransferSnapshot): void {
  if (snapshot.terminalPtyId) {
    terminalRegistry.setPendingTransfer(snapshot.panel.id, snapshot.terminalPtyId, snapshot.terminalScrollback)
  } else if (snapshot.terminalReplayPtyId && snapshot.panel.type === 'terminal') {
    // Session restore: no live PTY, but a previous run wrote a scrollback log
    // keyed by this panel id — replay it into a freshly spawned PTY on mount.
    terminalRestoreData.set(snapshot.panel.id, { replayFromId: snapshot.panel.id })
  }
}

/** Hydrate ONE canvas panel's per-panel CanvasStore from a captured layout,
 *  seed its child PanelState records into the receiving window's appStore, and
 *  arm its child terminals for reconnect — all BEFORE the canvas mounts, so its
 *  child nodes paint with real panels and live PTYs on the first frame. Shared
 *  by single-snapshot receives and the multi-canvas dock-window init loop. */
export function hydrateCanvasState(
  canvasPanelId: string,
  wsId: string,
  canvasState: NonNullable<PanelTransferSnapshot['canvasState']>,
): void {
  const store = getOrCreateCanvasStoreForPanel(canvasPanelId)
  store.getState().loadWorkspaceCanvas(canvasState.nodes, canvasState.viewportOffset, canvasState.zoomLevel)
  applyCanvasChildPanels(wsId, canvasState.childPanels ?? {})
  depositCanvasChildTransfers(canvasState)
}

/** The canonical receive preamble shared by every site: deposit the panel's
 *  terminal hand-off and, for a canvas panel, hydrate its children. Does NOT add
 *  the panel to appStore or place it — callers pick ensurePanelsInAppStore vs
 *  addPanel and dock vs canvas placement, which differ between window kinds. */
export function hydrateReceivedPanel(wsId: string, snapshot: PanelTransferSnapshot): void {
  depositPanelTerminalTransfer(snapshot)
  if (snapshot.panel.type === 'canvas' && snapshot.canvasState) {
    hydrateCanvasState(snapshot.panel.id, wsId, snapshot.canvasState)
  }
}

