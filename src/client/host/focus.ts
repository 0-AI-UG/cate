// Attention on this client (client state, section 5): which panel is focused
// and which tab each stack shows. Placement for new panels and routing of
// shortcuts derive from these.

import { placementOf, dockOf, dockStacks, type DockStack, type PanelId, type WorkspaceDocument } from '@workspace/document/contract'
import { clientStateFor, documentStoreFor, type ClientState } from '@client/document'

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
  const stacks = dockStacks(dockOf(doc, { canvasId, nodeId }))
  return stacks[0] ? activeTabOf(state.activeTabs, stacks[0]) : focused
}

export function focusedLeafPanelId(workspaceId: string): PanelId | null {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const state = clientStateFor(workspaceId)?.getSnapshot()
  return doc && state ? focusedLeafIn(doc, state) : null
}

