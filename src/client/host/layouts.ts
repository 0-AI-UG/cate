// Layouts of a host (a window or a canvas node) on this client: which one it
// shows (client state, so each client can look at a different one, like tmux
// windows) and the ops that add, close, move and rename them. Every panel
// stays in exactly one dock; switching a layout only changes what this client
// draws, and moving one changes which host holds it.

import {
  hostKey,
  layoutOf,
  layoutsIn,
  MAIN_WINDOW,
  nodeOfPanel,
  placementOf,
  type HostRef,
  type LayoutId,
  type LayoutTarget,
  type PanelId,
  type WorkspaceDocument,
} from '@workspace/document/contract'
import type { PanelPlacementOptions } from '@panels/framework/contract'
import { clientStateFor, documentStoreFor, type ClientState, type ClientStateStore } from '@client/document'

const MAIN: HostRef = { windowId: MAIN_WINDOW }

/** The layout a host shows: the client's choice while it still exists, else
 *  the host's first. Empty when the host does not exist. */
export function activeLayoutOf(
  doc: WorkspaceDocument,
  activeLayouts: ClientState['activeLayouts'],
  host: HostRef,
): LayoutId {
  const layouts = layoutsIn(doc, host) ?? []
  const chosen = activeLayouts[hostKey(host)]
  return layouts.find((l) => l.id === chosen)?.id ?? layouts[0]?.id ?? ''
}

/** The layout this client shows in a host right now. */
export function activeLayoutId(workspaceId: string, host: HostRef): LayoutId {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const state = clientStateFor(workspaceId)
  return doc && state ? activeLayoutOf(doc, state.getSnapshot().activeLayouts, host) : ''
}

/** Shows the layouts a panel is in on this client: its window's layout, and
 *  its node's layout when it sits on a canvas. */
export function showLayoutsOf(state: ClientStateStore, doc: WorkspaceDocument, panelId: PanelId): void {
  const layout = layoutOf(doc, panelId)
  if (layout) state.setActiveLayout(layout.windowId, layout.layoutId)
  const node = nodeOfPanel(doc, panelId)
  const dock = placementOf(doc, panelId)?.dock
  if (node && dock) state.setActiveLayout(node.nodeId, dock.layoutId)
}

/** A new panel's placement that falls back to the layout this client shows
 *  in the main window instead of the first one. */
export function withActiveLayout(workspaceId: string, placement: PanelPlacementOptions): PanelPlacementOptions {
  return placement.layoutId ? placement : { ...placement, layoutId: activeLayoutId(workspaceId, MAIN) }
}

export function switchLayout(workspaceId: string, host: HostRef, layoutId: LayoutId): boolean {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const state = clientStateFor(workspaceId)
  if (!doc || !state || !layoutsIn(doc, host)?.some((l) => l.id === layoutId)) return false
  state.setActiveLayout(hostKey(host), layoutId)
  return true
}

/** Switches `delta` layouts along the host's switcher, wrapping. */
export function stepLayout(workspaceId: string, host: HostRef, delta: number): boolean {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const state = clientStateFor(workspaceId)
  const layouts = doc && layoutsIn(doc, host)
  if (!doc || !state || !layouts || layouts.length < 2) return false
  const at = layouts.findIndex((l) => l.id === activeLayoutOf(doc, state.getSnapshot().activeLayouts, host))
  const next = layouts[(at + delta + layouts.length) % layouts.length]
  state.setActiveLayout(hostKey(host), next.id)
  return true
}

/** Switches to the n-th layout (0-based); false when there is none. */
export function selectLayoutAt(workspaceId: string, host: HostRef, index: number): boolean {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const layout = doc && layoutsIn(doc, host)?.[index]
  return layout ? switchLayout(workspaceId, host, layout.id) : false
}

/** Adds an empty layout and shows it. */
export function addLayout(workspaceId: string, host: HostRef, name?: string): LayoutId | null {
  const store = documentStoreFor(workspaceId)
  const state = clientStateFor(workspaceId)
  if (!store || !state) return null
  const layoutId = globalThis.crypto.randomUUID()
  const result = store.propose({ kind: 'addLayout', host, layoutId, ...(name ? { name } : {}) })
  if (!result.ok) return null
  state.setActiveLayout(hostKey(host), layoutId)
  return layoutId
}

/** Removes a layout with its panels. The caller confirms when it has panels. */
export function removeLayout(workspaceId: string, layoutId: LayoutId): boolean {
  return documentStoreFor(workspaceId)?.propose({ kind: 'removeLayout', layoutId }).ok ?? false
}

/** Moves a layout to another host, or to another place in its own switcher.
 *  The destination shows it. */
export function moveLayout(workspaceId: string, layoutId: LayoutId, to: LayoutTarget): boolean {
  const state = clientStateFor(workspaceId)
  const ok = documentStoreFor(workspaceId)?.propose({ kind: 'moveLayout', layoutId, to }).ok ?? false
  if (ok && state) {
    const host: HostRef = to.to === 'host' ? to.host : to.to === 'window' ? { windowId: to.windowId } : { canvasId: to.canvasId, nodeId: to.nodeId }
    state.setActiveLayout(hostKey(host), layoutId)
  }
  return ok
}

/** A blank name is refused: a layout keeps the one it has. */
export function renameLayout(workspaceId: string, layoutId: LayoutId, name: string): boolean {
  const trimmed = name.trim()
  return !!trimmed && (documentStoreFor(workspaceId)?.propose({ kind: 'renameLayout', layoutId, name: trimmed }).ok ?? false)
}
