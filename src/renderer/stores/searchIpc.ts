// =============================================================================
// searchIpc — wire main-process search events into searchStore exactly once,
// for the lifetime of the window. Kept out of the SearchView component so that
// mounting/unmounting the view (switching sidebar tabs) never drops streamed
// batches that arrive during the gap.
// =============================================================================

import { useSearchStore } from './searchStore'

let initialized = false

export function ensureSearchSubscriptions(): void {
  if (initialized) return
  if (typeof window === 'undefined' || !window.electronAPI) return
  initialized = true

  window.electronAPI.onSearchResult(({ searchId, files }) => {
    useSearchStore.getState().addBatch(searchId, files)
  })
  window.electronAPI.onSearchDone(({ searchId, stats, error }) => {
    useSearchStore.getState().finishSearch(searchId, stats, error)
  })
}
