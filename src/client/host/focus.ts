// Attention on this client (client state, section 5): which panel is focused
// and which tab each stack shows. Placement for new panels and routing of
// shortcuts derive from these.

import { hostOfPanel, isNodeHost, placementOf, dockOf, dockStacks, stackBeside, type DockStack, type PanelId, type SplitSide, type WorkspaceDocument } from '@workspace/document/contract'
import { clientStateFor, documentStoreFor, type ClientState } from '@client/document'
import { activeLayoutOf } from './layouts'

/** The tab a stack shows: the client's choice while it is still in the
 *  stack, else the first tab. */
export function activeTabOf(activeTabs: ClientState['activeTabs'], stack: DockStack): PanelId {
  const chosen = activeTabs[stack.id]
  return chosen && stack.panels.includes(chosen) ? chosen : stack.panels[0]
}

export function focusPanel(workspaceId: string, panelId: PanelId | null): void {
  clientStateFor(workspaceId)?.focus(panelId)
}

export function focusedPanelId(workspaceId: string): PanelId | null {
  return clientStateFor(workspaceId)?.getSnapshot().focusedPanelId ?? null
}

/** Makes `panelId` the shown tab of its stack. */
export function selectTab(workspaceId: string, panelId: PanelId): boolean {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const state = clientStateFor(workspaceId)
  const placement = doc ? placementOf(doc, panelId) : null
  if (!state || !placement) return false
  state.setActiveTab(placement.stackId, panelId)
  return true
}

/** The leaf that owns attention. Focus on a canvas panel descends into its
 *  active node's shown tab (a selection without one leaves the canvas the
 *  leaf); any other focused panel is the leaf. */
export function focusedLeafIn(doc: WorkspaceDocument, state: ClientState): PanelId | null {
  const focused = state.focusedPanelId
  if (!focused) return null
  const canvasId = doc.panels[focused]?.canvasId
  if (!canvasId) return doc.panels[focused] ? focused : null
  const nodeId = state.selection[canvasId]?.active
  if (!nodeId) return focused
  const node = doc.canvases[canvasId]?.nodes[nodeId]
  const stacks = dockStacks(node && dockOf(doc, { layoutId: activeLayoutOf(doc, state.activeLayouts, { canvasId, nodeId }) }))
  return stacks[0] ? activeTabOf(state.activeTabs, stacks[0]) : focused
}

export function focusedLeafPanelId(workspaceId: string): PanelId | null {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const state = clientStateFor(workspaceId)?.getSnapshot()
  return doc && state ? focusedLeafIn(doc, state) : null
}


/** Focuses the shown tab of the split pane beside the focused leaf's on `side`; false at the dock's edge. */
export function focusPaneBeside(workspaceId: string, side: SplitSide): boolean {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const state = clientStateFor(workspaceId)
  const leaf = focusedLeafPanelId(workspaceId)
  const placement = doc && leaf ? placementOf(doc, leaf) : null
  const stack = doc && placement ? stackBeside(dockOf(doc, placement.dock), placement.stackId, side) : null
  if (!state || !stack) return false
  state.focus(activeTabOf(state.getSnapshot().activeTabs, stack))
  return true
}

/** Expands the focused pane to fill its window (a split pane) or its canvas (a node), or restores it when it is
 *  expanded; false when the focused panel has nothing to expand (a lone pane, or no focus). */
export function toggleExpandedPane(workspaceId: string): boolean {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const state = clientStateFor(workspaceId)
  const leaf = focusedLeafPanelId(workspaceId)
  const placement = doc && leaf ? placementOf(doc, leaf) : null
  const host = doc && leaf ? hostOfPanel(doc, leaf) : null
  if (!doc || !state || !placement || !host) return false
  const current = state.getSnapshot()
  if (isNodeHost(host)) {
    state.setMaximizedNode(host.canvasId, current.maximizedNodes[host.canvasId] === host.nodeId ? null : host.nodeId)
    state.focus(leaf)
    return true
  }
  const expanded = current.maximizedStacks[host.windowId] === placement.stackId
  if (!expanded && dockOf(doc, placement.dock)?.kind !== 'split') return false
  state.setMaximizedStack(host.windowId, expanded ? null : placement.stackId)
  state.focus(leaf) // the pane's view remounts; focusing again hands the keyboard back to it
  return true
}
