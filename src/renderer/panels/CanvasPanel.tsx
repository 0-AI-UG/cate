// =============================================================================
// CanvasPanel — a full canvas workspace that lives as a panel in any dock zone.
// Each instance gets its own CanvasStore for independent viewport/zoom/nodes.
// The first canvas created uses the default singleton store for compatibility.
// =============================================================================

import React, { useMemo, useCallback, useEffect } from 'react'
import { useRenderCount } from '../lib/perf/perfClient'
import { getOrCreateCanvasStoreForPanel, useNodeIds, useVisibleNodeIds } from '../stores/canvasStore'
import { CanvasStoreProvider, useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'
import Canvas from '../canvas/Canvas'
import CanvasNode from '../canvas/CanvasNode'
import CanvasToolbar from '../canvas/CanvasToolbar'
import WelcomePage from '../ui/WelcomePage'
import { EmptyCanvasOverlay } from './EmptyCanvasOverlay'
import type { PanelType, Point, DockLayoutNode, PanelLocation, WindowDockState } from '../../shared/types'
import { useAppStore, useSelectedWorkspace, registerCanvasOps, unregisterCanvasOps, type PanelPlacement } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand'
import { ensureWorkspaceFolder } from '../hooks/useShortcuts'
import { createCanvasOps } from '../lib/canvas/canvasBridge'
import { setActivePanel } from '../lib/activePanel'
import { createDockStore, type DockStore } from '../stores/dockStore'
import {
  registerNodeDockStore,
  unregisterNodeDockStore,
  getNodeDockStore,
  findNodeDockStore,
  findNodeIdForDockStore,
} from './nodeDockRegistry'
import { getPanelDef } from '../panels/registry'

// Re-export the lookup helpers so existing callers (drag dispatcher, drop
// resolver) keep working through the same import path. New code should import
// directly from './nodeDockRegistry' to skip the heavy CanvasPanel module.
export { findNodeDockStore, findNodeIdForDockStore }

// ---------------------------------------------------------------------------
// Helper — walk a DockLayoutNode tree and collect panel locations
// ---------------------------------------------------------------------------
function collectLocationsFromLayout(
  layout: DockLayoutNode | null | undefined,
  zone: 'center',
): Record<string, PanelLocation> {
  const locations: Record<string, PanelLocation> = {}
  if (!layout) return locations

  function walk(node: DockLayoutNode) {
    if (node.type === 'tabs') {
      for (const panelId of node.panelIds) {
        locations[panelId] = { type: 'dock', zone, stackId: node.id }
      }
    } else {
      for (const child of node.children) {
        walk(child)
      }
    }
  }

  walk(layout)
  return locations
}

interface CanvasPanelProps {
  panelId: string
  workspaceId: string
  nodeId: string
  /** Render function for panel content inside canvas nodes */
  renderPanelContent?: (panelId: string, nodeId: string, zoomLevel: number) => React.ReactNode
}

// ---------------------------------------------------------------------------
// CanvasNodeWrapper — reads its own node slice so re-renders stay local
// ---------------------------------------------------------------------------

const CanvasNodeWrapper = React.memo(({ nodeId, canvasPanelId, renderPanelContent }: {
  nodeId: string
  canvasPanelId: string
  renderPanelContent?: (panelId: string, nodeId: string, zoomLevel: number) => React.ReactNode
}) => {
  useRenderCount('CanvasNodeWrapper')
  const node = useCanvasStoreContext((s) => s.nodes[nodeId])
  const isFocused = useCanvasStoreContext((s) => s.focusedNodeId === nodeId)
  const currentWorkspace = useSelectedWorkspace()
  const canvasStoreApi = useCanvasStoreApi()

  // ------------------------------------------------------------------
  // Create (or reuse) the per-node DockStore, keyed by canvasPanelId:nodeId
  // ------------------------------------------------------------------
  const storeKey = `${canvasPanelId}:${nodeId}`
  const dockStoreApi = useMemo<StoreApi<DockStore>>(() => {
    const existing = getNodeDockStore(canvasPanelId, nodeId)
    if (existing) return existing

    const dockLayout = node?.dockLayout ?? null
    const initial: { zones: WindowDockState; locations: Record<string, PanelLocation> } = {
      zones: {
        left:   { position: 'left',   visible: false, size: 260, layout: null },
        right:  { position: 'right',  visible: false, size: 260, layout: null },
        bottom: { position: 'bottom', visible: false, size: 240, layout: null },
        center: { position: 'center', visible: true,  size: 0,   layout: dockLayout },
      },
      locations: collectLocationsFromLayout(dockLayout, 'center'),
    }
    const store = createDockStore(initial)
    registerNodeDockStore(canvasPanelId, nodeId, store)
    return store
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeKey]) // intentionally omit node.dockLayout — seed only on first creation

  // ------------------------------------------------------------------
  // Mirror the live per-node DockStore (the runtime editing authority) into
  // canvasStore.node.dockLayout, and auto-remove the node when its mini-dock
  // empties out.
  //
  // node.dockLayout is the canonical PERSISTED projection of the layout: it is
  // what history snapshots capture (undo/redo), what off-screen/unmounted nodes
  // read back through getNodeDockLayout, and what is written to disk. Keeping it
  // in lock-step with the live store here means it can never drift — readers go
  // through one resolver (getNodeDockLayout: live while mounted, this projection
  // otherwise) and the two always agree. (R3's persistence work made this
  // projection actually round-trip to disk; this keeps it current in memory.)
  // ------------------------------------------------------------------
  useEffect(() => {
    const unsubscribe = dockStoreApi.subscribe((state, prev) => {
      const layout = state.zones.center.layout
      const prevLayout = prev.zones.center.layout
      if (layout === prevLayout) return

      if (layout === null) {
        canvasStoreApi.getState().removeNode(nodeId)
      } else {
        canvasStoreApi.getState().setNodeDockLayout(nodeId, layout)
      }
    })
    return unsubscribe
  }, [dockStoreApi, canvasStoreApi, nodeId])

  // ------------------------------------------------------------------
  // Cleanup: drop from module map when this node unmounts
  // ------------------------------------------------------------------
  useEffect(() => {
    return () => {
      unregisterNodeDockStore(canvasPanelId, nodeId)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeKey])

  // ------------------------------------------------------------------
  // Sweep orphan panel IDs from this mini-dock's layout — IDs that don't
  // exist in ws.panels (e.g. session-restore mismatch, panel cleanup that
  // missed canvas-node layouts). These render as a generic "Panel" tab
  // with the editor icon because the panel record can't be resolved.
  // Watch the workspace's panels record reactively so a panel that's
  // added later (e.g. async restore) doesn't get pruned by an early run.
  // ------------------------------------------------------------------
  const workspacePanels = useAppStore(
    (s) => s.workspaces.find((w) => w.id === useAppStore.getState().selectedWorkspaceId)?.panels,
  )
  useEffect(() => {
    if (!workspacePanels) return
    const layout = dockStoreApi.getState().zones.center.layout
    if (!layout) return
    const collectOrphans = (n: DockLayoutNode): string[] => {
      if (n.type === 'tabs') return n.panelIds.filter((id) => !workspacePanels[id])
      const out: string[] = []
      for (const c of n.children) out.push(...collectOrphans(c))
      return out
    }
    const orphans = collectOrphans(layout)
    if (orphans.length === 0) return
    for (const id of orphans) {
      try { dockStoreApi.getState().undockPanel(id) } catch { /* ignore */ }
    }
  }, [workspacePanels, dockStoreApi])

  // Read the live zoom lazily so this callback identity stays STABLE across
  // zoom frames — re-rendering it on every frame would re-render CanvasNode.
  // Only TerminalPanel actually consumes zoom, and it reads it reactively from
  // the canvas store context itself, so the value passed here is incidental.
  const renderPanel = useCallback(
    (panelId: string) =>
      renderPanelContent?.(panelId, nodeId, canvasStoreApi.getState().zoomLevel) ?? null,
    [renderPanelContent, nodeId, canvasStoreApi],
  )

  if (!node) return null

  // Derive a fallback title from the seed panelId for CanvasNode's header
  const firstPanel = currentWorkspace?.panels[node.panelId]

  return (
    <CanvasNode
      nodeId={node.id}
      isFocused={isFocused}
      dockStoreApi={dockStoreApi}
      renderPanel={renderPanel}
      title={firstPanel?.title}
    />
  )
})

// ---------------------------------------------------------------------------
// CanvasPanel
// ---------------------------------------------------------------------------

export default function CanvasPanel({ panelId, workspaceId, nodeId, renderPanelContent }: CanvasPanelProps) {
  useRenderCount('CanvasPanel')
  // Each canvas panel gets a stable, unique store keyed by panelId. The first
  // canvas to register aliases the legacy singleton store for backward compat.
  const store = useMemo(() => getOrCreateCanvasStoreForPanel(panelId), [panelId])

  // Register this canvas's operations so panel creation routes to the correct canvas
  useEffect(() => {
    const ops = createCanvasOps(store)
    registerCanvasOps(panelId, ops)
    setActivePanel(panelId)
    return () => {
      unregisterCanvasOps(panelId)
    }
  }, [panelId, store])

  const handlePointerDown = useCallback(() => {
    // A canvas IS the active panel (it's a center-zone dock tab). Runs on the
    // bubble phase, AFTER the containing dock stack's capture handler set the
    // stack's active tab — for the canvas's own stack that's this same canvas
    // panel, so they agree; clicking a sibling docked pane keeps that pane.
    // Canvas-type active → placement derives to the default canvas placement.
    setActivePanel(panelId)
  }, [panelId])

  const zoomLevel = useStore(store, (s) => s.zoomLevel)
  // `nodeIds` is the full ordered list (used where we need to know about every
  // node regardless of visibility — e.g. the "canvas empty" welcome page).
  // `visibleNodeIds` is viewport-culled: we only mount CanvasNodeWrapper for
  // nodes whose bbox overlaps the visible canvas rect (plus a 1-screen margin),
  // so off-screen terminals/editors don't hold live xterm/Monaco instances.
  const nodeIds = useNodeIds(store)
  const visibleNodeIds = useVisibleNodeIds(store)
  // Welcome page only shows on a brand-new workspace (no rootPath chosen yet).
  // After a folder is picked, deleting all panels leaves a blank canvas.
  const workspaceRootPath = useAppStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? '',
  )

  // Pin interactive creates to THIS canvas so a node made from this panel's
  // toolbar / right-click menu lands here, not on the workspace's primary canvas.
  const here = useCallback(
    (): PanelPlacement => ({ target: 'canvas', canvasPanelId: panelId }),
    [panelId],
  )

  const onCreateAtPoint = useCallback(
    (type: PanelType, canvasPoint: Point) => {
      getPanelDef(type).create({ workspaceId, canvasPoint, placement: here() })
    },
    [workspaceId, here],
  )

  const onNewTerminal = useCallback(async () => {
    const wsId = await ensureWorkspaceFolder(workspaceId)
    if (wsId) useAppStore.getState().createTerminal(wsId, undefined, undefined, here())
  }, [workspaceId, here])

  const onNewBrowser = useCallback(async () => {
    const wsId = await ensureWorkspaceFolder(workspaceId)
    if (wsId) useAppStore.getState().createBrowser(wsId, undefined, undefined, here())
  }, [workspaceId, here])

  const onNewEditor = useCallback(async () => {
    const wsId = await ensureWorkspaceFolder(workspaceId)
    if (wsId) useAppStore.getState().createEditor(wsId, undefined, undefined, here())
  }, [workspaceId, here])

  const onNewAgent = useCallback(async () => {
    const wsId = await ensureWorkspaceFolder(workspaceId)
    if (wsId) useAppStore.getState().createAgent(wsId, undefined, here())
  }, [workspaceId, here])

  const onZoomIn = useCallback(() => {
    store.getState().animateZoomTo(zoomLevel + 0.1)
  }, [zoomLevel, store])

  const onZoomOut = useCallback(() => {
    store.getState().animateZoomTo(zoomLevel - 0.1)
  }, [zoomLevel, store])

  const onNewCanvas = useCallback(async () => {
    const wsId = await ensureWorkspaceFolder(workspaceId)
    if (wsId) useAppStore.getState().createCanvas(wsId)
  }, [workspaceId])

  return (
    <CanvasStoreProvider store={store}>
      {/* `isolate` keeps the toolbar/minimap's z-50 contained within this panel
          so it can never paint over the z-20 sidebar overlays. Without it the
          z-50 escapes to the root stacking context and renders on top of the
          sidebars — visible when the toolbar overflows its inset box on small
          or split-view screens. Behind-the-sidebar is the intended layering. */}
      <div className="relative w-full h-full isolate" onPointerDown={handlePointerDown}>
        {/* Welcome page only on a fresh, uninitialized workspace (no panels
            yet AND no rootPath). Once a folder is picked, the canvas stays
            blank when emptied — the start page does not return. */}
        {nodeIds.length === 0 && !workspaceRootPath && (
          <WelcomePage workspaceId={workspaceId} />
        )}

        {/* Empty canvas with a folder open (e.g. a freshly-added 2nd canvas):
            offer one-click loading of a saved layout into this canvas. Self-
            hides when there are no saved layouts. */}
        {nodeIds.length === 0 && workspaceRootPath && (
          <EmptyCanvasOverlay workspaceId={workspaceId} panelId={panelId} canvasApi={store} />
        )}

        <Canvas onCreateAtPoint={onCreateAtPoint} panelId={panelId}>
          {visibleNodeIds.map((nId) => (
            <CanvasNodeWrapper
              key={nId}
              nodeId={nId}
              canvasPanelId={panelId}
              renderPanelContent={renderPanelContent}
            />
          ))}
        </Canvas>

        {(nodeIds.length > 0 || workspaceRootPath) && (
          <CanvasToolbar
            canvasPanelId={panelId}
            zoom={zoomLevel}
            onNewTerminal={onNewTerminal}
            onNewBrowser={onNewBrowser}
            onNewEditor={onNewEditor}
            onNewAgent={onNewAgent}
            onNewCanvas={onNewCanvas}
            onZoomIn={onZoomIn}
            onZoomOut={onZoomOut}
          />
        )}
      </div>
    </CanvasStoreProvider>
  )
}
