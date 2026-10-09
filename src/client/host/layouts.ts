// Layouts of a window on this client: which one it shows (client state, so
// each client can look at a different one, like tmux windows) and the ops that
// add, close and rename them. Every panel stays in exactly one dock; switching
// a layout only changes what this client draws.

import { MAIN_WINDOW, type LayoutId, type WindowId, type WorkspaceDocument } from '@workspace/document/contract'
import type { PanelPlacementOptions } from '@panels/framework/contract'
import { clientStateFor, documentStoreFor, type ClientState } from '@client/document'

/** The layout a window shows: the client's choice while it still exists, else
 *  the window's first. Empty when the window does not exist. */
export function activeLayoutOf(
  doc: WorkspaceDocument,
  activeLayouts: ClientState['activeLayouts'],
  windowId: WindowId,
): LayoutId {
  const layouts = doc.windows[windowId]?.layouts ?? []
  const chosen = activeLayouts[windowId]
  return layouts.find((l) => l.id === chosen)?.id ?? layouts[0]?.id ?? ''
}

/** The layout this client shows in a window right now. */
export function activeLayoutId(workspaceId: string, windowId: WindowId): LayoutId {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const state = clientStateFor(workspaceId)
  return doc && state ? activeLayoutOf(doc, state.getSnapshot().activeLayouts, windowId) : ''
}

/** A new panel's placement that falls back to the layout this client shows
 *  in the main window instead of the first one. */
export function withActiveLayout(workspaceId: string, placement: PanelPlacementOptions): PanelPlacementOptions {
  return placement.layoutId ? placement : { ...placement, layoutId: activeLayoutId(workspaceId, MAIN_WINDOW) }
}

export function switchLayout(workspaceId: string, windowId: WindowId, layoutId: LayoutId): boolean {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const state = clientStateFor(workspaceId)
  if (!doc || !state || !doc.windows[windowId]?.layouts.some((l) => l.id === layoutId)) return false
  state.setActiveLayout(windowId, layoutId)
  return true
}

/** Switches `delta` layouts along the window's switcher, wrapping. */
export function stepLayout(workspaceId: string, windowId: WindowId, delta: number): boolean {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const state = clientStateFor(workspaceId)
  const layouts = doc?.windows[windowId]?.layouts
  if (!doc || !state || !layouts || layouts.length < 2) return false
  const at = layouts.findIndex((l) => l.id === activeLayoutOf(doc, state.getSnapshot().activeLayouts, windowId))
  const next = layouts[(at + delta + layouts.length) % layouts.length]
  state.setActiveLayout(windowId, next.id)
  return true
}

/** Switches to the n-th layout (0-based); false when there is none. */
export function selectLayoutAt(workspaceId: string, windowId: WindowId, index: number): boolean {
  const layout = documentStoreFor(workspaceId)?.getSnapshot().windows[windowId]?.layouts[index]
  return layout ? switchLayout(workspaceId, windowId, layout.id) : false
}

/** Adds an empty layout and shows it. */
export function addLayout(workspaceId: string, windowId: WindowId, name?: string): LayoutId | null {
  const store = documentStoreFor(workspaceId)
  const state = clientStateFor(workspaceId)
  if (!store || !state) return null
  const layoutId = globalThis.crypto.randomUUID()
  const result = store.propose({ kind: 'addLayout', windowId, layoutId, ...(name ? { name } : {}) })
  if (!result.ok) return null
  state.setActiveLayout(windowId, layoutId)
  return layoutId
}

/** Removes a layout with its panels. The caller confirms when it has panels. */
export function removeLayout(workspaceId: string, windowId: WindowId, layoutId: LayoutId): boolean {
  return documentStoreFor(workspaceId)?.propose({ kind: 'removeLayout', windowId, layoutId }).ok ?? false
}

/** Moves a layout to `index` in the window's switcher. */
export function moveLayout(workspaceId: string, windowId: WindowId, layoutId: LayoutId, index: number): boolean {
  return documentStoreFor(workspaceId)?.propose({ kind: 'moveLayout', windowId, layoutId, index }).ok ?? false
}

/** A blank name is refused: a layout keeps the one it has. */
export function renameLayout(workspaceId: string, windowId: WindowId, layoutId: LayoutId, name: string): boolean {
  const trimmed = name.trim()
  return !!trimmed && (documentStoreFor(workspaceId)?.propose({ kind: 'renameLayout', windowId, layoutId, name: trimmed }).ok ?? false)
}
