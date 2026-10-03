import { useId, useMemo } from 'react'
import type { Point } from '@workspace/canvas/contract'
import { dockStacks, type DockNode, type PanelId, type PanelRecord, type PanelRelation } from '@workspace/document/contract'
import { panelConnectionMidpoint, panelConnectionPath } from '@workspace/relations/contract'
import {
  PanelRelationSelector,
  RelationCanvasProvider,
  relationRoleOf,
  usePanelInteractionStore,
  useRelationUi,
  useRelationsEnabled,
  type PanelInteraction,
} from '../../../workspace/relations'
import { useClientState, useDocument } from '../../document'
import type { CanvasDragState } from './ports'
import type { ViewNode } from './store'
import { useCanvasRelationOverlayTarget, useCanvasView, useCanvasViewStore } from './context'
import { useCanvasDrag } from './dragState'

interface RenderedConnection {
  key: string
  source: ViewNode
  target: ViewNode
  persistent: boolean
  flowIndex?: number
  interaction?: PanelInteraction
  relation?: PanelRelation
}

const EMPTY_RELATIONS: PanelRelation[] = []
const FLOW_HUE_STEP = 137.508

function flowColor(index: number): string {
  return `hsl(${Math.round((211 + index * FLOW_HUE_STEP) % 360)} 72% 58%)`
}

/** The panel each stack shows: its active tab, else its first. */
function visiblePanelIds(dock: DockNode, activeTabs: Readonly<Record<string, PanelId>>): PanelId[] {
  return dockStacks(dock).flatMap((stack) => {
    const active = activeTabs[stack.id]
    const shown = active && stack.panels.includes(active) ? active : stack.panels[0]
    return shown ? [shown] : []
  })
}

/** A supervising panel recorded on a worker panel's coding-agent run. */
function ownerPanelId(record: PanelRecord): string | undefined {
  const run = record.fields.codingAgentRun
  if (!run || typeof run !== 'object' || Array.isArray(run)) return undefined
  const owner = (run as Record<string, unknown>).ownerPanelId
  return typeof owner === 'string' ? owner : undefined
}

const takesPrompts = (record: PanelRecord) => relationRoleOf(record.type)?.execution === true

/** A flow starts at an execution surface and stops when it reaches the next
 * one. The incoming handoff relation keeps the sender's color; relations
 * leaving the receiving terminal/T3 start that panel's new flow color. */
