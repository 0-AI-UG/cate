import { useCallback, useRef, useSyncExternalStore } from 'react'
import { createDocument, type PresenceClient, type WorkspaceDocument } from '@workspace/document/contract'
import type { ClientState } from '@client/document'
import { clientStateFor, documentStoreFor, documentStoresVersion, otherClientsOf, subscribeDocumentStores } from '@client/document'

const EMPTY_DOCUMENT = createDocument()
const noop = () => () => {}

interface Source<S> {
  getSnapshot(): S
  subscribe(listener: () => void): () => void
}

function useSelected<S, T>(source: Source<S> | null, fallback: S, selector: (s: S) => T, isEqual: (a: T, b: T) => boolean): T {
  const cache = useRef<{ from: S; selector: (s: S) => T; value: T } | null>(null)
  const read = () => {
    const from = source ? source.getSnapshot() : fallback
    const last = cache.current
    if (last && last.from === from && last.selector === selector) return last.value
    const value = selector(from)
    // Keep the old value when it is equal, so selectors may build new objects.
    const kept = last && isEqual(last.value, value) ? last.value : value
    cache.current = { from, selector, value: kept }
    return kept
  }
  return useSyncExternalStore(source ? source.subscribe : noop, read)
}

function useStores(): void {
  useSyncExternalStore(subscribeDocumentStores, documentStoresVersion)
}

/** Selects from the workspace's document (an empty one while it is not open).
 *  Re-renders only when the selected value changes under `isEqual`. */
export function useDocument<T>(
  workspaceId: string | null | undefined,
  selector: (doc: WorkspaceDocument) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  useStores()
  const store = workspaceId ? documentStoreFor(workspaceId) : null
  return useSelected(store, EMPTY_DOCUMENT, selector, isEqual)
}

const EMPTY_CLIENT_STATE: ClientState = {
  activeTabs: {},
  focusedPanelId: null,
  focusEpoch: 0,
  viewing: [],
  selection: {},
  viewports: {},
  maximizedStacks: {},
  maximizedNodes: {},
  panelViews: {},
  intents: [],
}

export function useClientState<T>(
  workspaceId: string | null | undefined,
  selector: (state: ClientState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  useStores()
  const store = workspaceId ? clientStateFor(workspaceId) : null
  return useSelected(store, EMPTY_CLIENT_STATE, selector, isEqual)
}

/** One named piece of what this client shows of a panel (client state, never
 *  sent): `fallback` until the view sets it. */
export function usePanelView<T>(
  workspaceId: string,
  panelId: string,
  key: string,
  fallback: T,
): [T, (value: T) => void] {
  const stored = useClientState(workspaceId, (state) => state.panelViews[panelId]?.[key])
  const set = useCallback((value: T) => clientStateFor(workspaceId)?.setPanelView(panelId, key, value), [workspaceId, panelId, key])
  return [stored === undefined ? fallback : stored as T, set]
}

/** The other clients in a workspace (presence); none while it is not open. */
export function useOtherClients(workspaceId: string): readonly PresenceClient[] {
  return useSyncExternalStore(subscribeDocumentStores, () => otherClientsOf(workspaceId))
}
