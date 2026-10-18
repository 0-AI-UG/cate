// PersistentPanelHost keeps native surfaces (webviews) alive across tab and
// workspace switches and off-screen on a canvas. Each surface view renders
// once into a stable container; the visible PanelHost contributes only a
// geometry slot, and the surface registry aligns the container to it. Inactive
// surfaces are parked without resizing, so the page keeps its state. Each
// workspace's surfaces render inside that workspace's `Scope` (the contexts
// its views read), which lives as long as they do.

import { memo, useCallback, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { hostOf, isNodeHost, placementOf, windowOf, type PanelRecord, type WorkspaceDocument } from '@workspace/document/contract'
import { clientStateFor, documentStoreFor } from '@client/document'
import { useDocument } from '../document'
import { panelDefinition } from '@client/host'
import { PanelView, WorkspaceReady } from './PanelHost'
import { PanelVisibilityContext } from './PanelSessionBoundary'
import { isSurfaceVisible, registerPanelSurface, subscribeSurfaceVisibility } from './surfaceRegistry'
import { isSurfaceDemanded } from '@client/host'
import { useDemandedSurfaces } from './hooks'

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
  // The surface is drawn over its pane but is not inside it: the pane never sees
  // a press in it, nor a webview taking the focus (which also blurs this window).
  // So the surface focuses its panel itself, when it is shown in a dock; a canvas
  // node does its own focusing.
  useLayoutEffect(() => {
    const focusPanel = () => {
      const doc = documentStoreFor(workspaceId)?.getSnapshot()
      const placement = doc && placementOf(doc, record.id)
      const host = doc && placement && hostOf(doc, placement.dock.layoutId)
      if (host && !isNodeHost(host)) clientStateFor(workspaceId)?.focus(record.id)
    }
    const onBlur = () => globalThis.setTimeout(() => { if (container.contains(document.activeElement)) focusPanel() }, 0)
    container.addEventListener('pointerdown', focusPanel, true)
    container.addEventListener('focusin', focusPanel)
    window.addEventListener('blur', onBlur)
    return () => {
      container.removeEventListener('pointerdown', focusPanel, true)
      container.removeEventListener('focusin', focusPanel)
      window.removeEventListener('blur', onBlur)
    }
  }, [container, workspaceId, record.id])

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
  demanded: (panelId: string) => boolean,
): PanelRecord[] {
  return Object.values(doc.panels).filter((record) => {
    const policy = panelDefinition(record.type)?.surface
    if (!policy) return false
    // A page operation waiting on this client mounts the surface wherever
    // the panel lives (architecture 10.2).
    if (demanded(record.id)) return true
    return windowId === null || windowOf(doc, record.id) === windowId
  })
}

const sameRecords = (a: PanelRecord[], b: PanelRecord[]) => a.length === b.length && a.every((r, i) => r === b[i])

/** The contexts a workspace's views read, around its surfaces. */
export type SurfaceScope = ComponentType<{ workspaceId: string; children: ReactNode }>

function WorkspaceSurfaces({ workspaceId, windowId, backgroundRoot, Scope }: {
  workspaceId: string
  windowId: string | null
  backgroundRoot: HTMLDivElement | null
  Scope: SurfaceScope
}) {
  const demanded = useDemandedSurfaces()
  const selector = useMemo(
    () => (doc: WorkspaceDocument) => surfaceRecords(doc, windowId, (id) => isSurfaceDemanded(demanded, workspaceId, id)),
    [windowId, demanded, workspaceId],
  )
  const records = useDocument(workspaceId, selector, sameRecords)
  return <Scope workspaceId={workspaceId}>{records.map((record) => (
    <PersistentPanelSurface key={record.id} workspaceId={workspaceId} record={record} backgroundRoot={backgroundRoot} />
  ))}</Scope>
}

export function PersistentPanelHost({ workspaceIds, windowId, hidden = false, Scope }: {
  /** The open workspaces. */
  workspaceIds: readonly string[]
  /** Only surfaces of panels shown in this window; null for every window (a
   *  client that shows all windows in one). */
  windowId: string | null
  /** Hide every surface (a full-window overlay such as settings is up). */
  hidden?: boolean
  Scope: SurfaceScope
}) {
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
          backgroundRoot={backgroundRoot}
          Scope={Scope}
        />
      ))}
    </div>
  )
}
