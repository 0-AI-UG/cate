// =============================================================================
// useWorkspacePanelTree — the single source of truth for "what panels does this
// workspace contain, and where do they live". Reads the workspace panel registry
// (ws.panels) and joins it against EVERY canvas store's nodes plus the dock
// store, so the result is multi-canvas- and dock-aware and excludes ghosts
// (records placed nowhere) and panels detached into other windows.
//
// Both the sidebar workspace overview (WorkspaceTab) and the Cmd+K command
// palette consume this, so the two can never disagree about which panels exist
// or where they are.
// =============================================================================

import { useMemo, useState, useCallback, useEffect } from 'react'
import { useShallow } from 'zustand/shallow'
import type { PanelState } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import { getOrCreateCanvasStoreForPanel } from '../../stores/canvasStore'
import {
  getCanvasSnapshotForPanel,
  getNodeDockLayout,
  getWorkspaceCanvasPanelIds,
  getWorkspaceDockSnapshot,
} from './canvasAccess'
import { collectPanelIds } from '../../../shared/collectPanelIds'
import { partitionWorkspacePanels, buildColdStartCanvasChildOwners } from '../../sidebar/partitionWorkspacePanels'
import { sortWorkspacePanels } from '../../sidebar/sortWorkspacePanels'

const EMPTY_PANELS: Record<string, PanelState> = {}

export interface WorkspacePanelTree {
  /** The raw workspace panel registry (ws.panels). */
  panels: Record<string, PanelState>
  /** All panels, sorted by type then title. */
  panelList: PanelState[]
  /** Canvas-type panels (parents), in order. */
  canvasPanels: PanelState[]
  /** Children grouped by the canvas panel id that hosts them. */
  childrenByCanvas: Record<string, PanelState[]>
  /** Canvas children whose owning canvas is gone and no canvas remains. */
  orphanCanvasChildren: PanelState[]
  /** Docked panels that sit beside the canvases. */
  freePanels: PanelState[]
  /** Flat list in the overview's render order, ghosts/detached excluded. */
  orderedPanels: PanelState[]
}

// Subscribe to every canvas store in a workspace and return a map of
// canvas-child panel id -> the canvas panel id that hosts it. A workspace can
// host multiple canvas panels, so we scan ALL canvas panels in the workspace.
// We record WHICH canvas owns each child (not merely THAT it lives
// on some canvas), so each child nests under its own canvas instead of
// collapsing them all under the first one.
function useWorkspaceCanvasChildOwners(workspaceId: string): Map<string, string> {
  const canvasPanelIds = useAppStore(useShallow((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    if (!ws) return [] as string[]
    return Object.values(ws.panels)
      .filter((p) => p.type === 'canvas')
      .map((p) => p.id)
  }))

  const stores = useMemo(
    () => canvasPanelIds.map((id) => getOrCreateCanvasStoreForPanel(id)),
    [canvasPanelIds],
  )

  const compute = useCallback(() => {
    const owners = new Map<string, string>()
    for (let i = 0; i < stores.length; i++) {
      const canvasPanelId = canvasPanelIds[i]
      for (const node of Object.values(stores[i].getState().nodes)) {
        // Each canvas node has its own mini-dock layout; a node may host several
        // tabbed panels. Walk the full layout so every tab classifies as a child
        // of this canvas. Read the
        // LIVE per-node DockStore (the runtime authority).
        for (const id of collectPanelIds(getNodeDockLayout(canvasPanelId, node.id))) {
          owners.set(id, canvasPanelId)
        }
      }
    }
    return owners
  }, [stores, canvasPanelIds])

  const [owners, setOwners] = useState<Map<string, string>>(compute)

  useEffect(() => {
    // Recompute immediately on store-set change so we don't render one frame of
    // stale ids after switching workspaces.
    setOwners(compute())
    const unsubs = stores.map((s) => s.subscribe(() => setOwners(compute())))
    return () => {
      for (const fn of unsubs) fn()
    }
  }, [stores, compute])

  return owners
}

export function useWorkspacePanelTree(workspaceId: string): WorkspacePanelTree {
  const panels = useAppStore(useShallow((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return ws?.panels ?? EMPTY_PANELS
  }))

  // Worktrees + rootPath drive the per-worktree grouping below. Read separately
  // (and shallow) so a recolor/add doesn't churn the whole tree, only the order.
  const { worktrees, rootPath } = useAppStore(useShallow((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return { worktrees: ws?.worktrees, rootPath: ws?.rootPath }
  }))

  // Panel list grouped by worktree first (so a worktree's terminals/agents stay
  // together), then by type (canvas, terminal, editor, browser, …), then title.
  const panelList = useMemo(
    () => sortWorkspacePanels(Object.values(panels), worktrees, rootPath),
    [panels, worktrees, rootPath],
  )

  // Set of panel ids living on this workspace's canvases. The reactive hook
  // covers every live canvas store; the resolver fills the cold-start gap for a
  // workspace whose canvas was never mounted (its persisted projection).
  const liveCanvasChildOwners = useWorkspaceCanvasChildOwners(workspaceId)
  const canvasChildOwners = useMemo(() => {
    const owners = new Map<string, string>(liveCanvasChildOwners)
    const coldOwners = buildColdStartCanvasChildOwners(
      getWorkspaceCanvasPanelIds(workspaceId).map((canvasPanelId) => ({
        canvasPanelId,
        nodes: Object.values(getCanvasSnapshotForPanel(canvasPanelId)?.nodes ?? {}),
      })),
    )
    for (const [id, owner] of coldOwners) if (!owners.has(id)) owners.set(id, owner)
    return owners
  }, [liveCanvasChildOwners, workspaceId])

  // The dock-placed id set lets partitioning drop ghosts — panels still in
  // ws.panels but referenced by no canvas or dock. Read live (snapshot
  // resolver); null = unknown (cold start), in which case nothing is filtered so
  // a real panel is never hidden. Read inline (not memoized) so a dock move that
  // re-renders via the canvas-owners subscription re-reads the latest placement.
  const dockSnapshot = getWorkspaceDockSnapshot(workspaceId)
  const dockPlacedIds = dockSnapshot ? new Set(
    Object.values(dockSnapshot.zones).flatMap((zone) => collectPanelIds(zone.layout)),
  ) : null
  const { canvasPanels, childrenByCanvas, orphanCanvasChildren, freePanels } =
    partitionWorkspacePanels(panelList, canvasChildOwners, dockPlacedIds)

  // Flatten to the overview's render order: each canvas followed by its
  // children, then orphaned canvas children, then docked free panels.
  const orderedPanels: PanelState[] = []
  for (const cp of canvasPanels) {
    orderedPanels.push(cp)
    for (const child of childrenByCanvas[cp.id] ?? []) orderedPanels.push(child)
  }
  orderedPanels.push(...orphanCanvasChildren, ...freePanels)

  return { panels, panelList, canvasPanels, childrenByCanvas, orphanCanvasChildren, freePanels, orderedPanels }
}
