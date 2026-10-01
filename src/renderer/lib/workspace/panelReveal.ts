// =============================================================================
// Panel location resolver + reveal — the ONE place that answers "where does
// panel X live in workspace W?" and "bring panel X on screen + make it active".
//
// Before this module, the same probe (dock-location lookup -> zone-tree scan ->
// canvas nodeForPanel) was re-implemented ad hoc in appStore.closePanel,
// WorkspaceTab, CommandPalette, and osNotifications, with the probe ORDER
// differing between call sites (CommandPalette checked canvas first and only
// scanned the singleton canvas store, breaking multi-canvas). This module fixes
// a single probe order — dock first, then canvas across all the workspace's
// canvas panels — so a panel resolves identically regardless of entry point.
// =============================================================================

import { getWorkspaceDockStore } from './dockRegistry'
import {
  ensureCanvasOpsForPanel,
  resolvePanelLocation,
  type ResolvedPanelLocation,
} from './canvasAccess'
import { useAppStore } from '../../stores/appStore'
import { setActivePanel } from '../activePanel'
import { findTabStack, findStackContainingPanel } from '../../stores/dockTreeUtils'
import { replaceInTree } from '../../stores/dockStore'
import { getContainerDockStore } from '../../panels/containerDockRegistry'
import type { DockZonePosition, PanelState } from '../../../shared/types'

// The location facade now lives in canvasAccess (the lowest module owning dock +
// canvas access) so appStore.closePanel can share it without a cycle. Re-exported
// here for existing callers/tests that import it from the reveal module.
export { resolvePanelLocation, type ResolvedPanelLocation }

/**
 * Resolve a panel record by id from the active workspace's panels. Mirrors the
 * ad-hoc `resolvePanel` in DockTabStack/CanvasNode: look it up in the selected
 * workspace's `panels` map. Works in detached panel/dock windows too, where only
 * a stub workspace exists (seeded by applyCanvasChildPanels) — that stub is the
 * selected workspace there. Returns undefined for an unknown id.
 */
export function resolvePanelById(panelId: string): PanelState | undefined {
  const state = useAppStore.getState()
  const ws = state.workspaces.find((w) => w.id === state.selectedWorkspaceId)
  return ws?.panels[panelId]
}

/** Bring a panel's dock tab to the front: show its zone and select its tab.
 *  Returns false only when the workspace has no live dock store. */
function revealDockTab(
  workspaceId: string,
  panelId: string,
  zone: DockZonePosition,
  stackId: string,
): boolean {
  const dock = getWorkspaceDockStore(workspaceId)?.getState()
  if (!dock) return false
  const z = dock.zones[zone]
  if (!z.visible) dock.toggleZone(zone)
  if (z.layout) {
    const stack = findTabStack(z.layout, stackId)
    if (stack) {
      const idx = stack.panelIds.indexOf(panelId)
      if (idx >= 0) dock.setActiveTab(stackId, idx)
    }
  }
  return true
}

/** Bring a panel's placement on screen (dock tab / canvas node / container tab),
 *  recursing outward so a panel inside a container inside a canvas is reachable. */
function revealPlacement(workspaceId: string, panelId: string, depth = 0): boolean {
  const location = resolvePanelLocation(workspaceId, panelId)
  if (!location || depth > 4) return false

  if (location.kind === 'dock') return revealDockTab(workspaceId, panelId, location.zone, location.stackId)

  if (location.kind === 'canvas') {
    // The hosting canvas is itself placed somewhere (dock tab, or a container
    // tab). Focusing the node alone won't switch the on-screen canvas when a
    // DIFFERENT canvas tab is active — so reveal the canvas first, then focus
    // the node inside it.
    revealPlacement(workspaceId, location.canvasPanelId, depth + 1)
    ensureCanvasOpsForPanel(location.canvasPanelId).focusPanelNode(panelId)
    return true
  }

  // Container: reveal the container, then select the child's tab inside it.
  const { containerPanelId } = location
  revealPlacement(workspaceId, containerPanelId, depth + 1)
  const layout = useAppStore.getState().getWorkspace(workspaceId)?.panels[containerPanelId]?.containerLayout
  const stack = layout && findStackContainingPanel(layout, panelId)
  if (!stack) return true
  const index = stack.panelIds.indexOf(panelId)
  const live = getContainerDockStore(containerPanelId)
  if (live) live.getState().setActiveTab(stack.id, index)
  else useAppStore.getState().setPanelContainerLayout(
    workspaceId, containerPanelId, replaceInTree(layout, stack.id, { ...stack, activeIndex: index }),
  )
  return true
}

function revealOnce(workspaceId: string, panelId: string): boolean {
  if (!revealPlacement(workspaceId, panelId)) return false
  setActivePanel(panelId)
  return true
}

/**
 * Bring a panel on screen and make it the active panel: switch to its workspace
 * first if needed, then reveal it in its dock zone (show zone + select tab) or
 * focus/center its canvas node. When `retry` is set, polls briefly for the panel
 * to become locatable (deferred restore + render settle).
 *
 * Returns true once the panel was revealed.
 */
export async function revealPanel(
  workspaceId: string,
  panelId: string,
  options?: { retry?: boolean },
): Promise<boolean> {
  const app = useAppStore.getState()
  if (app.selectedWorkspaceId !== workspaceId) {
    await app.selectWorkspace(workspaceId)
  }

  if (!options?.retry) return revealOnce(workspaceId, panelId)

  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 50))
    if (revealOnce(workspaceId, panelId)) return true
  }
  return false
}
