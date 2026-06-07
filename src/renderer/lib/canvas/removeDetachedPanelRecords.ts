// =============================================================================
// removeDetachedPanelRecords — source-side cleanup after a panel is detached
// into another window.
//
// A detached panel now lives in another renderer process; leaving its record in
// THIS window's appStore makes the workspace overview list a panel that isn't
// here. So once a detach (or a cross-window claim) succeeds we drop the record,
// exactly mirroring the receive side (App.tsx re-adds it via addPanel /
// applyCanvasChildPanels when the panel is dropped back in). This gives one
// consistent rule for every panel kind: the overview lists a panel iff it lives
// in this window.
//
// Uses removePanelRecord (record-only) — NOT closePanel — so a terminal's PTY
// keeps running for the transfer instead of being killed. For a canvas it also
// releases each child's source-side xterm instance (again leaving the PTY
// alive), so the source holds no stale terminal entry once the panel has moved.
// =============================================================================

import type { DockLayoutNode, PanelType } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import { getOrCreateCanvasStoreForPanel, releaseCanvasStoreForPanel } from '../../stores/canvasStore'
import { getNodeDockLayout } from '../workspace/canvasAccess'
import { terminalRegistry } from '../terminal/terminalRegistry'

function collectPanelIds(layout: DockLayoutNode | null | undefined, out: Set<string>): void {
  if (!layout) return
  if (layout.type === 'tabs') {
    for (const id of layout.panelIds) out.add(id)
    return
  }
  for (const child of layout.children) collectPanelIds(child, out)
}

export function removeDetachedPanelRecords(
  workspaceId: string,
  panelId: string,
  panelType: PanelType,
): void {
  const app = useAppStore.getState()

  if (panelType === 'canvas') {
    // The children rode along inside the snapshot's canvasState — drop their
    // records here too, then release the now-orphaned per-panel canvas store so
    // the sidebar's canvas-child resolver stops classifying them as residents.
    const store = getOrCreateCanvasStoreForPanel(panelId)
    const childIds = new Set<string>()
    for (const node of Object.values(store.getState().nodes)) {
      collectPanelIds(getNodeDockLayout(panelId, node.id), childIds)
      if (node.panelId) childIds.add(node.panelId)
    }
    for (const id of childIds) {
      // Dispose the source xterm but DON'T kill the PTY — it's mid-transfer to
      // the detached window (release is a no-op for non-terminal children).
      terminalRegistry.release(id)
      app.removePanelRecord(workspaceId, id)
    }
    releaseCanvasStoreForPanel(panelId)
  }

  app.removePanelRecord(workspaceId, panelId)
}
