// A canvas as a panel view: the surface, its nodes (viewport-culled and
// staged across frames on a cold mount), relation drawing and the toolbar.

import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { clientStateFor, documentStoreFor } from '@client/document'
import { useClientState, useDocument } from '../../document'
import { isCanvasDock, placementOf, type NodeId } from '@workspace/document/contract'
import { useCanvasUi } from './uiState'
import { CANVAS_REVEAL_INTENT } from '@client/host'
import { useKeepMountedPanelIds } from '../../host/hooks'
import { canvasViewFor } from './registry'
import { focusedNodeId } from './selection'
import { CanvasViewProvider, useCanvasView } from './context'
import { installCanvasTargetPicker } from './targetPicker'
import { useStagedVisibleNodeIds, useVisibleNodeIds } from './visibleNodes'
import Canvas from './Canvas'
import CanvasNode from './CanvasNode'
import CanvasToolbar from './CanvasToolbar'
import { NodeErrorBoundary } from './NodeErrorBoundary'
import { PanelConnectionLayer } from './PanelConnectionLayer'

export interface CanvasViewProps {
  workspaceId: string
  canvasId: string
  /** The canvas panel showing this canvas. */
  canvasPanelId: string
}

interface NodeSlotProps {
  workspaceId: string
  canvasId: string
  canvasPanelId: string
  nodeId: NodeId
}

// Reads its own focus flag so a focus change re-renders two nodes, not all.
const NodeSlot = React.memo(function NodeSlot({ workspaceId, canvasId, canvasPanelId, nodeId }: NodeSlotProps) {
  const exists = useCanvasView((s) => !!s.nodes[nodeId])
  const isFocused = useCanvasView((s) => focusedNodeId(s) === nodeId)
  if (!exists) return null
  return (
    <NodeErrorBoundary nodeId={nodeId}>
      <CanvasNode workspaceId={workspaceId} canvasId={canvasId} canvasPanelId={canvasPanelId} nodeId={nodeId} isFocused={isFocused} />
    </NodeErrorBoundary>
  )
})

function CanvasNodes({ workspaceId, canvasId, canvasPanelId, store }: CanvasViewProps & {
  store: NonNullable<ReturnType<typeof canvasViewFor>>
}) {
  const keepMounted = useKeepMountedPanelIds(workspaceId)
  const visible = useVisibleNodeIds(store, keepMounted)
  const staged = useStagedVisibleNodeIds(visible)
  return (
    <>
      <PanelConnectionLayer workspaceId={workspaceId} />
      {staged.map((nodeId) => (
        <NodeSlot key={nodeId} workspaceId={workspaceId} canvasId={canvasId} canvasPanelId={canvasPanelId} nodeId={nodeId} />
      ))}
    </>
  )
}

export function CanvasView({ workspaceId, canvasId, canvasPanelId }: CanvasViewProps): React.ReactElement | null {
  const exists = useDocument(workspaceId, (d) => !!d.canvases[canvasId])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const store = useMemo(() => (exists ? canvasViewFor(workspaceId, canvasId) : null), [workspaceId, canvasId, exists])

  // The canvas is the focused panel until a press inside a node (which runs
  // later, on mousedown) points focus at that node's panel.
  useEffect(installCanvasTargetPicker, [])

  // A reveal (palette, `cate`, notifications) leaves an intent on this canvas
  // panel: centre and focus the node it names.
  const intents = useClientState(workspaceId, (s) => s.intents)
  useEffect(() => {
    if (!store || !intents.some((i) => i.panelId === canvasPanelId && i.kind === CANVAS_REVEAL_INTENT)) return
    const taken = clientStateFor(workspaceId)?.takeIntents(canvasPanelId) ?? []
    const reveal = taken.filter((i) => i.kind === CANVAS_REVEAL_INTENT).at(-1)
    const nodeId = (reveal?.data as { nodeId?: string } | undefined)?.nodeId
    if (nodeId) store.getState().focusAndCenter(nodeId)
  }, [intents, store, workspaceId, canvasPanelId])

  // A sidebar thread under the pointer: glide to its node, and back when the
  // pointer leaves (unless a click committed the view).
  const peeked = useCanvasUi((s) => s.peekedPanelId)
  const restore = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!store) return
    const doc = documentStoreFor(workspaceId)?.getSnapshot()
    const nodeId = peeked && doc ? (() => {
      const placement = placementOf(doc, peeked)
      return placement && isCanvasDock(placement.dock) && placement.dock.canvasId === canvasId ? placement.dock.nodeId : null
    })() : null
    if (nodeId) {
      const previous = store.getState().peekNode(nodeId)
      if (previous && !restore.current) restore.current = previous
      return
    }
    const origin = restore.current
    restore.current = null
    if (origin && !useCanvasUi.getState().peekKeepView) store.getState().restoreViewport(origin)
  }, [peeked, store, workspaceId, canvasId])

  // The canvas can unmount while peeked (its tab is switched back): the
  // viewport must not keep the peeked position.
  useEffect(() => () => {
    const origin = restore.current
    restore.current = null
    if (store && origin && !useCanvasUi.getState().peekKeepView) store.getState().setViewportOffset(origin)
  }, [store])

  const handlePointerDown = useCallback(() => {
    clientStateFor(workspaceId)?.focus(canvasPanelId)
  }, [workspaceId, canvasPanelId])

  if (!store) return null
  return (
    <CanvasViewProvider store={store}>
      {/* `isolate` keeps the toolbar's z-50 inside this panel, behind the
          sidebars, even when it overflows its inset box. */}
      <div data-canvas-area className="relative w-full h-full isolate" onPointerDown={handlePointerDown}>
        <Canvas
          workspaceId={workspaceId}
          canvasId={canvasId}
          canvasPanelId={canvasPanelId}
          overlayChildren={<CanvasToolbar workspaceId={workspaceId} canvasId={canvasId} canvasPanelId={canvasPanelId} />}
        >
          <CanvasNodes workspaceId={workspaceId} canvasId={canvasId} canvasPanelId={canvasPanelId} store={store} />
        </Canvas>
      </div>
    </CanvasViewProvider>
  )
}
