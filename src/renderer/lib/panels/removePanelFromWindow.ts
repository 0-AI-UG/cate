// =============================================================================
// removePanelFromWindow — drop a panel (and a canvas's children) from THIS
// window. The single owner of the removal matrix:
//
//   reason 'transfer' → the panel now lives in another renderer: xterms are
//     released (PTYs keep running, mid-transfer to the other window), pi
//     sessions disposed (they're renderer-local; the receiver resumes from
//     disk), records dropped so the overview lists a panel iff it lives here.
//     The receive side re-adds everything via addPanel / applyCanvasChildPanels
//     when the panel is dropped back in.
//
//   reason 'close' → the panel is gone for good: PTYs killed, xterms and pi
//     sessions disposed, records dropped.
//
// Does NOT touch dock/canvas layout stores — callers undock the panel or
// remove its node from their own store first (detached shells own their own
// dock store, so a registry-targeted undock here would hit the wrong tree).
// =============================================================================

import type { PanelType } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import type { PanelRemovalReason } from './panelTeardown'
import { teardownPanelFamily } from './panelLifecycle'
import { releasePanelChatsToSidebar } from '../../stores/chatsStore'

export function removePanelFromWindow(
  workspaceId: string,
  panelId: string,
  panelType: PanelType,
  reason: PanelRemovalReason,
): void {
  const app = useAppStore.getState()

  const ws = app.workspaces?.find((w) => w.id === workspaceId)
  const childIds = teardownPanelFamily(panelId, panelType, reason, (id) => ws?.panels[id]?.type)
  if (reason === 'close') {
    releasePanelChatsToSidebar(
      ws?.rootPath ?? '',
      [
        ...(panelType === 'cateAgent' ? [panelId] : []),
        ...[...childIds].filter((id) => ws?.panels[id]?.type === 'cateAgent'),
      ],
    )
  }
  for (const id of childIds) app.removePanelRecord(workspaceId, id)
  app.removePanelRecord(workspaceId, panelId)
}
