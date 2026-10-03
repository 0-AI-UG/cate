// Search state belongs to the panel, not its temporarily mounted view: each
// panel keeps one store and one runner per root until it is released.

import { createSearchRunner, type SearchRunnerOptions } from './searchRunner'
import { createSearchStore, type SearchState, type SearchStore } from './searchStore'

/** The portable options of a panel's search, as views persist them. */
export interface PanelSearchSnapshot {
  rootPath: string
  query: string
  isRegex: boolean
  matchCase: boolean
  wholeWord: boolean
  includes: string
  excludes: string
  respectIgnore: boolean
  optionsExpanded: boolean
}

export interface PanelSearchOptions extends SearchRunnerOptions {
  /** Restores these options when their root matches. */
  saved?: PanelSearchSnapshot
  /** Called when a persisted option changes (not on result delivery). */
  onOptionsChange?: () => void
}

interface Entry {
  rootPath: string
  store: SearchStore
  dispose: () => void
}

const stores = new Map<string, Entry>()

function searchOptions(state: Omit<PanelSearchSnapshot, 'rootPath'>): Omit<PanelSearchSnapshot, 'rootPath'> {
  const { query, isRegex, matchCase, wholeWord, includes, excludes, respectIgnore, optionsExpanded } = state
  return { query, isRegex, matchCase, wholeWord, includes, excludes, respectIgnore, optionsExpanded }
}

const OPTION_KEYS = Object.keys(searchOptions(createSearchStore().getState())) as Array<keyof SearchState>

/** The panel's search store for `rootPath`; a new root starts a fresh store. */
export function panelSearchStore(panelId: string, workspaceId: string, rootPath: string, options: PanelSearchOptions = {}): SearchStore {
  let entry = stores.get(panelId)
  if (!entry || entry.rootPath !== rootPath) {
    releasePanelSearchStore(panelId)
    const store = createSearchStore()
    if (options.saved?.rootPath === rootPath) store.setState(searchOptions(options.saved))
    const unsubscribe = store.subscribe((state, previous) => {
      if (OPTION_KEYS.some((key) => state[key] !== previous[key])) options.onOptionsChange?.()
    })
    const runner = createSearchRunner(store, rootPath, workspaceId, options)
    entry = { rootPath, store, dispose: () => { unsubscribe(); runner.dispose() } }
    stores.set(panelId, entry)
  }
  return entry.store
}

/** Cancels the panel's running search and forgets its state. */
export function releasePanelSearchStore(panelId: string): void {
  stores.get(panelId)?.dispose()
  stores.delete(panelId)
}

export function capturePanelSearch(panelId: string): PanelSearchSnapshot | null {
  const entry = stores.get(panelId)
  if (!entry) return null
  return { rootPath: entry.rootPath, ...searchOptions(entry.store.getState()) }
}
