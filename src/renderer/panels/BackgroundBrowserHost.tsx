// =============================================================================
// BackgroundBrowserHost — owns each main-window browser guest for its lifetime.
//
// BrowserPanel renders once into a stable external container which never moves
// or disconnects. The visible shell contributes only a geometry slot; the
// registry aligns the fixed container to it, including the canvas transform.
// Inactive surfaces are moved off-screen visually, keeping the same guest
// webContents, DOM, history and form state across workspace transitions.
// =============================================================================

import { useCallback, useLayoutEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../stores/appStore'
import BrowserPanel from './BrowserPanel'
import { registerBrowserSurface } from './browserSurfaceRegistry'
import type { PanelState } from '../../shared/types'

function PersistentBrowserSurface({
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
    <BrowserPanel
      panelId={panel.id}
      workspaceId={workspaceId}
      tabs={panel.tabs!}
      activeTabId={panel.activeTabId!}
      proxyUrl={panel.proxyUrl}
    />,
    container,
  )
}

export default function BackgroundBrowserHost(): React.ReactElement | null {
  const workspaces = useAppStore((state) => state.workspaces)
  const [backgroundRoot, setBackgroundRoot] = useState<HTMLDivElement | null>(null)
  const setRootRef = useCallback((element: HTMLDivElement | null) => {
    setBackgroundRoot(element)
  }, [])
  const browsers = useMemo(() => workspaces.flatMap((workspace) => (
    Object.values(workspace.panels)
      .filter((panel) => (
        panel.type === 'browser'
        && Boolean(panel.tabs?.length)
        && Boolean(panel.activeTabId)
      ))
      .map((panel) => ({ workspaceId: workspace.id, panel }))
  )), [workspaces])

  if (browsers.length === 0) return null

  return (
    <div
      ref={setRootRef}
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
