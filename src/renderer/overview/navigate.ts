// =============================================================================
// Overview navigation — switch workspaces (and optionally focus a node) from
// the Overview overlay. Reuses the NodeSwitcher center-on-node pattern.
// =============================================================================

import { useAppStore, getWorkspaceCanvasStore } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'

/** Switch to a workspace and close the overlay. */
export async function navigateToWorkspace(workspaceId: string): Promise<void> {
  useUIStore.getState().setShowOverview(false)
  await useAppStore.getState().selectWorkspace(workspaceId)
}

/**
 * Center the viewport on a node in the (already-selected) workspace's canvas
 * store and focus it. The store may not be mounted on the same tick the
 * workspace was selected, so retry across a few animation frames before giving
 * up silently.
 */
function focusNodeWhenReady(workspaceId: string, nodeId: string, attempt = 0): void {
  const store = getWorkspaceCanvasStore(workspaceId)
  const node = store?.getState().nodes[nodeId]
  if (!store || !node) {
    if (attempt < 10) requestAnimationFrame(() => focusNodeWhenReady(workspaceId, nodeId, attempt + 1))
    return
  }
  const state = store.getState()
  state.focusNode(nodeId)
  const zoom = state.zoomLevel
  state.setViewportOffset({
    x: window.innerWidth / 2 - (node.origin.x + node.size.width / 2) * zoom,
    y: window.innerHeight / 2 - (node.origin.y + node.size.height / 2) * zoom,
  })
}

/**
 * Switch to a workspace, close the overlay, and focus a node. `nodeId` is only
 * stable for visited workspaces; pass null for deferred ones (switch only).
 */
export async function navigateToNode(workspaceId: string, nodeId: string | null): Promise<void> {
  useUIStore.getState().setShowOverview(false)
  await useAppStore.getState().selectWorkspace(workspaceId)
  if (nodeId) requestAnimationFrame(() => focusNodeWhenReady(workspaceId, nodeId))
}
