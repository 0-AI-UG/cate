// Maximize and minimize as client state (docs/dock-rules.md). A presentation
// changes only how this client draws a dock, never the document:
// - merge: a window's split tree is drawn as one stack of all its tabs;
// - promote: one pane of a canvas node is drawn as a tab beside its canvas,
//   and the canvas view leaves it out of the node.
// Minimize drops the presentation. Any structural change to the presented
// dock (or a promoted pane's node) consumes it for good; tab selection and
// split ratios do not. A user edit made through a presented dock first turns
// the presentation into real placement (`materialize`), so the edit keeps
// the topology the user saw.

import {
  canvasPanelOf,
  dockOf,
  dockPanels,
  findStack,
  insertTab,
  isCanvasDock,
  placementOf,
  removeFromDock,
  sameDockStructure,
  type DocChange,
  type DockNode,
  type DockRef,
  type PanelId,
  type StackId,
  type WindowId,
  type WorkspaceDocument,
} from '@workspace/document/contract'
import { clientStateFor, documentStoreFor } from '@client/document'

export type DockPresentation =
  | {
      kind: 'merge'
      windowId: WindowId
      /** The stack that holds every tab while merged; the chosen leaf. */
      stackId: StackId
      /** The window tree the merge was made from. */
      expected: DockNode
    }
  | {
      kind: 'promote'
      windowId: WindowId
      /** The window stack that shows the canvas, where the pane is drawn. */
      stackId: StackId
      /** The canvas panel the promoted tab is drawn after. */
      after: PanelId
      panelId: PanelId
      canvasId: string
      nodeId: string
      expectedWindow: DockNode
      expectedNode: DockNode
    }

type Listener = () => void

export interface PresentationStore {
  getSnapshot(): readonly DockPresentation[]
  subscribe(listener: Listener): () => void
  /** Draws the window's whole tree as `stackId`'s tabs. Ignored while any
   *  presentation is active (merges never nest). */
  merge(windowId: WindowId, stackId: StackId): boolean
  /** Draws a canvas pane beside its canvas. Ignored during a merge and for a
   *  pane already promoted. */
  promote(panelId: PanelId): boolean
  /** Minimize: drop a presentation still valid. */
  restore(presentation: DockPresentation): boolean
  /** Drops presentations the document no longer matches. */
  check(doc: WorkspaceDocument): void
  dispose(): void
}

function stillValid(doc: WorkspaceDocument, p: DockPresentation): boolean {
  if (p.kind === 'merge') return sameDockStructure(doc.windows[p.windowId]?.dock ?? null, p.expected)
  return sameDockStructure(doc.windows[p.windowId]?.dock ?? null, p.expectedWindow)
    && sameDockStructure(dockOf(doc, { canvasId: p.canvasId, nodeId: p.nodeId }) ?? null, p.expectedNode)
}

export function createPresentationStore(
  getDocument: () => WorkspaceDocument | null,
  onShown?: (stackId: StackId, panelId: PanelId) => void,
): PresentationStore {
  let list: readonly DockPresentation[] = []
  const listeners = new Set<Listener>()
  const set = (next: readonly DockPresentation[]) => {
    if (next === list) return
    list = next
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => list,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    merge(windowId, stackId) {
      const doc = getDocument()
      const tree = doc?.windows[windowId]?.dock
      if (!doc || !tree || list.length > 0 || tree.kind !== 'split' || !findStack(tree, stackId)) return false
      set([{ kind: 'merge', windowId, stackId, expected: tree }])
      return true
    },
    promote(panelId) {
      const doc = getDocument()
      if (!doc || list.some((p) => p.kind === 'merge' || (p.kind === 'promote' && p.panelId === panelId))) return false
      const placement = placementOf(doc, panelId)
      if (!placement || !isCanvasDock(placement.dock)) return false
      const { canvasId, nodeId } = placement.dock
      const host = canvasPanelOf(doc, canvasId)
      const hostPlacement = host ? placementOf(doc, host.id) : null
      if (!host || !hostPlacement || isCanvasDock(hostPlacement.dock)) return false
      const windowId = hostPlacement.dock.windowId
      const expectedWindow = doc.windows[windowId]?.dock
      const expectedNode = dockOf(doc, placement.dock)
      if (!expectedWindow || !expectedNode) return false
      set([...list, {
        kind: 'promote', windowId, stackId: hostPlacement.stackId, after: host.id, panelId, canvasId, nodeId,
        expectedWindow, expectedNode,
      }])
      onShown?.(hostPlacement.stackId, panelId)
      return true
    },
    restore(presentation) {
      const doc = getDocument()
      if (!list.includes(presentation) || !doc || !stillValid(doc, presentation)) return false
      set(list.filter((p) => p !== presentation))
      return true
    },
    check(doc) {
      const kept = list.filter((p) => stillValid(doc, p))
      if (kept.length !== list.length) set(kept)
    },
    dispose() {
      listeners.clear()
      list = []
    },
  }
}

