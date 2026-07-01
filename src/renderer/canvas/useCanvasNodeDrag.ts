// =============================================================================
// useCanvasNodeDrag — whole-node drag + single-tab detach for CanvasNode.
// Owns the "1 panel → canvas-node spec" vs ">1 → dock-tab detach spec"
// branching, plus primaryPanel derivation.
// =============================================================================

import React, { useCallback, useMemo } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand'
import type { PanelType } from '../../shared/types'
import { collectPanelIds } from '../../shared/collectPanelIds'
import { useDragOp } from '../drag'
import type { DockStore } from '../stores/dockStore'
import { findStackContainingPanel } from '../stores/dockTreeUtils'
import { useSelectedWorkspace } from '../stores/appStore'
import type { useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { isGroupDragMember } from '../stores/canvas/selectionModel'

export function useCanvasNodeDrag(
  nodeId: string,
  dockStoreApi: StoreApi<DockStore>,
  canvasApi: ReturnType<typeof useCanvasStoreApi>,
) {
  const { handleDragStart: rawHandleDragStart, wasDragged } = useDragOp()

  const layout = useStore(dockStoreApi, (s) => s.zones.center.layout)
  const currentWorkspace = useSelectedWorkspace()

  const primaryPanel = useMemo(() => {
    const pid = collectPanelIds(layout)[0] ?? null
    if (!pid) return null
    return currentWorkspace?.panels[pid] ?? null
  }, [layout, currentWorkspace])
  const primaryPanelType: PanelType = primaryPanel?.type ?? 'editor'

  // Whole-node drag (title bar / empty tab-bar / single-tab tab). When the
  // grabbed node is part of a multi-selection, carry the other selected nodes so
  // the unified drag engine moves the whole group together (commit translates
  // every member by the snapped anchor delta) — no separate group-drag path.
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    const panel = primaryPanel
    if (!panel) return
    const state = canvasApi.getState()
    const node = state.nodes[nodeId]
    const grouped = node && isGroupDragMember(state.selection, nodeId)
    const startOrigin = grouped ? { x: node.origin.x, y: node.origin.y } : undefined
    const members = grouped
      ? state.selection
          .filter((id) => id !== nodeId)
          .map((id) => state.nodes[id])
          .filter((n): n is NonNullable<typeof n> => !!n)
          .map((n) => ({ nodeId: n.id, startOrigin: { x: n.origin.x, y: n.origin.y } }))
      : undefined
    rawHandleDragStart(e, {
      kind: 'canvas-node',
      canvasStoreApi: canvasApi,
      nodeId,
      panelId: panel.id,
      panelType: panel.type,
      panelTitle: panel.title ?? '',
      panel,
      startOrigin,
      members,
    })
  }, [rawHandleDragStart, nodeId, primaryPanel, canvasApi])

  // Single-tab detach drag from a multi-tab mini-dock.
  const handleTabDetachStart = useCallback((e: React.MouseEvent, panelId: string) => {
    const ws = currentWorkspace
    const panel = ws?.panels[panelId]
    if (!panel) return
    const layoutRoot = dockStoreApi.getState().zones.center.layout
    const stack = findStackContainingPanel(layoutRoot, panelId)
    if (!stack) return
    rawHandleDragStart(e, {
      kind: 'dock-tab',
      dockStoreApi,
      zone: 'center',
      stackId: stack.id,
      panelId,
      panelType: panel.type,
      panelTitle: panel.title ?? '',
      sourceNodeId: nodeId,
      sourceCanvasStoreApi: canvasApi,
      panel,
    })
  }, [rawHandleDragStart, nodeId, dockStoreApi, canvasApi, currentWorkspace])

  return {
    handleDragStart,
    handleTabDetachStart,
    primaryPanel,
    primaryPanelType,
    layout,
    wasDragged,
  }
}
