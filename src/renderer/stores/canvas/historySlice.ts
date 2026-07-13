// =============================================================================
// History slice — undo/redo snapshots of {nodes, selection, selectionActive}.
//
// Delete recovery: a panel delete closes real panel records (appStore) besides
// removing canvas nodes, so a plain node snapshot would undo into ghost nodes.
// deleteSelection/deleteNode therefore run inside a history TRANSACTION whose
// single entry carries the closed PanelState records: undo re-adds the records
// (panels re-instantiate lazily on mount, exactly like session restore) before
// restoring the nodes; redo restores the post-delete nodes and closes the
// panels again.
// =============================================================================

import type { PanelState } from '../../../shared/types'
import type { CanvasGet, CanvasSet, CanvasHistoryEntry, CanvasStoreActions } from './storeTypes'

type HistoryActions = Pick<
  CanvasStoreActions,
  'pushHistory' | 'undo' | 'redo' | 'clearHistory' | 'beginHistoryTransaction' | 'commitHistoryTransaction'
>

// The slice can't import appStore statically (panel/terminal import cycle —
// same reason selectionSlice lazy-imports it), so the delete initiators, which
// already hold the module, register it here before committing a transaction.
// An annotated entry can therefore never be undone/redone without the ref.
interface HistoryAppStore {
  getState(): {
    workspaces: Array<{ id: string; panels: Record<string, PanelState> }>
    addPanel(workspaceId: string, panel: PanelState): void
    closePanel(workspaceId: string, panelId: string): void
  }
}
let historyAppStore: HistoryAppStore | null = null
export function provideAppStoreForHistory(store: HistoryAppStore): void {
  historyAppStore = store
}

/** Re-add the panel records a delete closed, before its nodes render again.
 *  Skips ids that exist again (the user may have recreated one). */
function reopenClosedPanels(closedPanels: NonNullable<CanvasHistoryEntry['closedPanels']>) {
  const state = historyAppStore?.getState()
  const ws = state?.workspaces.find((w) => w.id === closedPanels.workspaceId)
  if (!state || !ws) return
  for (const panel of closedPanels.panels) {
    if (!ws.panels[panel.id]) state.addPanel(closedPanels.workspaceId, panel)
  }
}

/** Close the delete's panels again on redo. Runs after the post-delete node
 *  state is restored, so closePanel finds no canvas node and only tears down
 *  the panel itself (PTY, records, active-panel pointer). */
function recloseClosedPanels(closedPanels: NonNullable<CanvasHistoryEntry['closedPanels']>) {
  const state = historyAppStore?.getState()
  const ws = state?.workspaces.find((w) => w.id === closedPanels.workspaceId)
  if (!state || !ws) return
  for (const panel of closedPanels.panels) {
    if (ws.panels[panel.id]) state.closePanel(closedPanels.workspaceId, panel.id)
  }
}

// Build a snapshot of the current store state. The selection array is CLONED —
// the live array is replaced (not mutated) later, but cloning keeps history
// entries defensively independent of any future in-place edit.
function snapshot(state: {
  nodes: CanvasHistoryEntry['nodes']
  selection: CanvasHistoryEntry['selection']
  selectionActive: boolean
}): CanvasHistoryEntry {
  return {
    nodes: state.nodes,
    selection: [...state.selection],
    selectionActive: state.selectionActive,
  }
}

// Restore an entry, filtering its selection to ids that still exist in its own
// nodes so no dangling ids (e.g. nodes deleted in the undone step) survive.
function restore(entry: CanvasHistoryEntry) {
  return {
    nodes: entry.nodes,
    selection: entry.selection.filter((id) => entry.nodes[id]),
    selectionActive: entry.selectionActive,
  }
}

export function createHistorySlice(set: CanvasSet, get: CanvasGet): HistoryActions {
  // Open transaction's begin-time snapshot (null when no transaction is
  // active). Per store instance via this closure.
  let txSnapshot: CanvasHistoryEntry | null = null

  function appendEntry(entry: CanvasHistoryEntry) {
    const state = get()
    const MAX = 100
    const history = state.history.length >= MAX
      ? [...state.history.slice(1), entry]
      : [...state.history, entry]
    set({ history, future: [] })
  }

  return {
    pushHistory() {
      // A delete transaction owns the single entry for everything it touches —
      // the removeNode calls it triggers must not add their own steps.
      if (txSnapshot) return
      appendEntry(snapshot(get()))
    },

    beginHistoryTransaction() {
      txSnapshot ??= snapshot(get())
    },

    commitHistoryTransaction(closedPanels) {
      if (!txSnapshot) return
      const entry = closedPanels ? { ...txSnapshot, closedPanels } : txSnapshot
      const changed = get().nodes !== txSnapshot.nodes
      txSnapshot = null
      if (changed) appendEntry(entry)
    },

    undo() {
      const state = get()
      if (state.history.length === 0) return
      const prev = state.history[state.history.length - 1]
      // Panel records first, nodes second — a restored node must never render
      // before its panel record exists.
      if (prev.closedPanels) reopenClosedPanels(prev.closedPanels)
      // Carry the annotation onto the future entry so redo knows what to close.
      const current = { ...snapshot(state), closedPanels: prev.closedPanels }
      set({
        ...restore(prev),
        history: state.history.slice(0, -1),
        future: [...state.future, current],
      })
    },

    redo() {
      const state = get()
      if (state.future.length === 0) return
      const next = state.future[state.future.length - 1]
      // Carry the annotation back onto the history entry for the next undo.
      const current = { ...snapshot(state), closedPanels: next.closedPanels }
      set({
        ...restore(next),
        history: [...state.history, current],
        future: state.future.slice(0, -1),
      })
      // Nodes first, panels second — closePanel then finds no canvas node and
      // won't try to remove (and history-push) one.
      if (next.closedPanels) recloseClosedPanels(next.closedPanels)
    },

    clearHistory() {
      set({ history: [], future: [] })
    },
  }
}
