import React, { useId, useMemo } from 'react'
import type { CanvasNodeState, PanelState } from '../../shared/types'
import { collectPanelIds } from '../../shared/collectPanelIds'
import { useCanvasStoreContext } from '../stores/CanvasStoreContext'
import { useAppStore } from '../stores/appStore'
import { usePanelInteractionStore, type PanelInteraction } from '../lib/panelInteractions'
import { panelConnectionPath } from './panelConnectionGeometry'

interface RenderedConnection {
  key: string
  source: CanvasNodeState
  target: CanvasNodeState
  persistent: boolean
  interaction?: PanelInteraction
}

const EMPTY_PANELS: Record<string, PanelState> = {}

export function PanelConnectionLayer({ workspaceId }: { workspaceId: string }) {
  const markerPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const nodes = useCanvasStoreContext((state) => state.nodes)
  const panels = useAppStore(
    (state) => state.workspaces.find((workspace) => workspace.id === workspaceId)?.panels ?? EMPTY_PANELS,
  )
  const interactions = usePanelInteractionStore((state) => state.interactions)

  const connections = useMemo(() => {
    const panelToNode = new Map<string, CanvasNodeState>()
    for (const node of Object.values(nodes)) {
      for (const panelId of collectPanelIds(node.dockLayout)) panelToNode.set(panelId, node)
    }

    const byNodePair = new Map<string, RenderedConnection>()
    const add = (
      sourcePanelId: string,
      targetPanelId: string,
      persistent: boolean,
      interaction?: PanelInteraction,
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
        interaction: !interaction
          ? previous?.interaction
          : !previous?.interaction || interaction.updatedAt >= previous.interaction.updatedAt
            ? interaction
            : previous.interaction,
      })
    }

    for (const panel of Object.values(panels)) {
      const ownerPanelId = panel.codingAgentRun?.ownerPanelId
      if (ownerPanelId) add(ownerPanelId, panel.id, true)
    }
    for (const interaction of Object.values(interactions)) {
      if (interaction.workspaceId !== workspaceId) continue
      add(interaction.sourcePanelId, interaction.targetPanelId, false, interaction)
    }
    return [...byNodePair.values()]
  }, [interactions, nodes, panels, workspaceId])

  if (connections.length === 0) return null

  const marker = (phase: 'persistent' | 'active' | 'succeeded' | 'failed') => `${markerPrefix}-${phase}`
  return (
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
      </defs>
      {connections.flatMap((connection) => {
        const path = panelConnectionPath(
          { origin: connection.source.origin, size: connection.source.size },
          { origin: connection.target.origin, size: connection.target.size },
        )
        if (!path) return []
        const phase = connection.interaction?.phase
        return [
          connection.persistent ? (
            <path
              key={`${connection.key}-persistent`}
              data-panel-connection="persistent"
              d={path}
              fill="none"
              stroke="var(--text-muted)"
              strokeWidth="1.5"
              strokeDasharray="5 7"
              opacity="0.32"
              markerEnd={`url(#${marker('persistent')})`}
              vectorEffect="non-scaling-stroke"
            />
          ) : null,
          phase ? (
            <path
              key={`${connection.key}-${connection.interaction!.pulse}-${phase}`}
              data-panel-connection={phase}
              d={path}
              fill="none"
              stroke={phase === 'failed' ? 'var(--git-deleted)' : 'var(--focus-blue)'}
              strokeWidth="2.25"
              strokeLinecap="round"
              markerEnd={`url(#${marker(phase)})`}
              vectorEffect="non-scaling-stroke"
              className={phase === 'active' ? 'cate-panel-connection-active' : 'cate-panel-connection-finished'}
            />
          ) : null,
        ]
      })}
    </svg>
  )
}
