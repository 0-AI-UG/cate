// =============================================================================
// useDockTabDrag — tab mousedown handler for DockTabStack.
// In a main-dock / detached-dock stack, dragging a tab dispatches a
// `dock-tab` spec via useDragOp. Canvas-node mini-docks route through
// onTabBarMouseDown instead (which branches between whole-node and detach
// based on panel count) and never reach this handler.
// =============================================================================

import React, { useCallback } from 'react'
import type { StoreApi } from 'zustand'
import type { PanelState } from '../../shared/types'
import { useDragOp } from '../drag'
import { useAppStore } from '../stores/appStore'
import type { DockStore } from '../stores/dockStore'

export function useDockTabDrag(params: {
  stackId: string
  zone: 'left' | 'right' | 'bottom' | 'center'
  dockStoreApi: StoreApi<DockStore>
  getPanel?: (panelId: string) => PanelState | undefined
}) {
  const { stackId, zone, dockStoreApi, getPanel } = params
  const { handleDragStart: rawHandleDragStart } = useDragOp()

  const handleTabMouseDown = useCallback(
    (e: React.MouseEvent, panelId: string) => {
      if (e.button !== 0) return
      let panel: PanelState | undefined
      if (getPanel) {
        panel = getPanel(panelId)
      } else {
        const wsId = useAppStore.getState().selectedWorkspaceId
        const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
        panel = ws?.panels[panelId]
      }
      if (!panel) return
      rawHandleDragStart(e, {
        kind: 'dock-tab',
        dockStoreApi,
        zone,
        stackId,
        panelId,
        panelType: panel.type,
        panelTitle: panel.title,
        panel,
      })
    },
    [stackId, zone, getPanel, dockStoreApi, rawHandleDragStart],
  )

  return { handleTabMouseDown }
}
