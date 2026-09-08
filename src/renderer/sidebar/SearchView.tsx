// =============================================================================
// SearchView — dedicated activity-bar view for project-wide content search,
// modelled on VS Code's Search view. Streams ripgrep results into searchStore.
// =============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Search as MagnifyingGlass, SlidersHorizontal, Eraser } from 'lucide-react'
import { SearchResultsTree } from './SearchResultsTree'
import { Tooltip } from '../ui/Tooltip'
import { useGitTree } from './useGitTree'
import { useSearchStore, lineKey } from '../stores/searchStore'
import { ensureSearchSubscriptions } from '../stores/searchIpc'
import log from '../lib/logger'
import { Spinner } from '../ui/Spinner'

const DEBOUNCE_MS = 250
let searchSeq = 0

/** Split a comma-separated glob field into trimmed, non-empty patterns. */
function splitGlobs(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

interface ToggleBtnProps {
  active: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}
const ToggleBtn: React.FC<ToggleBtnProps> = ({ active, onClick, title, children }) => (
  <Tooltip label={title}>
    <button
      type="button"
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={`flex items-center justify-center w-5 h-5 rounded-lg text-[11px] leading-none transition-colors ${
        active ? 'bg-accent text-white' : 'text-secondary hover:text-primary hover:bg-surface-5'
      }`}
    >
      {children}
    </button>
  </Tooltip>
)

export const SearchView: React.FC<{
  rootPath: string
  workspaceId?: string
  scopeControl?: React.ReactNode
  focusInput?: boolean
  onOpenMatch?: (path: string, line: number, column: number) => void
}> = ({ rootPath, workspaceId, scopeControl, onOpenMatch, focusInput = true }) => {
  const query = useSearchStore((s) => s.query)
  const isRegex = useSearchStore((s) => s.isRegex)
  const matchCase = useSearchStore((s) => s.matchCase)
  const wholeWord = useSearchStore((s) => s.wholeWord)
  const includes = useSearchStore((s) => s.includes)
  const excludes = useSearchStore((s) => s.excludes)
  const respectIgnore = useSearchStore((s) => s.respectIgnore)
  const optionsExpanded = useSearchStore((s) => s.optionsExpanded)

  const status = useSearchStore((s) => s.status)
  const files = useSearchStore((s) => s.files)
  const truncated = useSearchStore((s) => s.truncated)
  const error = useSearchStore((s) => s.error)
  const dismissedFiles = useSearchStore((s) => s.dismissedFiles)
  const dismissedLines = useSearchStore((s) => s.dismissedLines)
  const focusToken = useSearchStore((s) => s.focusToken)

  const setQuery = useSearchStore((s) => s.setQuery)
  const setOptions = useSearchStore((s) => s.setOptions)
  const toggleOptionsExpanded = useSearchStore((s) => s.toggleOptionsExpanded)

  const inputRef = useRef<HTMLInputElement>(null)
  // Placeholders show only while a field is focused (hidden at rest).
  const [focusedField, setFocusedField] = useState<'query' | 'include' | 'exclude' | null>(null)
  // Git decorations so result file rows tint like the Explorer.
  const gitTree = useGitTree(rootPath)

  // Ensure window-level result subscriptions exist (idempotent; persists across
  // mount/unmount so batches arriving while the view is hidden aren't lost).
  useEffect(() => {
    ensureSearchSubscriptions()
  }, [])

  // Focus the input when something requests it (e.g. Cmd+Shift+F).
  useEffect(() => {
    if (!focusInput) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusToken, focusInput])

  // Debounced search trigger. The searchId is set in the store BEFORE invoking
  // so streamed batches are never dropped as "stale". Skips re-running an
  // identical search (same query + options + root) — e.g. when this view is
  // remounted after switching sidebar tabs — since results persist in the store.
  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed || !rootPath) {
      useSearchStore.getState().clearResults()
      window.electronAPI.searchCancel().catch(() => { /* noop */ })
      return
    }
    const key = JSON.stringify([
      trimmed, isRegex, matchCase, wholeWord, includes, excludes, respectIgnore, rootPath,
    ])
    if (key === useSearchStore.getState().lastQueryKey) return
    const handle = window.setTimeout(() => {
      const searchId = `search-${++searchSeq}`
      useSearchStore.getState().beginSearch(searchId, key)
      window.electronAPI
        .searchStart(rootPath, searchId, {
          query: trimmed,
          isRegex,
          matchCase,
          wholeWord,
          includes: splitGlobs(includes),
          excludes: splitGlobs(excludes),
          respectIgnore,
        }, workspaceId)
        .catch((err) => log.warn('[search] start failed:', err))
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [query, isRegex, matchCase, wholeWord, includes, excludes, respectIgnore, rootPath, workspaceId])

  // Visible files + accurate counts (excluding dismissed files / lines).
  const { visibleFiles, matchCount, fileCount } = useMemo(() => {
    const vf = files.filter((f) => !dismissedFiles.has(f.path))
    let matches = 0
    let fileCnt = 0
    for (const f of vf) {
      let fileMatches = 0
      for (const ln of f.lines) {
        if (dismissedLines.has(lineKey(f.path, ln.line))) continue
        fileMatches += ln.ranges.length
      }
      if (fileMatches > 0) {
        matches += fileMatches
        fileCnt += 1
      }
    }
    return { visibleFiles: vf, matchCount: matches, fileCount: fileCnt }
  }, [files, dismissedFiles, dismissedLines])

  const hasQuery = query.trim().length > 0

  // Reset the search: clear the query, results, and any in-flight run.
  const clearSearch = (): void => {
    setQuery('')
    useSearchStore.getState().clearResults()
    window.electronAPI.searchCancel().catch(() => { /* noop */ })
    inputRef.current?.focus()
  }

  return (
    <div className="flex flex-col h-full">
      {scopeControl && <div className="px-2 pt-1.5">{scopeControl}</div>}

      {/* Query input + match-mode toggles */}
      <div className="px-2 py-1.5 flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <div className="flex-1 min-w-0 relative">
            <MagnifyingGlass size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-secondary" />
            <input
              ref={inputRef}
              value={query}
              aria-label="Search"
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setFocusedField('query')}
              onBlur={() => setFocusedField(null)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('')
                e.stopPropagation()
              }}
              placeholder={focusedField === 'query' ? 'Search' : ''}
              spellCheck={false}
              className="w-full bg-surface-2 text-primary text-xs pl-7 pr-[70px] h-7 rounded-lg border border-subtle focus:border-focus outline-none"
            />
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
              <ToggleBtn active={matchCase} onClick={() => setOptions({ matchCase: !matchCase })} title="Match Case">
                Aa
              </ToggleBtn>
              <ToggleBtn active={wholeWord} onClick={() => setOptions({ wholeWord: !wholeWord })} title="Match Whole Word">
                <span className="underline">ab</span>
              </ToggleBtn>
              <ToggleBtn active={isRegex} onClick={() => setOptions({ isRegex: !isRegex })} title="Use Regular Expression">
                .*
              </ToggleBtn>
            </div>
          </div>
          {(hasQuery || files.length > 0) && <Tooltip label="Clear search">
            <button type="button" aria-label="Clear search" onClick={clearSearch} className="flex shrink-0 items-center justify-center w-6 h-6 rounded-md text-secondary hover:text-primary hover:bg-hover">
              <Eraser size={14} />
            </button>
          </Tooltip>}
          <Tooltip label="Toggle Search Details">
            <button
              type="button"
              aria-label="Toggle search details"
              aria-expanded={optionsExpanded}
              onClick={toggleOptionsExpanded}
              className={`flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-lg transition-colors ${
                optionsExpanded ? 'bg-surface-3 text-primary' : 'text-secondary hover:text-primary hover:bg-surface-5'
              }`}
            >
              <SlidersHorizontal size={14} />
            </button>
          </Tooltip>
        </div>

        {optionsExpanded && (
          <div className="flex flex-col gap-1.5">
            <label className="block">
              <input
                value={includes}
                aria-label="files to include"
                onChange={(e) => setOptions({ includes: e.target.value })}
                onKeyDown={(e) => e.stopPropagation()}
                onFocus={() => setFocusedField('include')}
                onBlur={() => setFocusedField(null)}
                placeholder={focusedField === 'include' ? 'src/**, *.ts' : 'Include'}
                spellCheck={false}
                className="min-w-0 w-full h-6 bg-surface-2 text-primary text-[11px] px-2 rounded-md border border-subtle focus:border-focus outline-none"
              />
            </label>
            <label className="block">
              <input
                value={excludes}
                aria-label="files to exclude"
                onChange={(e) => setOptions({ excludes: e.target.value })}
                onKeyDown={(e) => e.stopPropagation()}
                onFocus={() => setFocusedField('exclude')}
                onBlur={() => setFocusedField(null)}
                placeholder={focusedField === 'exclude' ? '*.lock, dist/**' : 'Exclude'}
                spellCheck={false}
                className="min-w-0 w-full h-6 bg-surface-2 text-primary text-[11px] px-2 rounded-md border border-subtle focus:border-focus outline-none"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-secondary cursor-pointer">
              <input type="checkbox" checked={respectIgnore} onChange={(e) => setOptions({ respectIgnore: e.target.checked })} className="m-0 h-3 w-3 accent-[var(--focus-blue)]" />
              Use ignore files
            </label>
          </div>
        )}
      </div>

      {/* Count / status line */}
      {hasQuery && (
        <div className="px-3 py-1 text-[11px] text-muted flex items-center gap-2 min-h-[22px]">
          {error ? (
            <span className="text-red-400 truncate" title={error}>{error}</span>
          ) : status === 'searching' && matchCount === 0 ? (
            <span className="flex items-center gap-1.5"><Spinner size={11} />Searching…</span>
          ) : matchCount === 0 ? (
            <span>No results</span>
          ) : (
            <span>
              {matchCount} {matchCount === 1 ? 'result' : 'results'} in {fileCount}{' '}
              {fileCount === 1 ? 'file' : 'files'}
              {truncated && ' (truncated)'}
            </span>
          )}
        </div>
      )}

      {/* Results */}
      {hasQuery && !error && visibleFiles.length > 0 ? (
        <SearchResultsTree files={visibleFiles} git={gitTree} onOpenMatch={onOpenMatch} />
      ) : !hasQuery ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted px-4 text-center">
          Search across files in this folder.
        </div>
      ) : (
        <div className="flex-1" />
      )}
    </div>
  )
}
