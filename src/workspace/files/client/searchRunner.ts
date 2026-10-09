// Runs the content searches a search store asks for: debounced, one at a time
// per store, on the workspace's runtime. Results of a replaced or cancelled
// search are dropped by the store's search id check.

import { errorMessage } from '@kernel/interaction'
import type { SearchFileResult, SearchStats } from '../contract'
import { fsClient, type ContentSearch, type FsClient } from './fsClient'

const DEBOUNCE_MS = 250

/** The state of a search view the runner reads and moves. */
export interface SearchRunState {
  query: string
  isRegex: boolean
  matchCase: boolean
  wholeWord: boolean
  includes: string
  excludes: string
  respectIgnore: boolean
  status: 'idle' | 'searching' | 'done'
  currentSearchId: string | null
  lastQueryKey: string | null
  clearResults(): void
  beginSearch(searchId: string, queryKey?: string): void
  addBatch(searchId: string, files: SearchFileResult[]): void
  finishSearch(searchId: string, stats: SearchStats, error?: string): void
}

/** A store of that state (a view's store satisfies it). */
export interface SearchRunStore {
  getState(): SearchRunState
  setState(patch: Partial<SearchRunState>): void
  subscribe(listener: () => void): () => void
}

export interface SearchRunner<T extends SearchRunStore = SearchRunStore> {
  readonly store: T
  readonly rootPath: string
  dispose(): void
}

export interface SearchRunnerOptions {
  /** Defaults to the workspace's fs client. */
  fs?: () => Pick<FsClient, 'searchContent'>
}

const splitGlobs = (value: string): string[] => value.split(',').map((s) => s.trim()).filter(Boolean)

let nextId = 0
const newSearchId = (): string => `search-${Date.now().toString(36)}-${++nextId}`

/** Starts searching whenever the store's query or options change, until disposed. */
export function createSearchRunner<T extends SearchRunStore>(
  store: T,
  rootPath: string,
  workspaceId: string,
  options: SearchRunnerOptions = {},
): SearchRunner<T> {
  const fs = options.fs ?? (() => fsClient(workspaceId))
  let timer: ReturnType<typeof setTimeout> | undefined
  let key: string | undefined
  let running: { id: string; search: ContentSearch } | null = null
  let disposed = false

  const cancel = (): void => {
    const state = store.getState()
    if (running) {
      running.search.cancel()
      running = null
    }
    if (state.status !== 'searching' || !state.currentSearchId) return
    store.setState({ currentSearchId: null, lastQueryKey: null, status: 'idle' })
  }

  const update = (): void => {
    const state = store.getState()
    const query = state.query.trim()
    const nextKey = JSON.stringify([query, state.isRegex, state.matchCase, state.wholeWord, state.includes, state.excludes, state.respectIgnore, rootPath])
    if (nextKey === key) return
    key = nextKey
    clearTimeout(timer)
    cancel()
    if (!query || !rootPath) { state.clearResults(); return }
    if (nextKey === store.getState().lastQueryKey && store.getState().status === 'done') return
    timer = setTimeout(() => {
      if (disposed) return
      const searchId = newSearchId()
      store.getState().beginSearch(searchId, nextKey)
      const fail = (error: unknown) => {
        if (!disposed) store.getState().finishSearch(searchId, { files: 0, matches: 0, truncated: false }, errorMessage(error, 'Could not search files.'))
      }
      try {
        const search = fs().searchContent({
          query,
          isRegex: state.isRegex,
          matchCase: state.matchCase,
          wholeWord: state.wholeWord,
          includes: splitGlobs(state.includes),
          excludes: splitGlobs(state.excludes),
          respectIgnore: state.respectIgnore,
        }, (files) => store.getState().addBatch(searchId, files), rootPath)
        running = { id: searchId, search }
        search.done.then(
          (done) => {
            if (running?.id === searchId) running = null
            if (!disposed) store.getState().finishSearch(searchId, done.stats, done.error)
          },
          (error) => {
            if (running?.id === searchId) running = null
            // A cancelled search ends quietly; the store already moved on.
            if (store.getState().currentSearchId === searchId) fail(error)
          },
        )
      } catch (error) {
        fail(error)
      }
    }, DEBOUNCE_MS)
  }

  const unsubscribe = store.subscribe(update)
  update()

  return {
    store,
    rootPath,
    dispose() {
      if (disposed) return
      disposed = true
      clearTimeout(timer)
      unsubscribe()
      cancel()
    },
  }
}
