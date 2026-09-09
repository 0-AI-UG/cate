// =============================================================================
// BackgroundBrowserHost — persistent browser guests and recently used T3 guests.
//
// BrowserPanel renders once into a stable external container which never moves
// or disconnects. The visible shell contributes only a geometry slot; the
// registry aligns the fixed container to it, including the canvas transform.
// Inactive surfaces are parked without resizing, keeping the same guest
// webContents, DOM, history and form state across workspace transitions.
// =============================================================================

import { lazy, memo, Suspense, useCallback, useLayoutEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import { WorkspaceRequired } from './WorkspaceRequired'
import BrowserPanel from './BrowserPanel'
import { registerBrowserSurface } from './browserSurfaceRegistry'
import type { PanelState } from '../../shared/types'

const AgentPanel = lazy(() => import('./AgentPanel'))

const PersistentBrowserSurface = memo(function PersistentBrowserSurface({
  workspaceId,
  panel,
  backgroundRoot,
}: {
  workspaceId: string
  panel: PanelState
  backgroundRoot: HTMLDivElement | null
}): React.ReactElement {
  const [container] = useState(() => {
    const element = document.createElement('div')
    element.className = 'relative h-full w-full min-h-0 min-w-0'
    element.dataset.browserSurface = panel.id
    return element
  })

  useLayoutEffect(() => {
    return registerBrowserSurface(panel.id, container, backgroundRoot)
  }, [backgroundRoot, container, panel.id])

  useLayoutEffect(() => () => container.remove(), [container])

  return createPortal(
    <WorkspaceRequired workspaceId={workspaceId}>{panel.type === 'agent' ? <Suspense fallback={null}><AgentPanel panelId={panel.id} workspaceId={workspaceId} /></Suspense> : <BrowserPanel
      panelId={panel.id}
      workspaceId={workspaceId}
      tabs={panel.tabs!}
      activeTabId={panel.activeTabId!}
      proxyUrl={panel.proxyUrl}
    />}</WorkspaceRequired>,
    container,
  )
})

export default function BackgroundBrowserHost({ workspaceId }: { workspaceId?: string }): React.ReactElement | null {
  const showSettings = useUIStore((s) => s.showSettings)
  const workspaces = useAppStore((state) => state.workspaces)
  const selected = useAppStore((state) => workspaceId ?? state.selectedWorkspaceId)
  // Bound retained T3 UIs. Closing/removing panels still unmounts immediately.
  const [recent, setRecent] = useState([selected])
  if (recent[0] !== selected) setRecent([selected, ...recent.filter((id) => id !== selected)].slice(0, 2))
  const [backgroundRoot, setBackgroundRoot] = useState<HTMLDivElement | null>(null)
  const setRootRef = useCallback((element: HTMLDivElement | null) => {
    setBackgroundRoot(element)
  }, [])
  const browsers = useMemo(() => workspaces.flatMap((workspace) => (
    Object.values(workspace.panels)
      .filter((panel) => (
        (panel.type === 'browser' && Boolean(panel.tabs?.length) && Boolean(panel.activeTabId))
        || (panel.type === 'agent' && recent.includes(workspace.id))
      ))
      .map((panel) => ({ workspaceId: workspace.id, panel }))
  )), [workspaces, recent])

  if (browsers.length === 0) return null

  return (
    <div
      ref={setRootRef}
      hidden={showSettings}
      data-background-browser-host
      className="fixed inset-0 pointer-events-none overflow-hidden"
    >
      {browsers.map(({ workspaceId, panel }) => (
        <PersistentBrowserSurface
          key={`${workspaceId}:${panel.id}`}
          workspaceId={workspaceId}
          panel={panel}
          backgroundRoot={backgroundRoot}
        />
      ))}
    </div>
  )
}
