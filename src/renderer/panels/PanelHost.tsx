import React, { createContext, memo, useCallback, useContext } from 'react'
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

// Context carries records through a canvas without changing its render callback.
// Leaf hosts consume it, then memoize content on their own panel record.
const PanelRecordsContext = createContext<Record<string, PanelState>>({})

export function PanelHost({ panels, panelId, ...props }: PanelHostProps): React.ReactElement {
  return <PanelRecordsContext.Provider value={panels}>
    <PanelContent panel={panels[panelId]} {...props} />
  </PanelRecordsContext.Provider>
}

function ChildPanelHost({ panelId, ...props }: Omit<PanelHostProps, 'panels'>): React.ReactElement {
  const panels = useContext(PanelRecordsContext)
  return <PanelContent panel={panels[panelId]} {...props} />
}

/** The sole renderer for panel records, shared by main and detached windows. */
const PanelContent = memo(function PanelContent({
  panel,
  workspaceId,
  nodeId = '',
  zoomLevel = 1,
  allowCanvas = true,
}: Omit<PanelHostProps, 'panels' | 'panelId'> & { panel?: PanelState }): React.ReactElement | null {
  const persistentBrowserHost = useContext(PersistentBrowserHostContext)
  const renderPanelContent = useCallback(
    (childPanelId: string, childNodeId: string, childZoom: number) => (
      <ChildPanelHost
        key={childPanelId}
        panelId={childPanelId}
        workspaceId={workspaceId}
        nodeId={childNodeId}
        zoomLevel={childZoom}
        allowCanvas={false}
      />
    ),
    [workspaceId],
  )

  if (!panel) return null
  if (!allowCanvas && !getPanelDef(panel.type).canLiveOnCanvas) return null
  if ((panel.type === 'browser' || panel.type === 'agent') && persistentBrowserHost) {
    return <BrowserPanelSurfaceSlot panelId={panel.id} />
  }
  const content = renderPanelComponent(panel, {
    workspaceId,
    nodeId,
    zoomLevel,
    renderPanelContent,
  })
  return content ? <PanelSuspense key={panel.id}>{content}</PanelSuspense> : null
})
