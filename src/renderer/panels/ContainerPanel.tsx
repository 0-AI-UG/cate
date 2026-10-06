// =============================================================================
// ContainerPanel — a panel that hosts its own split/tab tree. It owns a private
// DockStore (single `center` zone), exactly like a canvas node's mini-dock, and
// mirrors the layout into `PanelState.containerLayout` so it persists with the
// panel record. Hosts any panel type except another container
// (see canContain in shared/panels.ts).
// =============================================================================

import React, { useCallback, useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { StoreApi } from 'zustand'
import type { DockTabStack as DockTabStackNode, PanelState } from '../../shared/types'
import { PANEL_DEFINITIONS, excludedChildTypes } from '../../shared/panels'
import { collectPanelIds } from '../../shared/collectPanelIds'
import { useAppStore } from '../stores/appStore'
import { createDockStore, type DockStore } from '../stores/dockStore'
import { DockStoreProvider } from '../stores/DockStoreContext'
import DockLayoutRenderer from '../docking/DockLayoutRenderer'
import DockTabStack from '../docking/DockTabStack'
import { closePanelsWithConfirm } from '../lib/closePanelWithConfirm'
import { PanelHost } from './PanelHost'
import { getPanelDef } from './registry'
import { containerZones, emptyContainerLayout, registerContainerDockStore, unregisterContainerDockStore } from './containerDockRegistry'
import type { PanelProps } from './types'

const EMPTY_PANELS: Record<string, PanelState> = {}

export default function ContainerPanel({ panelId, workspaceId, nodeId = '' }: PanelProps) {
  const panels = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.panels ?? EMPTY_PANELS)

  // Seed once from the persisted layout; after that the DockStore is the
  // runtime authority and the app store is just its mirror.
  const dockStoreApi = useMemo<StoreApi<DockStore>>(
    () => {
      const store = createDockStore({ zones: containerZones(useAppStore.getState().getWorkspace(workspaceId)?.panels[panelId]?.containerLayout ?? emptyContainerLayout()) })
      registerContainerDockStore(panelId, store)
      return store
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [panelId],
  )

  // Register in the effect too: StrictMode's mount → cleanup → mount would otherwise
  // leave a mounted container unregistered (the useMemo above only runs once).
  useEffect(() => {
    registerContainerDockStore(panelId, dockStoreApi)
    return () => unregisterContainerDockStore(panelId, dockStoreApi)
  }, [panelId, dockStoreApi])

  // An empty container shows the same surface picker as a fresh split: a
  // 'surface' placeholder tab that is replaced in place by whatever you choose.
  const addPlaceholder = useCallback(() => {
    const id = getPanelDef('surface').create({ workspaceId, placement: { target: 'none' } })
    if (id) dockStoreApi.getState().dockPanel(id, 'center')
  }, [dockStoreApi, workspaceId])

  useEffect(() => {
    if (collectPanelIds(dockStoreApi.getState().zones.center.layout).length === 0) addPlaceholder()
    return dockStoreApi.subscribe((state, prev) => {
      const layout = state.zones.center.layout
      if (layout === prev.zones.center.layout) return
      // The last panel leaving does NOT close the container: it falls back to the picker.
      if (!layout) { addPlaceholder(); return }
      useAppStore.getState().setPanelContainerLayout(workspaceId, panelId, layout)
    })
  }, [dockStoreApi, workspaceId, panelId, addPlaceholder])

  // Sweep child ids with no panel record (restore mismatch), like CanvasPanel does.
  const orphans = useAppStore(useShallow((s) => {
    const records = s.workspaces.find((w) => w.id === workspaceId)?.panels
    const layout = records?.[panelId]?.containerLayout
    return records ? collectPanelIds(layout).filter((id) => !records[id]) : []
  }))
  useEffect(() => {
    for (const id of orphans) dockStoreApi.getState().undockPanel(id)
  }, [orphans, dockStoreApi])

  // A container sitting on a canvas can't host a canvas (canvas → container → canvas).
  const excluded = useMemo(() => {
    const types = excludedChildTypes('container')
    return nodeId ? [...types, 'canvas' as const] : types
  }, [nodeId])

  const renderPanel = useCallback(
    (childId: string) => <PanelHost panelId={childId} panels={panels} workspaceId={workspaceId} allowCanvas />,
    [panels, workspaceId],
  )
  const getPanel = useCallback((id: string) => panels[id], [panels])
  const getPanelTitle = useCallback((id: string) => {
    const p = panels[id]
    return p?.title || (p?.type ? PANEL_DEFINITIONS[p.type]?.label : undefined) || 'Panel'
  }, [panels])
  const handleClosePanels = useCallback(
    (ids: string[]) => closePanelsWithConfirm(workspaceId, ids, (id) => {
      dockStoreApi.getState().undockPanel(id)
      useAppStore.getState().closePanel(workspaceId, id)
    }),
    [dockStoreApi, workspaceId],
  )
  const handleClosePanel = useCallback((id: string) => { void handleClosePanels([id]) }, [handleClosePanels])

  const renderTabs = (stack: DockTabStackNode): React.ReactNode => (
    <DockTabStack
      key={stack.id}
      stack={stack}
      zone="center"
      renderPanel={renderPanel}
      getPanelTitle={getPanelTitle}
      getPanel={getPanel}
      workspaceId={workspaceId}
      onClosePanel={handleClosePanel}
      onClosePanels={handleClosePanels}
      excludePanelTypes={excluded}
      compact
      localOnly
    />
  )

  return (
    <DockStoreProvider store={dockStoreApi}>
      <ContainerBody dockStoreApi={dockStoreApi} renderTabs={renderTabs} getPanelType={(id) => panels[id]?.type} />
    </DockStoreProvider>
  )
}

function ContainerBody({ dockStoreApi, renderTabs, getPanelType }: {
  dockStoreApi: StoreApi<DockStore>
  renderTabs: (stack: DockTabStackNode) => React.ReactNode
  getPanelType: (id: string) => PanelState['type'] | undefined
}) {
  const layout = React.useSyncExternalStore(
    dockStoreApi.subscribe,
    () => dockStoreApi.getState().zones.center.layout,
  )
  return (
    <div className="h-full w-full min-h-0 min-w-0 overflow-hidden bg-canvas-bg">
      {layout && <DockLayoutRenderer layout={layout} renderTabs={renderTabs} getPanelType={getPanelType} />}
    </div>
  )
}
