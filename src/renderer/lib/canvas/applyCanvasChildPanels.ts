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

import type { PanelState, WorkspaceState } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'

export function ensurePanelsInAppStore(
  workspaceId: string,
  panels: Record<string, PanelState>,
  rootPath?: string,
): void {
  // Allow a panel-less call purely to backfill rootPath on an existing stub
  // (e.g. a canvas whose children arrive separately): only bail when there is
  // nothing at all to apply.
  if (!workspaceId || (Object.keys(panels).length === 0 && !rootPath)) return
  useAppStore.setState((state) => {
    const existing = state.workspaces.find((w) => w.id === workspaceId)
    if (existing) {
      return {
        workspaces: state.workspaces.map((w) =>
          w.id === workspaceId
            ? {
                ...w,
                panels: { ...w.panels, ...panels },
                // Backfill a missing root only — never clobber a real one the
                // workspace already resolved.
                rootPath: w.rootPath || rootPath || w.rootPath,
              }
            : w,
        ),
      }
    }
    // Minimal workspace stub so resolvePanel can find the panels AND panel
    // components' field writes land here. The full workspace record will
    // arrive via session restore / main-window sync. Typed against
    // WorkspaceState exactly (no `as any`) so a wrong field can't sneak in.
    const stub: WorkspaceState = {
      id: workspaceId,
      name: 'Workspace',
      color: '',
      rootPath: rootPath ?? '',
      rootPathError: null,
      isRootPathPending: false,
      panels: { ...panels },
      // Match createDefaultWorkspace's shape: an empty worktree registry, and
      // connection/companion/additionalRoots left undefined (the type permits it).
      worktrees: [],
    }
    return {
      workspaces: [...state.workspaces, stub],
      // This branch only runs when no workspace with `workspaceId` exists, so the
      // ONLY correct selection is the stub we just created — never an unrelated id
      // a prior stub/bootstrap may have left in selectedWorkspaceId (a stale `||`
      // value would key the detached window off the wrong workspace).
      selectedWorkspaceId: workspaceId,
    }
  })
}

/** Merge a canvas's child PanelStates into the receiving window's appStore.
 *  Thin wrapper over {@link ensurePanelsInAppStore} that additionally drops any
 *  canvas-typed child — canvas-on-canvas is unsupported, so a malformed
 *  snapshot must not seed a nested-canvas record here (the capture side also
 *  guards). */
export function applyCanvasChildPanels(
  workspaceId: string,
  childPanels: Record<string, PanelState>,
): void {
  const filtered: Record<string, PanelState> = {}
  for (const [id, panel] of Object.entries(childPanels)) {
    if (panel.type === 'canvas') continue
    filtered[id] = panel
  }
  ensurePanelsInAppStore(workspaceId, filtered)
}
