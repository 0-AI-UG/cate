// =============================================================================
// WorktreeTerritoryLayer — React/canvas glue for the worktree terrace territory.
//
// Thin on purpose: it owns the <canvas>, keeps it sized + DPR-correct, drives a
// dirty-gated rAF, and assembles the renderer's inputs (membership + live node
// geometry + the live drag-ghost position). All drawing lives in the pure
// `drawTerritory`. Rendered in SCREEN space as a sibling of CanvasGrid (outside
// the world transform) so zoom can't blow up tile memory.
// =============================================================================

import React, { useEffect, useRef } from 'react'
import { useCanvasStoreApi } from '../../stores/CanvasStoreContext'
import { useDragStore } from '../../drag'
import { useWorktreeMembership, type WorktreeGroup } from './useWorktreeMembership'
import { drawTerritory, type TerritoryGroup } from './territoryRenderer'

interface Props {
  containerWidth: number
  containerHeight: number
}

/** Live canvas-space origin of the node being whole-node dragged (its store
 *  origin is frozen until drop), so its territory follows the ghost in real
 *  time. Null when no canvas-node drag is in flight. */
function dragGhostOrigin(
  canvas: HTMLCanvasElement,
  zoom: number,
  offX: number,
  offY: number,
): { nodeId: string; x: number; y: number } | null {
  const drag = useDragStore.getState()
  if (drag.source?.origin.kind !== 'canvas-node') return null
  if (!drag.cursor?.insideWindow || !drag.grab) return null
  const r = canvas.getBoundingClientRect()
  const wx = (drag.cursor.client.x - r.left - offX) / zoom
  const wy = (drag.cursor.client.y - r.top - offY) / zoom
  return { nodeId: drag.source.origin.nodeId, x: wx - drag.grab.x, y: wy - drag.grab.y }
}

function buildGroups(
  groups: WorktreeGroup[],
  nodes: ReturnType<ReturnType<typeof useCanvasStoreApi>['getState']>['nodes'],
  ghost: { nodeId: string; x: number; y: number } | null,
): TerritoryGroup[] {
  const out: TerritoryGroup[] = []
  for (const g of groups) {
    const rects = []
    for (const nodeId of g.nodeIds) {
      const n = nodes[nodeId]
      if (!n) continue
      const o = ghost && ghost.nodeId === nodeId ? ghost : n.origin
      rects.push({ x: o.x, y: o.y, w: n.size.width, h: n.size.height })
    }
    if (rects.length > 0) out.push({ color: g.color, rects })
  }
  return out
}

const WorktreeTerritoryLayer: React.FC<Props> = ({ containerWidth, containerHeight }) => {
  const canvasApi = useCanvasStoreApi()
  const { groups } = useWorktreeMembership()

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const groupsRef = useRef<WorktreeGroup[]>(groups)
  groupsRef.current = groups

  const dirtyRef = useRef(true)
  const rafRef = useRef(0)
  const ensureRef = useRef<() => void>(() => {})

  // Size the backing store to the container (DPR-aware).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.round(containerWidth * dpr))
    canvas.height = Math.max(1, Math.round(containerHeight * dpr))
    canvas.style.width = containerWidth + 'px'
    canvas.style.height = containerHeight + 'px'
    canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0)
    dirtyRef.current = true
    ensureRef.current()
  }, [containerWidth, containerHeight])

  // Renderer + dirty-driven rAF.
  useEffect(() => {
    const paint = () => {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      const cs = canvasApi.getState()
      const ghost = dragGhostOrigin(canvas, cs.zoomLevel, cs.viewportOffset.x, cs.viewportOffset.y)
      const tGroups = buildGroups(groupsRef.current, cs.nodes, ghost)
      drawTerritory(
        ctx,
        {
          width: containerWidth,
          height: containerHeight,
          zoom: cs.zoomLevel,
          offsetX: cs.viewportOffset.x,
          offsetY: cs.viewportOffset.y,
        },
        tGroups,
      )
    }

    const frame = () => {
      rafRef.current = 0
      const dragging = useDragStore.getState().source?.origin.kind === 'canvas-node'
      if (dirtyRef.current || dragging) { paint(); dirtyRef.current = false }
      if (dragging) rafRef.current = requestAnimationFrame(frame) // follow the ghost
    }
    const ensure = () => { if (!rafRef.current) rafRef.current = requestAnimationFrame(frame) }
    ensureRef.current = ensure

    const onChange = () => { dirtyRef.current = true; ensure() }
    const unsubCanvas = canvasApi.subscribe(onChange) // zoom / pan / nodes / worktree map
    const unsubDrag = useDragStore.subscribe(onChange)
    ensure()
    return () => {
      unsubCanvas()
      unsubDrag()
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }, [canvasApi, containerWidth, containerHeight])

  // Membership changes (React state) → repaint.
  useEffect(() => { dirtyRef.current = true; ensureRef.current() }, [groups])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-worktree-territory
      style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 0 }}
    />
  )
}

export default React.memo(WorktreeTerritoryLayer)
