// The workspace's history and bookmarks for browser views, one store per
// open runtime.

import { useSyncExternalStore } from 'react'
import { useRuntime } from '@kernel/rpc/ui'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import { createBrowserDataStore, type BrowserDataState, type BrowserDataStore } from '../client'

const stores = new WeakMap<RuntimeProxy, BrowserDataStore>()
const EMPTY: BrowserDataState = { history: [], bookmarks: [] }
const noop = () => () => {}

export function browserDataStoreFor(runtime: RuntimeProxy): BrowserDataStore {
  let store = stores.get(runtime)
  if (!store) {
    store = createBrowserDataStore(runtime.browserData)
    stores.set(runtime, store)
  }
  return store
}

/** The store and its state; null store while the workspace is not open. */
export function useBrowserData(workspaceId: string): { store: BrowserDataStore | null; state: BrowserDataState } {
  const runtime = useRuntime(workspaceId)
  const store = runtime ? browserDataStoreFor(runtime) : null
  const state = useSyncExternalStore(store ? store.subscribe : noop, store ? store.getState : () => EMPTY)
  return { store, state }
}
