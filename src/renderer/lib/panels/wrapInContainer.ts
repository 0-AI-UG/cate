// Dragging a panel onto the edge of a window-level stack splits the panel under
// it by wrapping that panel in a container: the container takes its tab slot
// and the split happens inside it.

import type { StoreApi } from 'zustand'
import type { DockLayoutNode, PanelType } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import { createDockStore, type DockStore } from '../../stores/dockStore'
import { findTabStack, findZoneForStack, mapDockPanelIds } from '../../stores/dockTreeUtils'
import { containerZones, getContainerDockStore, isContainerDockStore } from '../../panels/containerDockRegistry'
import { findNodeIdForDockStore } from '../../panels/nodeDockRegistry'

/** Returns true when the split was fully applied (dragged panel included).
 *  False means nothing changed and the caller should do a plain dock split. */
export function splitByWrappingInContainer(opts: {
  workspaceId: string
  dockStoreApi: StoreApi<DockStore>
  stackId: string
  edge: 'top' | 'bottom' | 'left' | 'right'
  draggedPanelId: string
  draggedPanelType: PanelType
  /** Called before the wrapped panel is re-parented (arms terminal PTY hand-off). */
  beforeMove?: (panelId: string, type: PanelType) => void
}): boolean {
  const { workspaceId, dockStoreApi, stackId, edge, draggedPanelId, draggedPanelType, beforeMove } = opts
  // Only window-level docks wrap; canvas-node mini-docks and containers split plainly.
  if (isContainerDockStore(dockStoreApi) || findNodeIdForDockStore(dockStoreApi)) return false
  if (draggedPanelType === 'container') return false

  const app = useAppStore.getState()
  const zones = dockStoreApi.getState().zones
  const zone = findZoneForStack(zones, stackId)
  const stack = zone ? findTabStack(zones[zone].layout, stackId) : null
  const targetId = stack?.panelIds[stack.activeIndex]
  const target = targetId ? app.getWorkspace(workspaceId)?.panels[targetId] : undefined
  if (!zone || !stack || !targetId || !target) return false
  if (target.type === 'container') {
    // Already a container: the split lands inside it, at the edge of its whole layout.
    return splitInsideContainer(workspaceId, targetId, edge, draggedPanelId)
  }

  // Build the container's inner layout by splitting [target] with the dragged panel.
  const inner = createDockStore({ zones: containerZones({ type: 'tabs', id: crypto.randomUUID(), panelIds: [targetId], activeIndex: 0 }) })
  const innerStackId = inner.getState().zones.center.layout!.id
  inner.getState().dockPanel(draggedPanelId, 'center', { type: 'split', stackId: innerStackId, edge })
  const layout = inner.getState().zones.center.layout!

  beforeMove?.(targetId, target.type)
  const containerId = app.createContainer(workspaceId, targetId, undefined, { target: 'none' })
  if (!containerId) return false
  app.setPanelContainerLayout(workspaceId, containerId, layout)
  dockStoreApi.setState((state) => ({
    zones: {
      ...state.zones,
      [zone]: { ...state.zones[zone], layout: mapDockPanelIds(state.zones[zone].layout, (id) => (id === targetId ? containerId : id)) },
    },
  }))
  return true
}

function splitInsideContainer(
  workspaceId: string,
  containerId: string,
  edge: 'top' | 'bottom' | 'left' | 'right',
  panelId: string,
): boolean {
  const live = getContainerDockStore(containerId)
  const layout = live
    ? live.getState().zones.center.layout
    : useAppStore.getState().getWorkspace(workspaceId)?.panels[containerId]?.containerLayout
  if (!layout) return false
  const direction = edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical'
  const isAfter = edge === 'right' || edge === 'bottom'
  const added: DockLayoutNode = { type: 'tabs', id: crypto.randomUUID(), panelIds: [panelId], activeIndex: 0 }
  let next: DockLayoutNode
  if (layout.type === 'split' && layout.direction === direction) {
    const children = isAfter ? [...layout.children, added] : [added, ...layout.children]
    next = { ...layout, children, ratios: children.map(() => 1 / children.length) }
  } else {
    next = {
      type: 'split', id: crypto.randomUUID(), direction,
      children: isAfter ? [layout, added] : [added, layout], ratios: [0.5, 0.5],
    }
  }
  if (live) live.setState((state) => ({ zones: { ...state.zones, center: { ...state.zones.center, layout: next } } }))
  else useAppStore.getState().setPanelContainerLayout(workspaceId, containerId, next)
  return true
}
