import type { CanvasNodeState, DockLayoutNode, DockStateSnapshot } from './types'

/** Remove obsolete panel records at the persistence boundary. */
export function removedExtensionPanelIds(panels: Record<string, { type: string }>): Set<string> {
  return new Set(Object.entries(panels).filter(([, panel]) => panel.type === 'extension').map(([id]) => id))
}

export function pruneDockLayout(layout: DockLayoutNode | null, removed: Set<string>): DockLayoutNode | null {
  if (!layout) return null
  if (layout.type === 'tabs') {
    const panelIds = layout.panelIds.filter((id) => !removed.has(id))
    if (!panelIds.length) return null
    const active = layout.panelIds[layout.activeIndex]
    return { ...layout, panelIds, activeIndex: Math.max(0, panelIds.indexOf(active)) }
  }
  const kept = layout.children.flatMap((child, index) => {
    const node = pruneDockLayout(child, removed)
    return node ? [{ node, ratio: layout.ratios[index] ?? 1 }] : []
  })
  if (!kept.length) return null
  if (kept.length === 1) return kept[0].node
  const total = kept.reduce((sum, child) => sum + child.ratio, 0)
  return { ...layout, children: kept.map((child) => child.node), ratios: kept.map((child) => total ? child.ratio / total : 1 / kept.length) }
}

export function pruneCanvasNodes(nodes: Record<string, CanvasNodeState>, removed: Set<string>): Record<string, CanvasNodeState> {
  if (!removed.size) return nodes
  return Object.fromEntries(Object.entries(nodes).flatMap(([id, node]) => {
    const dockLayout = pruneDockLayout(node.dockLayout ?? null, removed)
    return dockLayout ? [[id, { ...node, dockLayout }]] : []
  }))
}

export function pruneDockState(state: DockStateSnapshot | undefined, removed: Set<string>): DockStateSnapshot | undefined {
  if (!state || !removed.size) return state
  return { ...state, zones: Object.fromEntries(Object.entries(state.zones).map(([key, zone]) => [key, {
    ...zone, layout: pruneDockLayout(zone.layout, removed),
  }])) as DockStateSnapshot['zones'] }
}
