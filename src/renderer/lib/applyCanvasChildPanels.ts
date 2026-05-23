// =============================================================================
// applyCanvasChildPanels — receive-side helper for canvas panel transfers.
//
// When a canvas panel is detached into a new window, the snapshot carries
// PanelState records for each child. Without merging them into the receiving
// window's useAppStore, `resolvePanel` falls back to a generic "Panel" stub
// (no type, no title), because detached windows never bootstrap workspaces.
// =============================================================================

import type { PanelState } from '../../shared/types'
import { useAppStore } from '../stores/appStore'

export function applyCanvasChildPanels(
  workspaceId: string,
  childPanels: Record<string, PanelState>,
): void {
  if (!workspaceId || Object.keys(childPanels).length === 0) return
  useAppStore.setState((state) => {
    const existing = state.workspaces.find((w) => w.id === workspaceId)
    if (existing) {
      return {
        workspaces: state.workspaces.map((w) =>
          w.id === workspaceId
            ? { ...w, panels: { ...w.panels, ...childPanels } }
            : w,
        ),
      }
    }
    // Minimal workspace stub so resolvePanel can find the children. The full
    // workspace record will arrive via session restore / main-window sync.
    return {
      workspaces: [
        ...state.workspaces,
        {
          id: workspaceId,
          name: 'Workspace',
          color: '',
          rootPath: '',
          rootPathError: null,
          isRootPathPending: false,
          panels: { ...childPanels },
          canvasNodes: {},
          regions: {},
          zoomLevel: 1,
          viewportOffset: { x: 0, y: 0 },
          focusedNodeId: null,
        } as any,
      ],
      selectedWorkspaceId: state.selectedWorkspaceId || workspaceId,
    }
  })
}
