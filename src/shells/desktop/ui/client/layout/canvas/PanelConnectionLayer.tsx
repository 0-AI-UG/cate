import { useMemo, useState } from 'react'
import type { Point } from '@workspace/canvas/contract'
import { dockStacks, type DockNode, type PanelId, type PanelRecord, type PanelRelation } from '@workspace/document/contract'
import { panelConnectionCurve, panelConnectionCurvePath, panelConnectionMidpoint, type PanelConnectionCurve } from '@workspace/canvas/contract'
import { relationFlows, relationPanels, relationReach } from '@workspace/relations/contract'
import {
  PanelRelationSelector,
  RelationCanvasProvider,
  relationRoleOf,
  useRelationUi,
  useRelationsEnabled,
} from '../../../workspace/relations'
import { useAgentPanels } from '../../../services/agents'
import type { AgentPanelStates } from '@services/agents/contract'
import { useClientState, useDocument } from '../../document'
import type { CanvasDragState } from './ports'
import type { ViewNode } from './store'
import { useCanvasRelationOverlayTarget, useCanvasView, useCanvasViewStore } from './context'
import { useCanvasDrag } from './dragState'

interface RenderedConnection {
  key: string
  source: ViewNode
  target: ViewNode
  flowIndex?: number
  /** Its flow's context will go with the next turn. */
  pending: boolean
  relation: PanelRelation
}

const EMPTY_RELATIONS: PanelRelation[] = []
const FLOW_HUE_STEP = 137.508

function flowColor(index: number): string {
  return `hsl(${Math.round((211 + index * FLOW_HUE_STEP) % 360)} 72% 58%)`
}

/** Only the runtime decides whether a source will inject context next turn. */
function pendingRelationIds(
  relations: readonly PanelRelation[],
  panels: Readonly<Record<string, PanelRecord>>,
  agents: AgentPanelStates,
): Set<string> {
  const pending = new Set<string>()
  const graph = relationPanels(Object.values(panels), relationRoleOf)
  for (const source of Object.values(agents)) {
    if (!source.contextPending) continue
    for (const step of relationReach(source.panelId, graph, relations) ?? []) pending.add(step.relation.id)
  }
  return pending
}

/** The panel each stack shows: its active tab, else its first. */
function visiblePanelIds(dock: DockNode, activeTabs: Readonly<Record<string, PanelId>>): PanelId[] {
  return dockStacks(dock).flatMap((stack) => {
    const active = activeTabs[stack.id]
    const shown = active && stack.panels.includes(active) ? active : stack.panels[0]
    return shown ? [shown] : []
  })
}

