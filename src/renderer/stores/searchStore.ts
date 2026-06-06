// =============================================================================
// searchStore — state for the VS Code-style Search view.
//
// Holds the query + match options, streamed results (grouped by file), and
// transient UI state (collapsed/dismissed groups, a focus token). Results
// outlive the SearchView component so switching sidebar views keeps them.
// =============================================================================

import { create } from 'zustand'
import type { SearchFileResult } from '../../shared/types'
import { errorMessage } from '../lib/errorMessage'

export type SearchStatus = 'idle' | 'searching' | 'done'

export interface SearchStats {
  matches: number
  files: number
  truncated: boolean
}

export interface SearchState {
  // Query + options
  query: string
  isRegex: boolean
  matchCase: boolean
  wholeWord: boolean
  includes: string
  excludes: string
  respectIgnore: boolean
  optionsExpanded: boolean

  // Results
  status: SearchStatus
  files: SearchFileResult[]
  truncated: boolean
  error: string | null
  currentSearchId: string | null
  /** Signature of the most recently launched search (query + options + root).
   *  Lets the view skip re-running an identical search on remount. */
  lastQueryKey: string | null

  // Transient UI
  collapsed: Set<string>
  dismissedFiles: Set<string>
  dismissedLines: Set<string>
  focusToken: number

  // Actions
  setQuery: (q: string) => void
  setOptions: (patch: Partial<SearchOptionFields>) => void
  toggleOptionsExpanded: () => void
  beginSearch: (searchId: string, queryKey?: string) => void
  addBatch: (searchId: string, files: SearchFileResult[]) => void
  finishSearch: (searchId: string, stats: SearchStats, error?: string) => void
  clearResults: () => void
  toggleCollapse: (path: string) => void
  dismissFile: (path: string) => void
  dismissLine: (path: string, line: number) => void
  requestFocus: () => void
}

export type SearchOptionFields = Pick<
  SearchState,
  'isRegex' | 'matchCase' | 'wholeWord' | 'includes' | 'excludes' | 'respectIgnore'
>

/** Key for an individual dismissed match line. */
export const lineKey = (path: string, line: number): string => `${path}:${line}`

/**
 * Merge a streamed batch into the existing file list. ripgrep emits each file
 * once per search, so this is normally an append; we dedupe by path defensively
 * (first occurrence wins).
 */
export function mergeFiles(
  existing: SearchFileResult[],
  incoming: SearchFileResult[],
): SearchFileResult[] {
  if (incoming.length === 0) return existing
  const seen = new Set(existing.map((f) => f.path))
  const merged = existing.slice()
  for (const f of incoming) {
    if (!seen.has(f.path)) {
      seen.add(f.path)
      merged.push(f)
    }
  }
  return merged
}

export const createSearchStore = () =>
  create<SearchState>((set, get) => ({
    query: '',
    isRegex: false,
    matchCase: false,
    wholeWord: false,
    includes: '',
    excludes: '',
    respectIgnore: true,
    optionsExpanded: false,

    status: 'idle',
    files: [],
    truncated: false,
    error: null,
    currentSearchId: null,
    lastQueryKey: null,

    collapsed: new Set(),
    dismissedFiles: new Set(),
    dismissedLines: new Set(),
    focusToken: 0,

    setQuery: (q) => set({ query: q }),

    setOptions: (patch) => set(patch),

    toggleOptionsExpanded: () => set((s) => ({ optionsExpanded: !s.optionsExpanded })),

    beginSearch: (searchId, queryKey) =>
      set({
        currentSearchId: searchId,
        lastQueryKey: queryKey ?? null,
        status: 'searching',
        files: [],
        truncated: false,
        error: null,
        collapsed: new Set(),
        dismissedFiles: new Set(),
        dismissedLines: new Set(),
      }),

    addBatch: (searchId, files) => {
      if (searchId !== get().currentSearchId) return // stale
      set((s) => ({ files: mergeFiles(s.files, files) }))
    },

    finishSearch: (searchId, stats, error) => {
      if (searchId !== get().currentSearchId) return // stale
      set({ status: 'done', truncated: stats.truncated, error: error ? errorMessage(error) : null })
    },

    clearResults: () =>
      set({
        status: 'idle',
        files: [],
        truncated: false,
        error: null,
        currentSearchId: null,
        lastQueryKey: null,
        collapsed: new Set(),
        dismissedFiles: new Set(),
        dismissedLines: new Set(),
      }),

    toggleCollapse: (path) =>
      set((s) => {
        const next = new Set(s.collapsed)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return { collapsed: next }
      }),

    dismissFile: (path) =>
      set((s) => {
        const next = new Set(s.dismissedFiles)
        next.add(path)
        return { dismissedFiles: next }
      }),

    dismissLine: (path, line) =>
      set((s) => {
        const next = new Set(s.dismissedLines)
        next.add(lineKey(path, line))
        return { dismissedLines: next }
      }),

    requestFocus: () => set((s) => ({ focusToken: s.focusToken + 1 })),
  }))

export const useSearchStore = createSearchStore()
