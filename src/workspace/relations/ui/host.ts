// What the relation UI reads and writes, installed by the client
// (client/layout/canvas): the workspace documents, the two settings it
// uses, the panel kinds it offers and panel creation. This module sits below
// the client layer, so everything arrives through here.

import { createContext, createElement, useCallback, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { Point, Size } from '@workspace/canvas/contract'
import type { DocBatch, DocChange, PlaceTarget, WorkspaceDocument } from '@workspace/document/contract'
import type { RelationRole } from '../contract'

export interface RelationDocument {
  getSnapshot(): WorkspaceDocument
  subscribe(listener: () => void): () => void
  propose(change: DocChange | DocBatch): { ok: boolean }
}

/** The panel type facts the relation UI needs (a panel definition fits). */
export interface RelationPanelKind {
  type: string
  label: string
  icon: string
  defaultSize: Size
  canLiveOnCanvas: boolean
  relation?: RelationRole
}

export interface RelationUiHost {
  /** The workspace's document mirror, null while it is not open. */
  document(workspaceId: string): RelationDocument | null
  /** Fires when documents open or close. */
  subscribeDocuments(listener: () => void): () => void
  /** Client setting `savedPanelRelationLabels`. */
  savedLabels: {
    get(): string[]
    set(labels: string[]): void
    subscribe(listener: () => void): () => void
  }
  /** Workspace setting `panelRelationsEnabled`; null while not open. */
  relationsEnabled(workspaceId: string): { get(): boolean; subscribe(listener: () => void): () => void } | null
  definitions(): readonly RelationPanelKind[]
  /** The kinds people can create on a canvas on this client, in creation
   *  order: what a relation drag into empty space offers. */
  creatable(): readonly RelationPanelKind[]
  /** Creates a panel of `type` placed at `at`; returns its id or null. */
  createPanel(workspaceId: string, type: string, options: { at: PlaceTarget; worktreeId?: string }): string | null
}

const noSubscribe = () => () => {}

const NO_HOST: RelationUiHost = {
  document: () => null,
  subscribeDocuments: noSubscribe,
  savedLabels: { get: () => [], set: () => {}, subscribe: noSubscribe },
  relationsEnabled: () => null,
  definitions: () => [],
  creatable: () => [],
  createPanel: () => null,
}

let host: RelationUiHost = NO_HOST
const hostListeners = new Set<() => void>()

export function installRelationUiHost(next: RelationUiHost | null): void {
  host = next ?? NO_HOST
  for (const listener of [...hostListeners]) listener()
}

export function relationUiHost(): RelationUiHost {
  return host
}

function subscribeHost(listener: () => void): () => void {
  hostListeners.add(listener)
  return () => { hostListeners.delete(listener) }
}

// --- Reads --------------------------------------------------------------------

/** A panel type's relation role, from its definition. */
export function relationRoleOf(type: string): RelationRole | undefined {
  return host.definitions().find((definition) => definition.type === type)?.relation
}

export function relationsEnabled(workspaceId: string): boolean {
  return host.relationsEnabled(workspaceId)?.get() ?? true
}

const EMPTY_PANELS: WorkspaceDocument['panels'] = {}
const EMPTY_RELATIONS: WorkspaceDocument['relations'] = {}

/** Subscribes to a workspace's document and to documents and hosts coming
 *  and going, rebinding as they do. */
function useDocumentValue<T>(workspaceId: string, read: (doc: WorkspaceDocument | null) => T): T {
  const subscribe = useCallback((listener: () => void) => {
    let stopDoc: () => void = () => {}
    const bind = () => {
      stopDoc()
      stopDoc = host.document(workspaceId)?.subscribe(listener) ?? (() => {})
    }
    bind()
    let stopDocs = host.subscribeDocuments(() => { bind(); listener() })
    const stopHost = subscribeHost(() => {
      stopDocs()
      stopDocs = host.subscribeDocuments(() => { bind(); listener() })
      bind()
      listener()
    })
    return () => { stopHost(); stopDocs(); stopDoc() }
  }, [workspaceId])
  return useSyncExternalStore(subscribe, () => read(host.document(workspaceId)?.getSnapshot() ?? null))
}

export function useRelationPanels(workspaceId: string): WorkspaceDocument['panels'] {
  return useDocumentValue(workspaceId, (doc) => doc?.panels ?? EMPTY_PANELS)
}

export function useRelationMap(workspaceId: string): WorkspaceDocument['relations'] {
  return useDocumentValue(workspaceId, (doc) => doc?.relations ?? EMPTY_RELATIONS)
}

export function useRelationsEnabled(workspaceId: string): boolean {
  const subscribe = useCallback((listener: () => void) => {
    let stop: () => void = () => {}
    const bind = () => {
      stop()
      stop = host.relationsEnabled(workspaceId)?.subscribe(listener) ?? (() => {})
    }
    bind()
    const stopDocs = host.subscribeDocuments(() => { bind(); listener() })
    const stopHost = subscribeHost(() => { bind(); listener() })
    return () => { stopHost(); stopDocs(); stop() }
  }, [workspaceId])
  return useSyncExternalStore(subscribe, () => relationsEnabled(workspaceId))
}

const subscribeLabels = (listener: () => void) => {
  let stop = host.savedLabels.subscribe(listener)
  const stopHost = subscribeHost(() => {
    stop()
    stop = host.savedLabels.subscribe(listener)
    listener()
  })
  return () => { stopHost(); stop() }
}

export function useSavedRelationLabels(): string[] {
  return useSyncExternalStore(subscribeLabels, () => host.savedLabels.get())
}

// --- The canvas the UI is drawn on --------------------------------------------

/** What the relation UI reads from the canvas it is drawn on (the canvas
 *  view store fits). */
export interface RelationCanvas {
  getState(): {
    zoomLevel: number
    viewportOffset: Point
    nodeForPanel(panelId: string): string | null
    placeTarget(size: Size, options?: { position?: Point; exact?: boolean }): PlaceTarget
    selectNodes(ids: readonly string[], additive?: boolean): void
    zoomToSelection(): void
    focusNode(nodeId: string): void
  }
}

export interface RelationCanvasValue {
  canvas: RelationCanvas | null
  /** The layer relation menus portal into, above browser surfaces.
   *  `undefined`: no canvas (tests); `null`: not mounted yet. */
  overlayTarget: HTMLElement | null | undefined
}

const RelationCanvasContext = createContext<RelationCanvasValue>({ canvas: null, overlayTarget: undefined })

export function RelationCanvasProvider({ canvas, overlayTarget, children }: RelationCanvasValue & { children?: ReactNode }) {
  return createElement(RelationCanvasContext.Provider, { value: { canvas, overlayTarget } }, children)
}

export function useRelationCanvas(): RelationCanvasValue {
  return useContext(RelationCanvasContext)
}
