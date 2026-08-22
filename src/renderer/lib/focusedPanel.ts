import { activeDockPanelId } from '../../shared/collectPanelIds'
import { getActivePanelId } from './activePanel'
import { getCanvasOpsById } from './workspace/canvasAccess'
import { useAppStore } from '../stores/appStore'
import { focusedNodeId as focusedNodeIdOf } from '../stores/canvas/selectionModel'
import { getNodeActivePanelId } from '../panels/nodeDockRegistry'

/** The leaf panel that currently owns the user's attention. A regular dock
 * records the leaf directly; a canvas records its container, so descend into
 * the focused node's live mini-dock. */
export function getFocusedLeafPanelId(): string | null {
  const activeId = getActivePanelId()
  if (!activeId) return null

  const app = useAppStore.getState()
  const activePanel = app.workspaces
    .find((workspace) => workspace.id === app.selectedWorkspaceId)
    ?.panels[activeId]
  if (activePanel?.type !== 'canvas') return activeId

  const canvas = getCanvasOpsById(activeId)?.storeApi.getState()
  const focusedNodeId = canvas ? focusedNodeIdOf(canvas) : null
  if (!canvas || !focusedNodeId) return activeId

  return getNodeActivePanelId(activeId, focusedNodeId)
    ?? activeDockPanelId(canvas.nodes[focusedNodeId]?.dockLayout)
    ?? activeId
}

export const RENAME_PANEL_EVENT = 'rename-panel'

export interface RenamePanelEventDetail {
  panelId: string
}

export function requestPanelRename(panelId: string): void {
  window.dispatchEvent(new CustomEvent<RenamePanelEventDetail>(
    RENAME_PANEL_EVENT,
    { detail: { panelId } },
  ))
}
