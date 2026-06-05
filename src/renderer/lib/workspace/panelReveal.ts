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
  getWorkspaceCanvasPanelId,
  ensureCanvasOpsForPanel,
  getCanvasOpsById,
} from './canvasAccess'
import { useAppStore } from '../../stores/appStore'
import { setActivePanel } from '../activePanel'
import { findTabStack } from '../../stores/dockTreeUtils'
import type { DockZonePosition } from '../../../shared/types'

export type ResolvedPanelLocation =
  | { kind: 'dock'; zone: DockZonePosition; stackId: string }
  | { kind: 'canvas'; canvasPanelId: string }

/**
 * Locate a panel within a workspace. Fixed probe order:
 *   1. the workspace dock store (live tree, derived location)
 *   2. any canvas panel of the workspace (nodeForPanel)
 * Returns null if the panel is not currently placed anywhere.
 */
export function resolvePanelLocation(
  workspaceId: string,
  panelId: string,
): ResolvedPanelLocation | null {
  const dock = getWorkspaceDockStore(workspaceId)?.getState()
  const dockLocation = dock?.getPanelLocation(panelId)
  if (dockLocation?.type === 'dock') {
    return { kind: 'dock', zone: dockLocation.zone, stackId: dockLocation.stackId }
  }

  // Scan every canvas panel in the workspace (a workspace may host several
  // canvases; the primary one is preferred but we check all).
  const primary = getWorkspaceCanvasPanelId(workspaceId)
  const candidateCanvasIds = new Set<string>()
  if (primary) candidateCanvasIds.add(primary)
  const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
  if (ws) {
    for (const p of Object.values(ws.panels)) {
      if (p.type === 'canvas') candidateCanvasIds.add(p.id)
    }
  }
  for (const canvasPanelId of candidateCanvasIds) {
    const ops = getCanvasOpsById(canvasPanelId) ?? ensureCanvasOpsForPanel(canvasPanelId)
    if (ops.storeApi.getState().nodeForPanel(panelId)) {
      return { kind: 'canvas', canvasPanelId }
    }
  }
  return null
}

function revealOnce(workspaceId: string, panelId: string): boolean {
  const location = resolvePanelLocation(workspaceId, panelId)
  if (!location) return false

  if (location.kind === 'dock') {
    const dock = getWorkspaceDockStore(workspaceId)?.getState()
    if (!dock) return false
    const zone = dock.zones[location.zone]
    if (!zone.visible) dock.toggleZone(location.zone)
    if (zone.layout) {
      const stack = findTabStack(zone.layout, location.stackId)
      if (stack) {
        const idx = stack.panelIds.indexOf(panelId)
        if (idx >= 0) dock.setActiveTab(location.stackId, idx)
      }
    }
  } else {
    ensureCanvasOpsForPanel(location.canvasPanelId).focusPanelNode(panelId)
  }

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
