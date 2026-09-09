import { useEffect } from 'react'
import type { WindowDockState } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { getOrCreateWorkspaceDockStore } from '../lib/workspace/dockRegistry'
import { useUIStore } from '../stores/uiStore'
import { createInteractivePanel } from '../lib/panels/createInteractivePanel'
import { findFirstTabStack } from '../stores/dockTreeUtils'
import { resolvePanelLocation, revealPanel } from '../lib/workspace/panelReveal'
import { getActivePanelId, setActivePanel } from '../lib/activePanel'

/** Preserve the old right dock's tabs and splits inside the main layout. */
export function mergeRightDock(zones: WindowDockState): WindowDockState {
  if (!zones.right.layout) return zones
  const center = zones.center.layout
  return {
    ...zones,
    center: {
      ...zones.center,
      visible: true,
      layout: center ? {
        id: crypto.randomUUID(), type: 'split', direction: 'horizontal',
        children: [center, zones.right.layout], ratios: [0.62, 0.38],
      } : zones.right.layout,
    },
    right: { ...zones.right, layout: null, visible: false },
  }
}

export function useNavigationPanels() {
  const workspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const dock = workspaceId ? getOrCreateWorkspaceDockStore(workspaceId) : null
  useEffect(() => {
    if (!dock) return
    const migrate = () => {
      const zones = dock.getState().zones
      const next = mergeRightDock(zones)
      if (next !== zones) dock.setState({ zones: next })
    }
    migrate()
    return dock.subscribe(migrate)
  }, [dock])

  useEffect(() => {
    if (!dock) return
    const apply = () => {
      const view = useUIStore.getState().requestedNavigationView
      const workspace = useAppStore.getState().getWorkspace(workspaceId)
      if (!view || !workspace) return
      useUIStore.setState({ requestedNavigationView: null })
      // Files are part of the editor surface. Opening Explorer therefore creates
      // or reveals an editor instead of a second, standalone Files panel type.
      const type = view === 'git' ? 'sourceControl' : 'editor'
      const existing = Object.values(workspace.panels).sort((a, b) => Number(b.id === getActivePanelId()) - Number(a.id === getActivePanelId())).find((panel) =>
        (view === 'explorer' ? panel.type === 'editor' : panel.type === type) &&
        resolvePanelLocation(workspaceId, panel.id),
      )
      if (existing) {
        void revealPanel(workspaceId, existing.id)
        if (type === 'editor') useAppStore.getState().setPanelNavigation(workspaceId, existing.id, view === 'search' ? 'search' : 'explorer')
        return
      }
      const stack = findFirstTabStack(dock.getState().zones.center.layout)
      const activeId = getActivePanelId()
      const id = createInteractivePanel(type, { workspaceId, placement: { target: 'none' } }, activeId ? workspace.panels[activeId] : undefined)
      if (!id) return
      dock.getState().dockPanel(id, 'center', stack ? { type: 'split', stackId: stack.id, edge: 'right' } : undefined)
      setActivePanel(id)
      if (type === 'editor') useAppStore.getState().setPanelNavigation(workspaceId, id, view === 'search' ? 'search' : 'explorer')
    }
    apply()
    return useUIStore.subscribe(apply)
  }, [dock, workspaceId])
}
