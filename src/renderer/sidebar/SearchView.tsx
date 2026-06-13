// =============================================================================
// SearchView — dedicated activity-bar view for project-wide content search,
// modelled on VS Code's Search view. Streams ripgrep results into searchStore.
// =============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { MagnifyingGlass, DotsThree, Gear, Eraser } from '@phosphor-icons/react'
import { SidebarSectionHeader, SidebarHeaderButton } from './SidebarSectionHeader'
import { SearchResultsTree } from './SearchResultsTree'
import { Tooltip } from '../ui/Tooltip'
import { useGitTree } from './useGitTree'
import { useSearchStore, lineKey } from '../stores/searchStore'
import { ensureSearchSubscriptions } from '../stores/searchIpc'
import log from '../lib/logger'

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
      className={`flex items-center justify-center w-5 h-5 rounded text-[11px] leading-none transition-colors ${
        active ? 'bg-accent text-white' : 'text-secondary hover:text-primary hover:bg-surface-5'
      }`}
    >
      {children}
    </button>
  </Tooltip>
)

export const SearchView: React.FC<{ rootPath: string; workspaceId?: string }> = ({ rootPath, workspaceId }) => {
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
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusToken])

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
      <SidebarSectionHeader
        title="Search"
        actions={
          <Tooltip label="Clear search">
            <SidebarHeaderButton
              aria-label="Clear search"
              onClick={clearSearch}
              disabled={!hasQuery && files.length === 0}
            >
              <Eraser size={15} />
            </SidebarHeaderButton>
          </Tooltip>
        }
      />

      {/* Query input + match-mode toggles */}
      <div className="px-2 py-1.5 border-b border-subtle flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <div className="flex-1 relative">
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
              className="w-full bg-surface-5 text-primary text-xs pl-7 pr-14 py-1 rounded border border-subtle focus:border-blue-500/50 outline-none"
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
          {/* VS Code-style "..." toggle that reveals the include/exclude details. */}
          <Tooltip label="Toggle Search Details">
            <button
              type="button"
              aria-label="Toggle search details"
              aria-pressed={optionsExpanded}
              onClick={toggleOptionsExpanded}
              className={`flex-shrink-0 flex items-center justify-center w-6 h-6 rounded transition-colors ${
                optionsExpanded ? 'bg-accent text-white' : 'text-secondary hover:text-primary hover:bg-surface-5'
              }`}
            >
              <DotsThree size={18} weight="bold" />
            </button>
          </Tooltip>
        </div>

        {/* Expandable include / exclude (VS Code-style) */}
        {optionsExpanded && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] text-muted">files to include</span>
              <input
                value={includes}
                aria-label="files to include"
                onChange={(e) => setOptions({ includes: e.target.value })}
                onFocus={() => setFocusedField('include')}
                onBlur={() => setFocusedField(null)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder={focusedField === 'include' ? 'e.g. src/**, *.ts' : ''}
                spellCheck={false}
                className="w-full bg-surface-5 text-primary text-[11px] px-2 py-1 rounded border border-subtle focus:border-blue-500/50 outline-none"
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] text-muted">files to exclude</span>
              <div className="relative">
                <input
                  value={excludes}
                  aria-label="files to exclude"
                  onChange={(e) => setOptions({ excludes: e.target.value })}
                  onFocus={() => setFocusedField('exclude')}
                  onBlur={() => setFocusedField(null)}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder={focusedField === 'exclude' ? 'e.g. *.lock, dist/**' : ''}
                  spellCheck={false}
                  className="w-full bg-surface-5 text-primary text-[11px] pl-2 pr-7 py-1 rounded border border-subtle focus:border-blue-500/50 outline-none"
                />
                <div className="absolute right-1 top-1/2 -translate-y-1/2">
                  <ToggleBtn
                    active={respectIgnore}
                    onClick={() => setOptions({ respectIgnore: !respectIgnore })}
                    title="Use Exclude Settings and Ignore Files"
                  >
                    <Gear size={13} />
                  </ToggleBtn>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Count / status line */}
      {hasQuery && (
        <div className="px-3 py-1 text-[11px] text-muted flex items-center gap-2 min-h-[22px]">
          {error ? (
            <span className="text-red-400 truncate" title={error}>{error}</span>
          ) : status === 'searching' && matchCount === 0 ? (
            <span>Searching…</span>
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
        <SearchResultsTree files={visibleFiles} git={gitTree} />
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
