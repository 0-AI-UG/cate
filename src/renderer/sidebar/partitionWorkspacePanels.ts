// =============================================================================
// partitionWorkspacePanels — pure grouping logic for the sidebar workspace tree.
//
// Splits a workspace's panels into: canvas panels (parents), the children that
// live on each canvas (keyed by the owning canvas panel id), and free panels
// (docked siblings of the canvases). Kept pure and separate from the component
// so the multi-canvas nesting and ghost-filtering rules are unit-testable.
// =============================================================================

export interface PanelLike {
  id: string
  type: string
}

/** Minimal per-canvas snapshot shape the owner-builder needs: a canvas panel id
 *  and the nodes hosted on it (each node carries a seed `panelId` and an optional
 *  mini-dock `dockLayout` whose panels are also children of this canvas). */
export interface CanvasOwnerSnapshot {
  canvasPanelId: string
  nodes: Array<{ panelId?: string; dockLayout?: DockLayoutNodeLike | null }>
}

/** Structural subset of DockLayoutNode (avoids importing the shared type here). */
export type DockLayoutNodeLike =
  | { type: 'tabs'; panelIds: string[] }
  | { type: unknown; children: DockLayoutNodeLike[] }

function collectDockLayoutPanelIds(
  layout: DockLayoutNodeLike | null | undefined,
  out: Set<string>,
): void {
  if (!layout) return
  if ('panelIds' in layout && Array.isArray((layout as { panelIds?: string[] }).panelIds)) {
    for (const id of (layout as { panelIds: string[] }).panelIds) out.add(id)
    return
  }
  const children = (layout as { children?: DockLayoutNodeLike[] }).children
  if (children) for (const child of children) collectDockLayoutPanelIds(child, out)
}

/**
 * Build a `childPanelId -> owning canvas panel id` map from per-canvas snapshots.
 * Pure (no store/IPC access) so the cold-start sidebar attribution is unit-
 * testable. Each canvas contributes its nodes' seed panel ids plus every panel in
 * each node's mini-dock layout, so a never-mounted SECONDARY canvas's children
 * are attributed to IT — not lumped under the primary. Earlier-listed canvases
 * win a tie (first writer keeps ownership), matching the live path which records
 * the first canvas a child is found on.
 */
export function buildColdStartCanvasChildOwners(
  snapshots: CanvasOwnerSnapshot[],
): Map<string, string> {
  const owners = new Map<string, string>()
  for (const { canvasPanelId, nodes } of snapshots) {
    for (const node of nodes) {
      const ids = new Set<string>()
      collectDockLayoutPanelIds(node.dockLayout, ids)
      if (node.panelId) ids.add(node.panelId)
      for (const id of ids) if (!owners.has(id)) owners.set(id, canvasPanelId)
    }
  }
  return owners
}

export interface WorkspacePanelPartition<P extends PanelLike> {
  /** Canvas-type panels, in input order. */
  canvasPanels: P[]
  /** Children grouped by the id of the canvas panel that hosts them. */
  childrenByCanvas: Record<string, P[]>
  /** Canvas children whose owning canvas panel is gone and no canvas remains. */
  orphanCanvasChildren: P[]
  /** Docked panels that sit beside the canvases (not on any canvas). */
  freePanels: P[]
}

/**
 * @param panelList         All panels in the workspace.
 * @param canvasChildOwners panelId -> the canvas panel id that hosts it. A panel
 *                          absent from this map is not a canvas child.
 * @param dockPlacedIds     Ids that are placed in a dock zone, or null when dock
 *                          placement is unknown (cold start) — in which case
 *                          non-canvas-child panels are shown rather than hidden.
 */
export function partitionWorkspacePanels<P extends PanelLike>(
  panelList: P[],
  canvasChildOwners: Map<string, string>,
  dockPlacedIds: Set<string> | null,
): WorkspacePanelPartition<P> {
  // A canvas lives in this window's center dock zone, so it shows iff it's
  // dock-placed here — same rule as any other panel. A canvas detached into
  // another window is no longer placed here and drops out of the overview.
  // (dockPlacedIds null = placement unknown at cold start → don't filter.)
  const canvasPanels = panelList.filter(
    (p) => p.type === 'canvas' && (!dockPlacedIds || dockPlacedIds.has(p.id)),
  )
  const childrenByCanvas: Record<string, P[]> = {}
  const orphanCanvasChildren: P[] = []
  const freePanels: P[] = []
  for (const p of panelList) {
    if (p.type === 'canvas') continue
    const owner = canvasChildOwners.get(p.id)
    if (owner) {
      // Nest the child under the canvas that actually hosts it. Fall back to
      // the first canvas only if the owning panel has gone missing.
      const target = canvasPanels.some((c) => c.id === owner) ? owner : canvasPanels[0]?.id
      if (target) (childrenByCanvas[target] ||= []).push(p)
      else orphanCanvasChildren.push(p)
    } else if (!dockPlacedIds || dockPlacedIds.has(p.id)) {
      freePanels.push(p)
    }
    // else: ghost — in workspace.panels but referenced by no canvas or dock.
  }
  return { canvasPanels, childrenByCanvas, orphanCanvasChildren, freePanels }
}