// --- Per workspace ---------------------------------------------------------------

const stores = new Map<string, { store: PresentationStore; stop: (() => void) | null }>()

/** The workspace's presentations; follows its document once it is open. */
export function presentationsFor(workspaceId: string): PresentationStore {
  let entry = stores.get(workspaceId)
  if (!entry) {
    const store = createPresentationStore(
      () => documentStoreFor(workspaceId)?.getSnapshot() ?? null,
      (stackId, panelId) => clientStateFor(workspaceId)?.setActiveTab(stackId, panelId),
    )
    entry = { store, stop: null }
    stores.set(workspaceId, entry)
  }
  const document = documentStoreFor(workspaceId)
  if (!entry.stop && document) {
    const { store } = entry
    entry.stop = document.subscribe(() => store.check(document.getSnapshot()))
  }
  return entry.store
}

/** Tests only. */
export function resetPresentations(): void {
  for (const { store, stop } of stores.values()) {
    stop?.()
    store.dispose()
  }
  stores.clear()
}

// --- Drawing ---------------------------------------------------------------------

/** The tree a window is drawn with under the presentations. */
export function presentedWindowDock(
  doc: WorkspaceDocument,
  windowId: WindowId,
  presentations: readonly DockPresentation[],
): DockNode | null {
  let tree = doc.windows[windowId]?.dock ?? null
  if (!tree) return null
  for (const p of presentations) {
    if (p.windowId !== windowId) continue
    if (p.kind === 'merge') tree = { kind: 'stack', id: p.stackId, panels: dockPanels(tree) }
    else if (findStack(tree, p.stackId) && doc.panels[p.panelId]) tree = insertTab(tree, p.stackId, p.panelId, p.after)
  }
  return tree
}

/** Panels drawn outside their canvas node. */
export function promotedPanels(presentations: readonly DockPresentation[]): Set<PanelId> {
  return new Set(presentations.flatMap((p) => p.kind === 'promote' ? [p.panelId] : []))
}

/** A node's mini dock without its promoted panes; null when every pane is
 *  promoted (the canvas view then leaves the node out). */
export function presentedNodeDock(
  doc: WorkspaceDocument,
  canvasId: string,
  nodeId: string,
  presentations: readonly DockPresentation[],
): DockNode | null {
  let tree: DockNode | null = dockOf(doc, { canvasId, nodeId }) ?? null
  for (const p of presentations) {
    if (!tree) break
    if (p.kind === 'promote' && p.canvasId === canvasId && p.nodeId === nodeId) tree = removeFromDock(tree, p.panelId).dock
  }
  return tree
}

/** The tree a dock is drawn with. */
export function presentedDock(
  doc: WorkspaceDocument,
  dock: DockRef,
  presentations: readonly DockPresentation[],
): DockNode | null {
  return isCanvasDock(dock)
    ? presentedNodeDock(doc, dock.canvasId, dock.nodeId, presentations)
    : presentedWindowDock(doc, dock.windowId, presentations)
}

/** Changes that make what a window shows real: merged tabs become one stack,
 *  promoted panes become tabs beside their canvas. Empty when nothing is
 *  presented there. Prepended to a user's edit in the same batch. */
export function materialize(
  doc: WorkspaceDocument,
  windowId: WindowId,
  presentations: readonly DockPresentation[],
): DocChange[] {
  const out: DocChange[] = []
  for (const p of presentations) {
    if (p.windowId !== windowId || !stillValid(doc, p)) continue
    const dock = { windowId }
    if (p.kind === 'merge') {
      let after: PanelId | null = null
      for (const panelId of dockPanels(p.expected)) {
        out.push({ kind: 'placePanel', id: panelId, at: { to: 'stack', dock, stackId: p.stackId, after } })
        after = panelId
      }
    } else {
      out.push({ kind: 'placePanel', id: p.panelId, at: { to: 'stack', dock, stackId: p.stackId, after: p.after } })
    }
  }
  return out
}

/** Changes that make the presentations of the dock an edit goes through real.
 *  A canvas node dock has none of its own. */
export function materializeDock(doc: WorkspaceDocument, dock: DockRef, presentations: readonly DockPresentation[]): DocChange[] {
  return isCanvasDock(dock) ? [] : materialize(doc, dock.windowId, presentations)
}

