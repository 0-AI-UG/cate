// Each mounted search surface owns its subscriptions and correlation IDs. Reuse
// the existing store's stale-result filtering; never broadcast into one global store.
import type { SearchStore } from './searchStore'

const mountedStores = new Map<string, SearchStore>()

/** Active-panel lookup for the development/e2e harness. */
export function getMountedSearchStore(panelId: string): SearchStore | undefined {
  return mountedStores.get(panelId)
}

export function subscribeSearchStore(store: SearchStore, panelId?: string): () => void {
  if (panelId) mountedStores.set(panelId, store)
  const offResult = window.electronAPI.onSearchResult(({ searchId, files }) => {
    store.getState().addBatch(searchId, files)
  })
  const offDone = window.electronAPI.onSearchDone(({ searchId, stats, error }) => {
    store.getState().finishSearch(searchId, stats, error)
  })
  return () => {
    offResult()
    offDone()
    if (panelId && mountedStores.get(panelId) === store) mountedStores.delete(panelId)
  }
}
