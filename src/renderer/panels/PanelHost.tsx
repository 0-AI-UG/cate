import React, { useCallback, useContext } from 'react'
import type { PanelState } from '../../shared/types'
import { getPanelDef, renderPanelComponent } from './registry'
import { PanelSuspense } from './PanelSuspense'
import { BrowserPanelSurfaceSlot, PersistentBrowserHostContext } from './browserSurfaceRegistry'

interface PanelHostProps {
  panelId: string
  panels: Record<string, PanelState>
  workspaceId: string
  nodeId?: string
  zoomLevel?: number
  allowCanvas?: boolean
}

/** The sole renderer for panel records, shared by main and detached windows. */
export function PanelHost({
  panelId,
  panels,
  workspaceId,
  nodeId = '',
  zoomLevel = 1,
  allowCanvas = true,
}: PanelHostProps): React.ReactElement | null {
  const persistentBrowserHost = useContext(PersistentBrowserHostContext)
  const panel = panels[panelId]
  const renderPanelContent = useCallback(
    (childPanelId: string, childNodeId: string, childZoom: number) => (
      <PanelHost
        key={childPanelId}
        panelId={childPanelId}
        panels={panels}
        workspaceId={workspaceId}
        nodeId={childNodeId}
        zoomLevel={childZoom}
        allowCanvas={false}
      />
    ),
    [panels, workspaceId],
  )

  if (!panel) return null
  if (!allowCanvas && !getPanelDef(panel.type).canLiveOnCanvas) return null
  if (panel.type === 'browser' && persistentBrowserHost) {
    return <BrowserPanelSurfaceSlot panelId={panel.id} />
  }
  const content = renderPanelComponent(panel, {
    workspaceId,
    nodeId,
    zoomLevel,
    renderPanelContent,
  })
  return content ? <PanelSuspense key={panel.id}>{content}</PanelSuspense> : null
}