export function PanelConnectionLayer({ workspaceId }: { workspaceId: string }) {
  const canvasStore = useCanvasViewStore()
  const overlayTarget = useCanvasRelationOverlayTarget()
  const nodes = useCanvasView((state) => state.nodes)
  const zoom = useCanvasView((state) => state.zoomLevel) || 1
  const selection = useCanvasView((state) => state.selection)
  const activeTabs = useClientState(workspaceId, (state) => state.activeTabs)
  const panels = useDocument(workspaceId, (doc) => doc.panels)
  const relationMap = useDocument(workspaceId, (doc) => doc.relations)
  const relations = useMemo(() => Object.values(relationMap), [relationMap])
  const agents = useAgentPanels(workspaceId, (states) => states)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const waypointPreview = useRelationUi((state) => state.waypointPreview)
  const panelRelationsEnabled = useRelationsEnabled(workspaceId)
  const dragSourceNodeId = useCanvasDrag(selectSourceNode)
  const dragGhost = useCanvasDrag(selectGhostOrigin)

  const connections = useMemo(() => {
    const enabledRelations = panelRelationsEnabled ? relations : EMPTY_RELATIONS
    const flowIndexes = relationFlows(enabledRelations, panels, relationRoleOf)
    const pending = pendingRelationIds(enabledRelations, panels, agents)
    const panelToNode = new Map<string, ViewNode>()
    for (const node of Object.values(nodes)) {
      if (node.animationState === 'exiting') continue
      let renderedNode = node
      // A dragged node's connections follow its ghost on this canvas, and
      // hide while it is anywhere else.
      if (dragSourceNodeId === node.id) {
        if (!dragGhost) continue
        const origin = { x: dragGhost.x, y: dragGhost.y }
        renderedNode = { ...node, origin, rect: { origin, size: node.size } }
      }
      for (const panelId of visiblePanelIds(node.dock, activeTabs)) panelToNode.set(panelId, renderedNode)
    }

    const byNodePair = new Map<string, RenderedConnection>()
    for (const relation of enabledRelations) {
      const preview = waypointPreview[relation.id]
      const source = panelToNode.get(relation.fromPanelId)
      const target = panelToNode.get(relation.toPanelId)
      if (!source || !target || source.id === target.id) continue
      const key = `${source.id}\0${target.id}`
      byNodePair.set(key, {
        key, source, target,
        flowIndex: flowIndexes.get(relation.id),
        pending: pending.has(relation.id),
        relation: preview ? { ...relation, waypoint: preview } : relation,
      })
    }
    return [...byNodePair.values()]
  }, [activeTabs, agents, dragGhost, dragSourceNodeId, nodes, panels, panelRelationsEnabled, relations, waypointPreview])

  if (connections.length === 0) return null

  const isEmphasized = (connection: RenderedConnection) =>
    hoveredId === connection.relation.id || selection.includes(connection.source.id) || selection.includes(connection.target.id)
  // The panels on the other end of a lit connection get a thin outline in its
  // colour: what the selected (or hovered) panel is linked to, at a glance.
  const outlined = new Map<string, { node: ViewNode; color: string }>()
  for (const connection of connections) {
    if (!isEmphasized(connection)) continue
    const color = connection.flowIndex === undefined ? 'var(--focus-blue)' : flowColor(connection.flowIndex)
    for (const node of [connection.source, connection.target]) {
      if (!selection.includes(node.id)) outlined.set(node.id, { node, color })
    }
  }

  const selectors = connections.map((connection) => {
    const sourcePanel = panels[connection.relation.fromPanelId]
    const targetPanel = panels[connection.relation.toPanelId]
    if (!sourcePanel || !targetPanel) return null
    const position = panelConnectionMidpoint(
      { origin: connection.source.origin, size: connection.source.size },
      { origin: connection.target.origin, size: connection.target.size },
      connection.relation.fromSide,
      connection.relation.toSide,
      connection.relation.waypoint,
    )
    if (!position) return null
    return (
      <PanelRelationSelector
        key={`${connection.key}-selector`}
        workspaceId={workspaceId}
        relation={connection.relation}
        sourcePanel={sourcePanel}
        targetPanel={targetPanel}
        position={position}
        muted={!connection.pending}
        visible={selection.includes(connection.source.id) || selection.includes(connection.target.id)}
      />
    )
  })

  return (
    <>
      <svg
        aria-hidden
        data-panel-connection-layer
        width="1"
        height="1"
        style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none', zIndex: 500 }}
      >
        {[...outlined.entries()].map(([nodeId, { node, color }]) => (
          <rect
            key={`outline-${nodeId}`}
            data-panel-connection-outline={nodeId}
            x={node.origin.x - 3}
            y={node.origin.y - 3}
            width={node.size.width + 6}
            height={node.size.height + 6}
            rx={13}
            fill="none"
            stroke={color}
            strokeWidth={1}
            strokeOpacity={0.4}
            vectorEffect="non-scaling-stroke"
            style={{ pointerEvents: 'none' }}
          />
        ))}
        {connections.map((connection) => {
          const fullCurve = panelConnectionCurve(
            { origin: connection.source.origin, size: connection.source.size },
            { origin: connection.target.origin, size: connection.target.size },
            connection.relation.fromSide,
            connection.relation.toSide,
            connection.relation.waypoint,
          )
          if (!fullCurve) return null
          const { curve, arrowBase, arrowAngle } = trimAtArrow(fullCurve, ARROW_LENGTH / zoom)
          const path = panelConnectionCurvePath(curve)
          const flowTint = connection.flowIndex === undefined ? 'var(--focus-blue)' : flowColor(connection.flowIndex)
          const emphasized = isEmphasized(connection)
          const color = emphasized ? flowTint : 'var(--text-muted)'
          const opacity = emphasized ? (connection.pending ? 1 : 0.85) : connection.pending ? 0.75 : 0.6
          return (
            <g key={connection.key} opacity={opacity} style={{ transition: 'opacity 150ms ease' }}>
              <path
                data-panel-connection-hit={connection.relation.id}
                d={path}
                fill="none"
                stroke="transparent"
                strokeWidth={14}
                vectorEffect="non-scaling-stroke"
                style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                onMouseEnter={() => setHoveredId(connection.relation.id)}
                onMouseLeave={() => setHoveredId((id) => (id === connection.relation.id ? null : id))}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  useRelationUi.getState().openRelationEditor(connection.relation.id)
                }}
              />
              <path
                data-panel-connection="relation"
                data-panel-relation-id={connection.relation.id}
                data-panel-flow={connection.flowIndex}
                data-panel-relation-context-pending={connection.pending}
                d={path}
                fill="none"
                stroke={color}
                strokeWidth={emphasized ? 1.75 : 1.25}
                vectorEffect="non-scaling-stroke"
                className={connection.pending ? 'cate-panel-connection cate-panel-connection-pending' : 'cate-panel-connection'}
                style={{ transition: 'stroke-width 150ms ease, stroke 150ms ease', pointerEvents: 'none' }}
              />
              <path
                data-panel-connection-arrow={connection.relation.id}
                d={ARROW_PATH}
                fill={color}
                style={{
                  transform: `translate(${arrowBase.x}px, ${arrowBase.y}px) rotate(${arrowAngle}rad) scale(calc(1 / var(--canvas-zoom, 1))) translate(${ARROW_LENGTH}px, 0)`,
                  transition: 'fill 150ms ease',
                  pointerEvents: 'none',
                }}
              />
            </g>
          )
        })}
      </svg>
      <RelationCanvasProvider canvas={canvasStore} overlayTarget={overlayTarget}>{selectors}</RelationCanvasProvider>
    </>
  )
}

