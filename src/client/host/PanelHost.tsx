// PanelHost: the only panel renderer (12.1). It reads the record from the
// document, resolves the view through the view slot, shows a placeholder where
// this client lacks a feature the definition requires (12.2 rule 4), and keeps
// a render error inside the panel.

import React, { createContext, memo, Suspense, useSyncExternalStore, type ReactNode } from 'react'
import type { PanelRecord } from '@workspace/document/contract'
import type { AnyPanelDefinition } from '@panels/framework/contract'
import { documentStoreFor, documentStoresVersion, subscribeDocumentStores } from '@client/document'
import { useDocument } from '@client/document/ui'
import { LoadingState, PanelCenteredState, PanelErrorBoundary } from '@kernel/ui'
import { missingFeatures, panelDefinition } from './definitions'
import { PanelSessionBoundary } from './PanelSessionBoundary'
import { PanelSurfaceSlot } from './surfaceRegistry'
import { panelView } from './views'

/** Structural limits of where a view sits, for pickers inside it (a surface
 *  on a canvas node offers only types that can live on a canvas). */
export const PanelPlacementContext = createContext<{ onCanvas?: boolean } | null>(null)

export function PanelSuspense({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<LoadingState label="Loading panel…" className="w-full h-full bg-surface-4 text-sm" />}>
      {children}
    </Suspense>
  )
}

const noop = () => () => {}

/** Renders its children once the workspace's document has arrived. */
export function WorkspaceReady({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  useSyncExternalStore(subscribeDocumentStores, documentStoresVersion)
  const store = documentStoreFor(workspaceId)
  const synced = useSyncExternalStore(store ? store.subscribe : noop, () => store?.isSynced() ?? false)
  if (synced) return <>{children}</>
  return (
    <div data-workspace-required className="flex h-full min-h-0 items-center justify-center overflow-auto p-6">
      <LoadingState label="Opening workspace…" />
    </div>
  )
}

/** In the panel's place on a client that cannot show it. The panel, its
 *  session and its placement are untouched. */
export function PanelUnavailable({ definition }: { definition?: AnyPanelDefinition }) {
  const missing = definition ? missingFeatures(definition) : []
  return (
    <PanelCenteredState
      title="Not available on this device"
      description={missing.length > 0
        ? `${definition?.label ?? 'This panel'} needs ${missing.join(', ')}.`
        : 'This client does not know this panel type.'}
    />
  )
}

interface PanelHostProps {
  workspaceId: string
  panelId: string
  /** The host is a canvas node: a type that cannot live on a canvas renders
   *  nothing there. */
  onCanvas?: boolean
}

export function PanelHost({ workspaceId, panelId, onCanvas = false }: PanelHostProps): React.ReactElement | null {
  const record = useDocument(workspaceId, (doc) => doc.panels[panelId])
  if (!record) return null
  return <PanelContent workspaceId={workspaceId} record={record} onCanvas={onCanvas} />
}

const PanelContent = memo(function PanelContent({ workspaceId, record, onCanvas }: {
  workspaceId: string
  record: PanelRecord
  onCanvas: boolean
}): React.ReactElement | null {
  const definition = panelDefinition(record.type)
  if (!definition) return <PanelUnavailable />
  if (onCanvas && !definition.canLiveOnCanvas) return null
  if (missingFeatures(definition).length > 0) return <PanelUnavailable definition={definition} />
  if (definition.surface) {
    return <WorkspaceReady workspaceId={workspaceId}><PanelSurfaceSlot panelId={record.id} /></WorkspaceReady>
  }
  return <WorkspaceReady workspaceId={workspaceId}><PanelView workspaceId={workspaceId} record={record} /></WorkspaceReady>
})

/** The registered view for a record in its error boundary and session
 *  boundary. The persistent host renders surface views through this too. */
export function PanelView({ workspaceId, record }: { workspaceId: string; record: PanelRecord }): React.ReactElement {
  const View = panelView(record.type)
  if (!View) return <PanelUnavailable />
  return (
    <PanelErrorBoundary panelType={record.type} panelId={record.id}>
      <PanelSessionBoundary workspaceId={workspaceId} record={record}>
        {(props) => <PanelSuspense key={record.id}><View {...props} /></PanelSuspense>}
      </PanelSessionBoundary>
    </PanelErrorBoundary>
  )
}
