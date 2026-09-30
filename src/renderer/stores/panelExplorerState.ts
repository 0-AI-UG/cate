import { notifySessionMutation } from '../lib/workspace/sessionMutations'
import type { PanelExplorerSnapshot, PanelState } from '../../shared/types'
import { useAppStore } from './appStore'

// A Files panel's tree expansion and selection belong to the panel, so they
// survive remounts, window transfers and restarts. Scoped to the root they were
// captured under.
const views = new Map<string, PanelExplorerSnapshot>()

export function panelExplorerState(panelId: string, rootPath: string): PanelExplorerSnapshot | undefined {
  const saved = views.get(panelId)
    ?? useAppStore.getState().workspaces.find(ws => ws.panels[panelId])?.panels[panelId]?.explorerState
  return saved?.rootPath === rootPath ? saved : undefined
}

export function setPanelExplorerState(panelId: string, next: PanelExplorerSnapshot): void {
  const previous = views.get(panelId)
  if (
    previous?.rootPath === next.rootPath &&
    sameList(previous.expandedPaths, next.expandedPaths) &&
    sameList(previous.selectedPaths, next.selectedPaths)
  ) return
  views.set(panelId, next)
  notifySessionMutation()
}

export function capturePanelExplorer(panel: PanelState): PanelState {
  const view = views.get(panel.id)
  return view ? { ...panel, explorerState: view } : panel
}

export function releasePanelExplorerState(panelId: string): void {
  views.delete(panelId)
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}