/** A barbed arrowhead 8 long and 6 wide in screen pixels, tip at the origin
 *  and pointing along +x; the caller places, rotates and un-zooms it. */
const ARROW_LENGTH = 12
const ARROW_PATH = `M 0 0 L -${ARROW_LENGTH} -4.5 L -${ARROW_LENGTH} 4.5 Z`

type Segment = PanelConnectionCurve['segments'][number]

const bezier = (a: Point, b: Point, c: Point, d: Point, t: number): Point => {
  const u = 1 - t
  return {
    x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
    y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
  }
}
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

/** Cuts the curve `back` canvas units short of its end, measured along the
 *  panel edge's normal, so the line ends at the middle of the arrow's base
 *  however the curve bends. The arrow points along that normal (strictly
 *  perpendicular to the edge). */
function trimAtArrow(curve: PanelConnectionCurve, back: number): {
  curve: PanelConnectionCurve
  arrowBase: Point
  arrowAngle: number
} {
  const segments = curve.segments
  const last = segments[segments.length - 1]
  const start = segments[segments.length - 2]?.end ?? curve.start
  const arrowAngle = Math.round(Math.atan2(last.end.y - last.c2.y, last.end.x - last.c2.x) / (Math.PI / 2)) * (Math.PI / 2)
  const nx = Math.round(Math.cos(arrowAngle))
  const ny = Math.round(Math.sin(arrowAngle))
  const short = (t: number) => {
    const point = bezier(start, last.c1, last.c2, last.end, t)
    return (last.end.x - point.x) * nx + (last.end.y - point.y) * ny
  }
  // Where the curve is `back` short of the edge; the last segment if it is
  // long enough, else its start.
  let low = 0
  let high = 1
  if (short(0) <= back) high = 0
  else for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2
    if (short(mid) > back) low = mid
    else high = mid
  }
  const t = high
  const p01 = lerp(start, last.c1, t)
  const p12 = lerp(last.c1, last.c2, t)
  const p23 = lerp(last.c2, last.end, t)
  const p012 = lerp(p01, p12, t)
  const p123 = lerp(p12, p23, t)
  const base = lerp(p012, p123, t)
  const trimmed: Segment = { c1: p01, c2: p012, end: base }
  return {
    curve: { ...curve, segments: [...segments.slice(0, -1), trimmed] },
    arrowBase: base,
    arrowAngle,
  }
}

const selectSourceNode = (state: CanvasDragState): string | null => (state.dragging ? state.sourceNodeId : null)

// A stable object per ghost position so the selector result compares equal.
let lastGhost: Point | null = null
const selectGhostOrigin = (state: CanvasDragState): Point | null => {
  const origin = state.dragging ? state.ghostOrigin ?? null : null
  if (!origin) return (lastGhost = null)
  if (lastGhost && lastGhost.x === origin.x && lastGhost.y === origin.y) return lastGhost
  return (lastGhost = { x: origin.x, y: origin.y })
}
