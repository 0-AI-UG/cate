// =============================================================================
// CanvasPanel — a full canvas workspace that lives as a panel in any dock zone.
// Each instance gets its own CanvasStore for independent viewport/zoom/nodes.
// The first canvas created uses the default singleton store for compatibility.
// =============================================================================

import React, { useMemo, useCallback, useEffect } from 'react'
import { getOrCreateCanvasStoreForPanel, useNodeIds } from '../stores/canvasStore'
import { CanvasStoreProvider, useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'
import Canvas from '../canvas/Canvas'
import CanvasNode from '../canvas/CanvasNode'
import CanvasToolbar from '../canvas/CanvasToolbar'
import CanvasDropZone from '../docking/CanvasDropZone'
import Minimap from '../canvas/Minimap'
import { ShortcutHintOverlay } from '../ui/ShortcutHintOverlay'
import WelcomePage from '../ui/WelcomePage'
import type { PanelType, Point, DockLayoutNode, PanelLocation, WindowDockState } from '../../shared/types'
import { useAppStore, useSelectedWorkspace, registerCanvasOps, unregisterCanvasOps, setActiveCanvasPanelId } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand'
import { ensureWorkspaceFolder } from '../hooks/useShortcuts'
import { createCanvasOps } from '../lib/canvasBridge'
import { createDockStore, type DockStore } from '../stores/dockStore'

// ---------------------------------------------------------------------------
// Module-level map: `${canvasPanelId}:${nodeId}` → per-node DockStore
// ---------------------------------------------------------------------------
const nodeStoreMap = new Map<string, StoreApi<DockStore>>()

/** Find the per-node DockStore that owns a canvas node (by canvas-node id).
 *  Iterates the map because drag handlers don't know the owning canvasPanelId
 *  at the time of lookup — there's at most a handful of canvases, so the scan
 *  is cheap. */
export function findNodeDockStore(nodeId: string): StoreApi<DockStore> | null {
  for (const [key, store] of nodeStoreMap.entries()) {
    if (key.endsWith(`:${nodeId}`)) return store
  }
  return null
}

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

const CanvasNodeWrapper = React.memo(({ nodeId, canvasPanelId, zoomLevel, renderPanelContent }: {
  nodeId: string
  canvasPanelId: string
  zoomLevel: number
  renderPanelContent?: (panelId: string, nodeId: string, zoomLevel: number) => React.ReactNode
}) => {
  const node = useCanvasStoreContext((s) => s.nodes[nodeId])
  const isFocused = useCanvasStoreContext((s) => s.focusedNodeId === nodeId)
  const currentWorkspace = useSelectedWorkspace()
  const canvasStoreApi = useCanvasStoreApi()

  // ------------------------------------------------------------------
  // Create (or reuse) the per-node DockStore, keyed by canvasPanelId:nodeId
  // ------------------------------------------------------------------
  const storeKey = `${canvasPanelId}:${nodeId}`
  const dockStoreApi = useMemo<StoreApi<DockStore>>(() => {
    const existing = nodeStoreMap.get(storeKey)
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
    nodeStoreMap.set(storeKey, store)
    return store
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeKey]) // intentionally omit node.dockLayout — seed only on first creation

  // ------------------------------------------------------------------
  // Persist center layout back to canvasStore; auto-remove on null
  // ------------------------------------------------------------------
  useEffect(() => {
    const unsubscribe = dockStoreApi.subscribe((state, prev) => {
      const layout = state.zones.center.layout
      const prevLayout = prev.zones.center.layout
      if (layout === prevLayout) return

      if (layout === null) {
        // Node is empty — remove it from the canvas
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
      nodeStoreMap.delete(storeKey)
    }
  }, [storeKey])

  if (!node) return null

  // Derive a fallback title from the seed panelId for CanvasNode's header
  const firstPanel = currentWorkspace?.panels[node.panelId]

  return (
    <CanvasNode
      nodeId={node.id}
      isFocused={isFocused}
      zoomLevel={zoomLevel}
      dockStoreApi={dockStoreApi}
      renderPanel={(panelId) => renderPanelContent?.(panelId, node.id, zoomLevel) ?? null}
      title={firstPanel?.title}
    />
  )
})

// ---------------------------------------------------------------------------
// CanvasPanel
// ---------------------------------------------------------------------------

export default function CanvasPanel({ panelId, workspaceId, nodeId, renderPanelContent }: CanvasPanelProps) {
  // Each canvas panel gets a stable, unique store keyed by panelId. The first
  // canvas to register aliases the legacy singleton store for backward compat.
  const store = useMemo(() => getOrCreateCanvasStoreForPanel(panelId), [panelId])

  // Register this canvas's operations so panel creation routes to the correct canvas
  useEffect(() => {
    const ops = createCanvasOps(store)
    registerCanvasOps(panelId, ops)
    setActiveCanvasPanelId(panelId)
    return () => {
      unregisterCanvasOps(panelId)
    }
  }, [panelId, store])

  const handlePointerDown = useCallback(() => {
    setActiveCanvasPanelId(panelId)
  }, [panelId])

  const zoomLevel = useStore(store, (s) => s.zoomLevel)
  const nodeIds = useNodeIds(store)
  const showMinimap = useSettingsStore((s) => s.showMinimap)

  const onCreateAtPoint = useCallback(
    (type: PanelType, canvasPoint: Point) => {
      if (type === 'canvas') {
        // Canvas panels don't go on canvases — create via appStore which routes to center zone
        useAppStore.getState().createCanvas(workspaceId)
        return
      }
      const appStore = useAppStore.getState()
      switch (type) {
        case 'terminal':
          appStore.createTerminal(workspaceId, undefined, canvasPoint)
          break
        case 'browser':
          appStore.createBrowser(workspaceId, undefined, canvasPoint)
          break
        case 'editor':
          appStore.createEditor(workspaceId, undefined, canvasPoint)
          break
        case 'git':
          appStore.createGit(workspaceId, canvasPoint)
          break
        case 'fileExplorer':
          appStore.createFileExplorer(workspaceId, canvasPoint)
          break
        case 'projectList':
          appStore.createProjectList(workspaceId, canvasPoint)
          break
      }
    },
    [workspaceId],
  )

  const onNewTerminal = useCallback(async () => {
    const wsId = await ensureWorkspaceFolder(workspaceId)
    if (wsId) useAppStore.getState().createTerminal(wsId)
  }, [workspaceId])

  const onNewBrowser = useCallback(async () => {
    const wsId = await ensureWorkspaceFolder(workspaceId)
    if (wsId) useAppStore.getState().createBrowser(wsId)
  }, [workspaceId])

  const onNewEditor = useCallback(async () => {
    const wsId = await ensureWorkspaceFolder(workspaceId)
    if (wsId) useAppStore.getState().createEditor(wsId)
  }, [workspaceId])

  const onZoomIn = useCallback(() => {
    store.getState().animateZoomTo(zoomLevel + 0.1)
  }, [zoomLevel, store])

  const onZoomOut = useCallback(() => {
    store.getState().animateZoomTo(zoomLevel - 0.1)
  }, [zoomLevel, store])

  const onZoomToFit = useCallback(() => {
    store.getState().zoomToFit()
  }, [store])

  // Compute the current canvas-space center of the viewport so newly created
  // items appear where the user is currently looking.
  const getViewCenter = useCallback((): Point => {
    const s = store.getState()
    const zoom = s.zoomLevel
    const offset = s.viewportOffset
    // Try to read the canvas container size from the DOM
    const el = document.querySelector('[data-canvas-container]') as HTMLElement | null
    const w = el?.clientWidth ?? 800
    const h = el?.clientHeight ?? 600
    return {
      x: (w / 2) / zoom - offset.x / zoom,
      y: (h / 2) / zoom - offset.y / zoom,
    }
  }, [store])

  const onNewCanvas = useCallback(async () => {
    const wsId = await ensureWorkspaceFolder(workspaceId)
    if (wsId) useAppStore.getState().createCanvas(wsId)
  }, [workspaceId])

  const onNewRegion = useCallback(() => {
    store.getState().addRegion('Region', getViewCenter(), { width: 400, height: 300 })
  }, [store, getViewCenter])

  const onNewStickyNote = useCallback(() => {
    store.getState().addAnnotation('stickyNote', getViewCenter())
  }, [store, getViewCenter])

  const onNewTextLabel = useCallback(() => {
    store.getState().addAnnotation('textLabel', getViewCenter())
  }, [store, getViewCenter])

  return (
    <CanvasStoreProvider store={store}>
      <div className="relative w-full h-full" onPointerDown={handlePointerDown}>
        {/* Welcome page when canvas is empty */}
        {nodeIds.length === 0 && (
          <WelcomePage workspaceId={workspaceId} />
        )}

        <Canvas onCreateAtPoint={onCreateAtPoint}>
          {nodeIds.map((nId) => (
            <CanvasNodeWrapper
              key={nId}
              nodeId={nId}
              canvasPanelId={panelId}
              zoomLevel={zoomLevel}
              renderPanelContent={renderPanelContent}
            />
          ))}
        </Canvas>

        {showMinimap && <Minimap />}

        <CanvasDropZone canvasStoreApi={store} />

        <CanvasToolbar
          zoom={zoomLevel}
          onNewTerminal={onNewTerminal}
          onNewBrowser={onNewBrowser}
          onNewEditor={onNewEditor}
          onNewCanvas={onNewCanvas}
          onNewRegion={onNewRegion}
          onNewStickyNote={onNewStickyNote}
          onNewTextLabel={onNewTextLabel}
          onZoomToFit={onZoomToFit}
          onZoomIn={onZoomIn}
          onZoomOut={onZoomOut}
        />

        <ShortcutHintOverlay />
      </div>
    </CanvasStoreProvider>
  )
}
