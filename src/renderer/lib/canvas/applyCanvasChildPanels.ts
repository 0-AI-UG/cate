// =============================================================================
// ensurePanelsInAppStore — receive-side helper for panel transfers.
//
// Detached windows are separate renderer processes, each with its own
// useAppStore that never bootstraps a workspace. Without merging transferred
// PanelState records into the receiving window's appStore:
//   - `resolvePanel` falls back to a generic "Panel" stub (no type, no title);
//   - and, crucially, panel components' live writes (BrowserPanel.updatePanelUrl,
//     EditorPanel.setPanelDirty/updatePanelFilePath) become silent no-ops,
//     because setPanelField can't find the panel's workspace.
//
// Populating a minimal stub workspace here makes the detached window's appStore
// the single in-window source of truth: the shells render FROM it and session
// capture reads FROM it, so live url/isDirty edits are never lost.
// =============================================================================

import type { PanelState } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'

export function ensurePanelsInAppStore(
  workspaceId: string,
  panels: Record<string, PanelState>,
): void {
  if (!workspaceId || Object.keys(panels).length === 0) return
  useAppStore.setState((state) => {
    const existing = state.workspaces.find((w) => w.id === workspaceId)
    if (existing) {
      return {
        workspaces: state.workspaces.map((w) =>
          w.id === workspaceId
            ? { ...w, panels: { ...w.panels, ...panels } }
            : w,
        ),
      }
    }
    // Minimal workspace stub so resolvePanel can find the panels AND panel
    // components' field writes land here. The full workspace record will
    // arrive via session restore / main-window sync.
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
          panels: { ...panels },
          canvasNodes: {},
          zoomLevel: 1,
          viewportOffset: { x: 0, y: 0 },
          focusedNodeId: null,
        } as any,
      ],
      selectedWorkspaceId: state.selectedWorkspaceId || workspaceId,
    }
  })
}

/** @deprecated Use {@link ensurePanelsInAppStore}. Kept as a thin alias for the
 *  canvas-children call sites; both do the same merge-or-create-stub work. */
export function applyCanvasChildPanels(
  workspaceId: string,
  childPanels: Record<string, PanelState>,
): void {
  ensurePanelsInAppStore(workspaceId, childPanels)
}
