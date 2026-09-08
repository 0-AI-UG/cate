import { useEffect } from 'react'
import type { WindowDockState } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { useDockStoreApi } from '../stores/DockStoreContext'
import { useUIStore } from '../stores/uiStore'
import { getPanelDef } from '../panels/registry'
import { findFirstTabStack, findStackContainingPanelAcrossZones } from '../stores/dockTreeUtils'
import { resolvePanelLocation, revealPanel } from '../lib/workspace/panelReveal'
import { setPanelField } from '../stores/appStore/helpers'
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
    right: { ...zones.right, layout: null, visible: false, maximized: false },
  }
}

export function useNavigationPanels() {
  const dock = useDockStoreApi()
  const workspaceId = useAppStore((s) => s.selectedWorkspaceId)
  useEffect(() => {
    const migrate = () => {
      const zones = dock.getState().zones
      const next = mergeRightDock(zones)
      if (next !== zones) dock.setState({ zones: next })
    }
    migrate()
    return dock.subscribe(migrate)
  }, [dock])

  useEffect(() => {
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
        (findStackContainingPanelAcrossZones(dock.getState().zones, panel.id) || resolvePanelLocation(workspaceId, panel.id)),
      )
      if (existing) {
        const stack = findStackContainingPanelAcrossZones(dock.getState().zones, existing.id)
        if (stack) {
          const location = dock.getState().getPanelLocation(existing.id)
          if (location?.type === 'dock' && !dock.getState().zones[location.zone].visible) dock.getState().toggleZone(location.zone)
          dock.getState().setActiveTab(stack.id, stack.panelIds.indexOf(existing.id))
        } else {
          void revealPanel(workspaceId, existing.id)
        }
        setActivePanel(existing.id)
        if (type === 'editor') setPanelField(useAppStore.setState, workspaceId, existing.id, (panel) => ({ ...panel, sidebarView: view === 'search' ? 'search' : 'explorer' }))
        return
      }
      const stack = findFirstTabStack(dock.getState().zones.center.layout)
      const id = getPanelDef(type).create({ workspaceId, placement: { target: 'none' } })
      if (!id) return
      dock.getState().dockPanel(id, 'center', stack ? { type: 'split', stackId: stack.id, edge: 'right' } : undefined)
      setActivePanel(id)
      if (type === 'editor') setPanelField(useAppStore.setState, workspaceId, id, (panel) => ({ ...panel, sidebarView: view === 'search' ? 'search' : 'explorer' }))
    }
    apply()
    return useUIStore.subscribe(apply)
  }, [dock, workspaceId])
}
