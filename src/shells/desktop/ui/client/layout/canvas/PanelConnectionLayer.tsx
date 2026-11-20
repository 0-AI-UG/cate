import { useId, useMemo } from 'react'
import type { Point } from '@workspace/canvas/contract'
import { dockStacks, type DockNode, type PanelId, type PanelRecord, type PanelRelation } from '@workspace/document/contract'
import { panelConnectionMidpoint, panelConnectionPath } from '@workspace/canvas/contract'
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
  const markerPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const canvasStore = useCanvasViewStore()
  const overlayTarget = useCanvasRelationOverlayTarget()
  const nodes = useCanvasView((state) => state.nodes)
  const activeTabs = useClientState(workspaceId, (state) => state.activeTabs)
  const panels = useDocument(workspaceId, (doc) => doc.panels)
  const relationMap = useDocument(workspaceId, (doc) => doc.relations)
  const relations = useMemo(() => Object.values(relationMap), [relationMap])
  const agents = useAgentPanels(workspaceId, (states) => states)
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

  const defaultMarker = `${markerPrefix}-relation`
  const flowMarker = (flowIndex: number) => `${markerPrefix}-flow-${flowIndex}`
  const flowIndexes = [...new Set(connections
    .map((connection) => connection.flowIndex)
    .filter((index): index is number => index !== undefined))]
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
        <defs>
          <marker
            id={defaultMarker}
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="8"
            markerHeight="8"
            orient="auto"
            markerUnits="userSpaceOnUse"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--focus-blue)" />
          </marker>
          {flowIndexes.map((flowIndex) => (
            <marker
              key={`flow-${flowIndex}`}
              id={flowMarker(flowIndex)}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="8"
              markerHeight="8"
              orient="auto"
              markerUnits="userSpaceOnUse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill={flowColor(flowIndex)} />
            </marker>
          ))}
        </defs>
        {connections.map((connection) => {
          const path = panelConnectionPath(
            { origin: connection.source.origin, size: connection.source.size },
            { origin: connection.target.origin, size: connection.target.size },
            connection.relation.fromSide,
            connection.relation.toSide,
            connection.relation.waypoint,
          )
          if (!path) return null
          const relationColor = connection.flowIndex === undefined ? undefined : flowColor(connection.flowIndex)
          const dimmed = !connection.pending
          return (
            <path
              key={connection.key}
              data-panel-connection="relation"
              data-panel-relation-id={connection.relation.id}
              data-panel-flow={connection.flowIndex}
              data-panel-relation-context-pending={connection.pending}
              d={path}
              fill="none"
              stroke={relationColor ?? 'var(--focus-blue)'}
              strokeWidth={2.25}
              opacity={dimmed ? 0.3 : undefined}
              strokeLinecap="round"
              markerEnd={`url(#${relationColor ? flowMarker(connection.flowIndex!) : defaultMarker})`}
              vectorEffect="non-scaling-stroke"
              className="cate-panel-connection"
            />
          )
        })}
      </svg>
      <RelationCanvasProvider canvas={canvasStore} overlayTarget={overlayTarget}>{selectors}</RelationCanvasProvider>
    </>
  )
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