function relationFlowIndexes(
  relations: readonly PanelRelation[],
  panels: Record<string, PanelRecord>,
): Map<string, number> {
  const outgoing = new Map<string, PanelRelation[]>()
  for (const relation of relations) {
    const connected = outgoing.get(relation.fromPanelId) ?? []
    connected.push(relation)
    outgoing.set(relation.fromPanelId, connected)
  }

  const indexes = new Map<string, number>()
  let flowIndex = 0
  for (const source of Object.values(panels)) {
    if (!takesPrompts(source) || !outgoing.has(source.id)) continue
    const queue = [source.id]
    const seenPanels = new Set<string>()
    while (queue.length > 0) {
      const panelId = queue.shift()!
      if (seenPanels.has(panelId)) continue
      seenPanels.add(panelId)
      for (const relation of outgoing.get(panelId) ?? []) {
        if (indexes.has(relation.id)) continue
        indexes.set(relation.id, flowIndex)
        const target = panels[relation.toPanelId]
        if (target && !takesPrompts(target)) queue.push(target.id)
      }
    }
    flowIndex += 1
  }
  return indexes
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
  const interactions = usePanelInteractionStore((state) => state.interactions)
  const waypointPreview = useRelationUi((state) => state.waypointPreview)
  const panelRelationsEnabled = useRelationsEnabled(workspaceId)
  const dragSourceNodeId = useCanvasDrag(selectSourceNode)
  const dragGhost = useCanvasDrag(selectGhostOrigin)

  const connections = useMemo(() => {
    const enabledRelations = panelRelationsEnabled ? relations : EMPTY_RELATIONS
    const flowIndexes = relationFlowIndexes(enabledRelations, panels)
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
    const add = (
      sourcePanelId: string,
      targetPanelId: string,
      persistent: boolean,
      interaction?: PanelInteraction,
      relation?: PanelRelation,
    ) => {
      const source = panelToNode.get(sourcePanelId)
      const target = panelToNode.get(targetPanelId)
      if (!source || !target || source.id === target.id) return
      const key = `${source.id}\0${target.id}`
      const previous = byNodePair.get(key)
      byNodePair.set(key, {
        key,
        source,
        target,
        persistent: persistent || previous?.persistent === true,
        flowIndex: relation ? flowIndexes.get(relation.id) : previous?.flowIndex,
        interaction: !interaction
          ? previous?.interaction
          : !previous?.interaction || interaction.updatedAt >= previous.interaction.updatedAt
            ? interaction
            : previous.interaction,
        relation: relation ?? previous?.relation,
      })
    }

    for (const panel of Object.values(panels)) {
      const owner = ownerPanelId(panel)
      if (owner) add(owner, panel.id, true)
    }
    for (const interaction of Object.values(interactions)) {
      if (interaction.workspaceId !== workspaceId) continue
      add(interaction.sourcePanelId, interaction.targetPanelId, false, interaction)
    }
    for (const relation of enabledRelations) {
      const preview = waypointPreview[relation.id]
      add(relation.fromPanelId, relation.toPanelId, false, undefined, preview ? { ...relation, waypoint: preview } : relation)
    }
    return [...byNodePair.values()]
  }, [activeTabs, dragGhost, dragSourceNodeId, interactions, nodes, panels, panelRelationsEnabled, relations, waypointPreview, workspaceId])

  if (connections.length === 0) return null

  const marker = (phase: 'persistent' | 'active' | 'succeeded' | 'failed') => `${markerPrefix}-${phase}`
  const flowMarker = (flowIndex: number) => `${markerPrefix}-flow-${flowIndex}`
  const flowIndexes = [...new Set(connections
    .map((connection) => connection.flowIndex)
    .filter((index): index is number => index !== undefined))]
  const selectors = connections.map((connection) => {
    if (!connection.relation) return null
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
          {(['persistent', 'active', 'succeeded', 'failed'] as const).map((phase) => (
            <marker
              key={phase}
              id={marker(phase)}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="8"
              markerHeight="8"
              orient="auto"
              markerUnits="userSpaceOnUse"
            >
              <path
                d="M 0 0 L 8 4 L 0 8 z"
                fill={phase === 'persistent'
                  ? 'var(--text-muted)'
                  : phase === 'failed' ? 'var(--git-deleted)' : 'var(--focus-blue)'}
              />
            </marker>
          ))}
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
            connection.relation?.fromSide,
            connection.relation?.toSide,
            connection.relation?.waypoint,
          )
          if (!path) return null
          const phase = connection.interaction?.phase
          const hasBaseline = Boolean(connection.relation || connection.persistent)
          const visualState = phase ?? (connection.relation ? 'relation' : 'persistent')
          const emphasized = Boolean(phase || connection.relation)
          const markerState = phase ?? (connection.relation ? 'active' : 'persistent')
          const relationColor = connection.flowIndex === undefined ? undefined : flowColor(connection.flowIndex)
          return (
            <path
              key={connection.key}
              data-panel-connection={visualState}
              data-panel-connection-base={connection.relation ? 'relation' : connection.persistent ? 'persistent' : undefined}
              data-panel-relation-id={connection.relation?.id}
              data-panel-flow={connection.flowIndex}
              d={path}
              fill="none"
              stroke={phase === 'failed'
                ? 'var(--git-deleted)'
                : relationColor ?? (emphasized ? 'var(--focus-blue)' : 'var(--text-muted)')}
              strokeWidth={emphasized ? 2.25 : 1.5}
              strokeLinecap="round"
              opacity={emphasized ? 1 : 0.32}
              markerEnd={`url(#${relationColor && phase !== 'failed'
                ? flowMarker(connection.flowIndex!)
                : marker(markerState)})`}
              vectorEffect="non-scaling-stroke"
              className={`cate-panel-connection${phase === 'active'
                ? ' cate-panel-connection-active'
                : phase && !hasBaseline ? ' cate-panel-connection-finished' : ''}`}
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
