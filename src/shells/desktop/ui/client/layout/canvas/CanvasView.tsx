// A canvas as a panel view: the surface, its nodes (viewport-culled and
// staged across frames on a cold mount), relation drawing and the toolbar.
// A node this client maximized fills the canvas's area instead.

import React, { useCallback, useEffect, useMemo } from 'react'
import { clientStateFor } from '@client/document'
import { useClientState, useDocument } from '../../document'
import type { NodeId } from '@workspace/document/contract'
import { CANVAS_REVEAL_INTENT } from '@client/host'
import { useKeepMountedPanelIds } from '../../host/hooks'
import { DockView } from '../dock/DockView'
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

function CanvasNodes({ workspaceId, canvasId, canvasPanelId, store, maximized }: CanvasViewProps & {
  store: NonNullable<ReturnType<typeof canvasViewFor>>
  /** Drawn over the canvas instead (maximize). */
  maximized: NodeId | null
}) {
  const keepMounted = useKeepMountedPanelIds(workspaceId)
  const visible = useVisibleNodeIds(store, keepMounted)
  const staged = useStagedVisibleNodeIds(visible)
  const mounted = maximized ? staged.filter((nodeId) => nodeId !== maximized) : staged
  return (
    <>
      <PanelConnectionLayer workspaceId={workspaceId} />
      {mounted.map((nodeId) => (
        <NodeSlot key={nodeId} workspaceId={workspaceId} canvasId={canvasId} canvasPanelId={canvasPanelId} nodeId={nodeId} />
      ))}
    </>
  )
}

export function CanvasView({ workspaceId, canvasId, canvasPanelId }: CanvasViewProps): React.ReactElement | null {
  const exists = useDocument(workspaceId, (d) => !!d.canvases[canvasId])
  const wanted = useClientState(workspaceId, (s) => s.maximizedNodes[canvasId] ?? null)
  const maximized = useDocument(workspaceId, (d) => (wanted && d.canvases[canvasId]?.nodes[wanted] ? wanted : null))
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
          <CanvasNodes workspaceId={workspaceId} canvasId={canvasId} canvasPanelId={canvasPanelId} store={store} maximized={maximized} />
        </Canvas>
        {maximized && (
          <div data-maximized-node={maximized} className="absolute inset-0 z-[60] flex flex-col bg-canvas-bg">
            <DockView workspaceId={workspaceId} dock={{ canvasId, nodeId: maximized }} />
          </div>
        )}
      </div>
    </CanvasViewProvider>
  )
}
