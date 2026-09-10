// =============================================================================
// CanvasPanel — a full canvas workspace that lives as a panel in any dock zone.
// Each instance gets its own CanvasStore for independent viewport/zoom/nodes.
// Every canvas panel resolves its store from the renderer session by panel id.
// =============================================================================

import React, { useMemo, useCallback, useEffect, useState } from 'react'
import { useRenderCount } from '../lib/perf/perfClient'
import { getOrCreateCanvasStoreForPanel, useVisibleNodeIds } from '../stores/canvasStore'
import { CanvasStoreProvider, useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { focusedNodeId } from '../stores/canvas/selectionModel'
import Canvas from '../canvas/Canvas'
import CanvasNode from '../canvas/CanvasNode'
import CanvasToolbar from '../canvas/CanvasToolbar'
import { NodeErrorBoundary } from '../ui/NodeErrorBoundary'
import type { PanelType, Point, DockLayoutNode, WindowDockState } from '../../shared/types'
import { useAppStore, type PanelPlacement } from '../stores/appStore'
import type { StoreApi } from 'zustand'
import { useKeepMountedPanelIds } from './keepMountedPanels'
import { setActivePanel } from '../lib/activePanel'
import { createDockStore, type DockStore } from '../stores/dockStore'
import { useOptionalDockStoreApi } from '../stores/DockStoreContext'
import {
  registerNodeDockStore,
  unregisterNodeDockStore,
  getNodeDockStore,
  findNodeDockStore,
  findNodeIdForDockStore,
} from './nodeDockRegistry'
import { createInteractivePanel } from '../lib/panels/createInteractivePanel'
import { inheritedWorktreeFromSelection } from '../lib/inheritWorktree'

const NODE_MOUNT_BATCH = 6

/** Split a large cold canvas mount across frames. Existing mounted ids are
 * removed immediately by slice(), while newly-visible ids join in small
 * batches. Persistent browser/agent guests live outside this subtree. */
function useStagedVisibleNodeIds(visibleNodeIds: string[]): string[] {
  const [mountLimit, setMountLimit] = useState(NODE_MOUNT_BATCH)
  useEffect(() => {
    if (mountLimit >= visibleNodeIds.length) return
    const frame = requestAnimationFrame(() => {
      setMountLimit((current) => Math.min(current + NODE_MOUNT_BATCH, visibleNodeIds.length))
    })
    return () => cancelAnimationFrame(frame)
  }, [mountLimit, visibleNodeIds.length])
  return visibleNodeIds.slice(0, mountLimit)
}
import { useShallow } from 'zustand/react/shallow'
import { activeDockPanelId } from '../../shared/collectPanelIds'
import { PanelConnectionLayer } from '../canvas/PanelConnectionLayer'

// Re-export the lookup helpers so existing callers (drag dispatcher, drop
// resolver) keep working through the same import path. New code should import
// directly from './nodeDockRegistry' to skip the heavy CanvasPanel module.
export { findNodeDockStore, findNodeIdForDockStore }

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

const CanvasNodeWrapper = React.memo(({ nodeId, canvasPanelId, workspaceId, renderPanelContent }: {
  nodeId: string
  canvasPanelId: string
  workspaceId: string
  renderPanelContent?: (panelId: string, nodeId: string, zoomLevel: number) => React.ReactNode
}) => {
  useRenderCount('CanvasNodeWrapper')
  const node = useCanvasStoreContext((s) => s.nodes[nodeId])
  const isFocused = useCanvasStoreContext((s) => focusedNodeId(s) === nodeId)
  const firstPanelId = node ? activeDockPanelId(node.dockLayout) : undefined
  const title = useAppStore((s) => firstPanelId ? s.workspaces.find((w) => w.id === workspaceId)?.panels[firstPanelId]?.title : undefined)
  const canvasStoreApi = useCanvasStoreApi()
  const outerDockStoreApi = useOptionalDockStoreApi()

  // ------------------------------------------------------------------
  // Create (or reuse) the per-node DockStore, keyed by canvasPanelId:nodeId
  // ------------------------------------------------------------------
  const storeKey = `${canvasPanelId}:${nodeId}`
  const dockStoreApi = useMemo<StoreApi<DockStore>>(() => {
    const existing = getNodeDockStore(canvasPanelId, nodeId)
    if (existing) return existing

    const dockLayout = node?.dockLayout ?? null
    const zones: WindowDockState = {
      left:   { position: 'left',   visible: false, size: 260, layout: null },
      right:  { position: 'right',  visible: false, size: 260, layout: null },
      bottom: { position: 'bottom', visible: false, size: 240, layout: null },
      center: { position: 'center', visible: true,  size: 0,   layout: dockLayout },
    }
    const store = createDockStore({ zones })
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
  const orphans = useAppStore(useShallow((s) => {
    const panels = s.workspaces.find((w) => w.id === workspaceId)?.panels
    const missing: string[] = []
    const visit = (layout: DockLayoutNode): void => {
      if (layout.type === 'tabs') {
        for (const id of layout.panelIds) if (panels && !panels[id]) missing.push(id)
      } else for (const child of layout.children) visit(child)
    }
    if (node?.dockLayout) visit(node.dockLayout)
    return missing
  }))
  useEffect(() => {
    for (const id of orphans) {
      try { dockStoreApi.getState().undockPanel(id) } catch { /* ignore */ }
    }
  }, [orphans, dockStoreApi])

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


  return (
    <NodeErrorBoundary nodeId={node.id}>
      <CanvasNode
        nodeId={node.id}
        canvasPanelId={canvasPanelId}
        isFocused={isFocused}
        dockStoreApi={dockStoreApi}
        outerDockStoreApi={outerDockStoreApi ?? undefined}
        renderPanel={renderPanel}
        title={title}
      />
    </NodeErrorBoundary>
  )
})

// ---------------------------------------------------------------------------
// CanvasPanel
// ---------------------------------------------------------------------------

export default function CanvasPanel({ panelId, workspaceId, renderPanelContent }: CanvasPanelProps) {
  useRenderCount('CanvasPanel')
  // Each canvas panel gets a stable, unique store keyed by panelId.
  const store = useMemo(() => getOrCreateCanvasStoreForPanel(panelId), [panelId])

  useEffect(() => {
    setActivePanel(panelId)
  }, [panelId])

  const handlePointerDown = useCallback(() => {
    // A canvas IS the active panel (it's a center-zone dock tab). Runs on the
    // bubble phase, AFTER the containing dock stack's capture handler set the
    // stack's active tab — for the canvas's own stack that's this same canvas
    // panel, so they agree; clicking a sibling docked pane keeps that pane.
    // Canvas-type active → placement derives to the default canvas placement.
    setActivePanel(panelId)
  }, [panelId])

  // `visibleNodeIds` is viewport-culled: we only mount CanvasNodeWrapper for
  // nodes whose bbox overlaps the visible canvas rect (plus a 1-screen margin),
  // so off-screen terminals/editors don't hold live xterm/Monaco instances.
  // `keepMountedPanelIds` lets the cull exempt webview-backed nodes (browsers)
  // so panning them off-screen doesn't unmount the guest and reset its session
  // state. It's a stable, membership-keyed set (see useKeepMountedPanelIds) so
  // unrelated panel churn (titles, dirty flags) never re-runs the cull.
  const keepMountedPanelIds = useKeepMountedPanelIds(workspaceId)
  const visibleNodeIds = useVisibleNodeIds(store, keepMountedPanelIds)
  const mountedNodeIds = useStagedVisibleNodeIds(visibleNodeIds)
  const workspaceRootPath = useAppStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? '',
  )

  // Pin interactive creates to THIS canvas so a node made from this panel's
  // toolbar / right-click menu lands here, not on the workspace's primary canvas.
  const here = useCallback(
    (): PanelPlacement => ({ target: 'canvas', canvasPanelId: panelId }),
    [panelId],
  )

  const createHere = useCallback(async (type: PanelType, canvasPoint?: Point) => {
    const workspace = useAppStore.getState().getWorkspace(workspaceId)
    const checkout = inheritedWorktreeFromSelection(store.getState(), workspace?.panels, workspace?.worktrees)
    createInteractivePanel(type, { workspaceId, canvasPoint, placement: here(), ...checkout })
  }, [workspaceId, here, store])
  const onCreateAtPoint = useCallback((type: PanelType, point: Point) => { void createHere(type, point) }, [createHere])
  const onNewTerminal = useCallback(() => createHere('terminal'), [createHere])
  const onNewBrowser = useCallback(() => createHere('browser'), [createHere])
  const onNewEditor = useCallback(() => createHere('editor'), [createHere])


  return (
    <CanvasStoreProvider store={store}>
      {/* `isolate` keeps the toolbar/minimap's z-50 contained within this panel
          so it can never paint over the z-20 sidebar overlays. Without it the
          z-50 escapes to the root stacking context and renders on top of the
          sidebars — visible when the toolbar overflows its inset box on small
          or split-view screens. Behind-the-sidebar is the intended layering. */}
      <div data-canvas-area className="relative w-full h-full isolate" onPointerDown={handlePointerDown}>
        <Canvas
          onCreateAtPoint={onCreateAtPoint}
          panelId={panelId}
          overlayChildren={(
            <CanvasToolbar
              canvasPanelId={panelId}
              workspaceId={workspaceId}
              rootPath={workspaceRootPath}
              onNewTerminal={onNewTerminal}
              onNewBrowser={onNewBrowser}
              onNewEditor={onNewEditor}
            />
          )}
        >
          <PanelConnectionLayer workspaceId={workspaceId} />
          {mountedNodeIds.map((nId) => (
            <CanvasNodeWrapper
              key={nId}
              nodeId={nId}
              canvasPanelId={panelId}
              workspaceId={workspaceId}
              renderPanelContent={renderPanelContent}
            />
          ))}
        </Canvas>

      </div>
    </CanvasStoreProvider>
  )
}
