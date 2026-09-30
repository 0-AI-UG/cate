// PersistentPanelHost keeps native surfaces (webviews) alive across tab and
// workspace switches and off-screen on a canvas. Each surface view renders
// once into a stable container; the visible PanelHost contributes only a
// geometry slot, and the surface registry aligns the container to it. Inactive
// surfaces are parked without resizing, so the page keeps its state.

import { memo, useCallback, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { windowOf, type PanelRecord, type WorkspaceDocument } from '@workspace/document/contract'
import { useDocument } from '@client/document/ui'
import { panelDefinition } from './definitions'
import { PanelView, WorkspaceReady } from './PanelHost'
import { PanelVisibilityContext } from './PanelSessionBoundary'
import { isSurfaceVisible, registerPanelSurface, subscribeSurfaceVisibility } from './surfaceRegistry'
import { isSurfaceDemanded, useDemandedSurfaces } from './surfaceDemand'

const PersistentPanelSurface = memo(function PersistentPanelSurface({
  workspaceId,
  record,
  backgroundRoot,
}: {
  workspaceId: string
  record: PanelRecord
  backgroundRoot: HTMLDivElement | null
}) {
  const [container] = useState(() => {
    const element = document.createElement('div')
    element.className = 'relative h-full w-full min-h-0 min-w-0'
    element.dataset.browserSurface = record.id
    return element
  })
  useLayoutEffect(() => registerPanelSurface(record.id, container, backgroundRoot), [backgroundRoot, container, record.id])
  useLayoutEffect(() => () => container.remove(), [container])

  const subscribe = useCallback((listener: () => void) => subscribeSurfaceVisibility(record.id, listener), [record.id])
  const visible = useSyncExternalStore(subscribe, () => isSurfaceVisible(record.id))

  return createPortal(
    <WorkspaceReady workspaceId={workspaceId}>
      <PanelVisibilityContext.Provider value={visible}>
        <PanelView workspaceId={workspaceId} record={record} />
      </PanelVisibilityContext.Provider>
    </WorkspaceReady>,
    container,
  )
})

function surfaceRecords(
  doc: WorkspaceDocument,
  windowId: string | null,
  retained: boolean,
  demanded: (panelId: string) => boolean,
): PanelRecord[] {
  return Object.values(doc.panels).filter((record) => {
    const policy = panelDefinition(record.type)?.surface
    if (!policy) return false
    // A page operation waiting on this client mounts the surface wherever
    // the panel lives (architecture 10.2).
    if (demanded(record.id)) return true
    if (windowId !== null && windowOf(doc, record.id) !== windowId) return false
    return policy.retention === 'workspace' || retained
  })
}

const sameRecords = (a: PanelRecord[], b: PanelRecord[]) => a.length === b.length && a.every((r, i) => r === b[i])

function WorkspaceSurfaces({ workspaceId, windowId, retained, backgroundRoot }: {
  workspaceId: string
  windowId: string | null
  retained: boolean
  backgroundRoot: HTMLDivElement | null
}) {
  const demanded = useDemandedSurfaces()
  const selector = useMemo(
    () => (doc: WorkspaceDocument) => surfaceRecords(doc, windowId, retained, (id) => isSurfaceDemanded(demanded, workspaceId, id)),
    [windowId, retained, demanded, workspaceId],
  )
  const records = useDocument(workspaceId, selector, sameRecords)
  return <>{records.map((record) => (
    <PersistentPanelSurface key={record.id} workspaceId={workspaceId} record={record} backgroundRoot={backgroundRoot} />
  ))}</>
}

/** How many workspaces keep their `recent` surfaces (T3 UIs) mounted. */
const RECENT_WORKSPACES = 2

export function PersistentPanelHost({ workspaceIds, activeWorkspaceId, windowId, hidden = false }: {
  /** The open workspaces. */
  workspaceIds: readonly string[]
  activeWorkspaceId: string | null
  /** Only surfaces of panels shown in this window; null for every window (a
   *  client that shows all windows in one). */
  windowId: string | null
  /** Hide every surface (a full-window overlay such as settings is up). */
  hidden?: boolean
}) {
  // No workspace shown (the welcome page) keeps the recent ones.
  const [recent, setRecent] = useState<string[]>(activeWorkspaceId ? [activeWorkspaceId] : [])
  if (activeWorkspaceId && recent[0] !== activeWorkspaceId) {
    setRecent([activeWorkspaceId, ...recent.filter((id) => id !== activeWorkspaceId)].slice(0, RECENT_WORKSPACES))
  }
  const [backgroundRoot, setBackgroundRoot] = useState<HTMLDivElement | null>(null)
  if (workspaceIds.length === 0) return null
  return (
    <div
      ref={setBackgroundRoot}
      hidden={hidden}
      data-background-browser-host
      className="fixed inset-0 pointer-events-none overflow-hidden"
    >
      {workspaceIds.map((workspaceId) => (
        <WorkspaceSurfaces
          key={workspaceId}
          workspaceId={workspaceId}
          windowId={windowId}
          retained={recent.includes(workspaceId)}
          backgroundRoot={backgroundRoot}
        />
      ))}
    </div>
  )
}
