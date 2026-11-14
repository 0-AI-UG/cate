// Source control of one repository: changes (with staging, commit and stash)
// of a selected worktree, and branches, history and worktrees of the
// repository root. Status comes from the shared git status store.

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { GitBranch, Plus, Minus, ArrowUp, ArrowDown, Download, Trash, Archive, X, Check, GitCompareArrows as GitDiff } from 'lucide-react'
import { RotateCw as ArrowClockwise, ChevronDown as CaretDown, ChevronRight as CaretRight, SquareArrowOutUpRight as BoxArrowUp, History as ClockCounterClockwise } from 'lucide-react'
import { useRuntime } from '../../kernel/rpc'
import { Button, LoadingState, Spinner, Tooltip } from '../../kernel/interaction'
import { errorMessage } from '@kernel/interaction'
import { pathDisplayName } from '@workspace/files/contract'
import { GitComparisonView } from './GitComparisonView'
import { repositoryReadCacheFor } from './readCache'
import type { ReviewRequest } from '@workspace/repository/client'
import { deleteMergedBranches } from '@workspace/repository/client'
import { selectedWorktree, type GitBranchListResult, type GitComparisonSpec, type GitLogEntry, type GitStatusResult } from '@workspace/repository/contract'
import { useRepositoryUi } from './context'
import { useGitStatus } from './gitStatus'
import { useWorktrees, worktreeLabel } from './worktrees'

type GitFileStatus = GitStatusResult['files'][number]
type GitBranchInfo = GitBranchListResult['branches'][number]

// Commit drafts per checkout and the Changes worktree per repository are
// client view state; they outlive the view while the app runs.
const drafts = new Map<string, string>()
const changesWorktrees = new Map<string, string>()
const viewListeners = new Set<() => void>()
let viewVersion = 0
function setViewState(map: Map<string, string>, key: string, value: string): void {
  if (map.get(key) === value) return
  map.set(key, value)
  viewVersion++
  for (const l of [...viewListeners]) l()
}
const subscribeView = (l: () => void) => { viewListeners.add(l); return () => { viewListeners.delete(l) } }
function useViewState<T>(read: () => T): T {
  useSyncExternalStore(subscribeView, () => viewVersion)
  return read()
}

/** Test hook: seeds or clears the per-checkout view state. */
export function resetSourceControlViewState(seed: { drafts?: Record<string, string> } = {}): void {
  drafts.clear()
  changesWorktrees.clear()
  for (const [k, v] of Object.entries(seed.drafts ?? {})) drafts.set(k, v)
  viewVersion++
  for (const l of [...viewListeners]) l()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return date.toLocaleDateString()
}

// ---------------------------------------------------------------------------
// Collapsible Section
// ---------------------------------------------------------------------------

const Section: React.FC<{
  title: string
  count: number
  defaultOpen?: boolean
  actions?: React.ReactNode
  children: React.ReactNode
}> = ({ title, count, defaultOpen = true, actions, children }) => {
  const [open, setOpen] = useState(defaultOpen)

  if (count === 0) return null

  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-subtle">
      <div
        className="flex items-center gap-2 bg-surface-1 px-4 py-3 text-[13px] font-semibold text-primary cursor-pointer hover:bg-hover select-none"
        onClick={() => setOpen(!open)}
      >
        {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
        <span className="flex-1">{title}</span>
        <span className="min-w-6 rounded-full bg-surface-3 px-2 py-0.5 text-center text-[11px] font-medium text-secondary tabular-nums">{count}</span>
        {actions && (
          <div className="flex items-center gap-0.5 ml-1" onClick={(e) => e.stopPropagation()}>
            {actions}
          </div>
        )}
      </div>
      {open && <div className="divide-y divide-subtle border-t border-subtle">{children}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Branch Picker — inline expandable within the sidebar
// ---------------------------------------------------------------------------

const BranchPicker: React.FC<{
  workspaceId: string
  repositoryRoot: string
  checkoutRoot: string
  currentBranch: string | null
  onSwitch: () => void
  onReview: (branch: string) => void
}> = ({ workspaceId, repositoryRoot, checkoutRoot, currentBranch, onSwitch, onReview }) => {
  const runtime = useRuntime(workspaceId)
  const [isOpen, setIsOpen] = useState(true)
  const [branches, setBranches] = useState<GitBranchInfo[] | null>(null)
  const [filter, setFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const loadBranches = useCallback(async () => {
    if (!runtime) return
    try {
      const result = await runtime.vcs.branchList({ cwd: repositoryRoot })
      setBranches(result.branches)
    } catch (err) { setError(errorMessage(err, 'Could not load branches.')) }
  }, [runtime, repositoryRoot])

  useEffect(() => {
    if (isOpen) {
      loadBranches()
    } else {
      setFilter('')
      setCreating(false)
      setNewBranchName('')
      setError(null)
    }
  }, [isOpen, loadBranches])

  const handleCheckout = useCallback(async (name: string) => {
    setError(null)
    try {
      const branchName = name.replace(/^remotes\/origin\//, '')
      if (!runtime) return
      await runtime.vcs.checkout({ cwd: checkoutRoot, branch: branchName })
      setIsOpen(false)
      onSwitch()
    } catch (err: unknown) {
      setError(errorMessage(err, 'Checkout failed'))
    }
  }, [runtime, checkoutRoot, onSwitch])

  const handleCreate = useCallback(async () => {
    if (!newBranchName.trim()) return
    setError(null)
    try {
      // Creating a branch also checks it out, so it belongs to the selected
      // checkout even though the branch inventory itself is repository-wide.
      if (!runtime) return
      await runtime.vcs.branchCreate({ cwd: checkoutRoot, name: newBranchName.trim() })
      setIsOpen(false)
      onSwitch()
    } catch (err: unknown) {
      setError(errorMessage(err, 'Create failed'))
    }
  }, [runtime, checkoutRoot, newBranchName, onSwitch])

  const handleDelete = useCallback(async (name: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (name === currentBranch) return
    setError(null)
    try {
      if (!runtime) return
      await runtime.vcs.branchDelete({ cwd: repositoryRoot, name })
      loadBranches()
    } catch (err: unknown) {
      setError(errorMessage(err, 'Delete failed'))
    }
  }, [runtime, repositoryRoot, currentBranch, loadBranches])

  const localBranches = (branches ?? []).filter(b => !b.isRemote)
  const remoteBranches = (branches ?? []).filter(b => b.isRemote)

  const handleCleanup = useCallback(async () => {
    if (cleaning || !runtime) return
    setCleaning(true)
    try {
      const kept = await deleteMergedBranches(runtime, repositoryRoot, currentBranch ?? '', localBranches.map((branch) => branch.name))
      if (kept === null) return
      setError(null)
      await loadBranches()
      if (kept > 0) setError(`Kept ${kept} unmerged or in-use ${kept === 1 ? 'branch' : 'branches'}.`)
    } finally {
      setCleaning(false)
    }
  }, [runtime, cleaning, currentBranch, loadBranches, localBranches, repositoryRoot])

  const filtered = (list: GitBranchInfo[]) =>
    filter ? list.filter(b => b.name.toLowerCase().includes(filter.toLowerCase())) : list

  const branchCount = branches?.length

  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-subtle">
      {/* Section header — matches Section component style */}
      <div
        className="flex items-center gap-2 bg-surface-1 px-4 py-3 text-[13px] font-semibold text-primary cursor-pointer hover:bg-hover select-none"
        onClick={() => setIsOpen(!isOpen)}
      >
        {isOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
        <span className="flex-1">Branches</span>
        {branchCount !== undefined && <span className="min-w-6 rounded-full bg-surface-3 px-2 py-0.5 text-center text-[11px] font-medium text-secondary tabular-nums">{branchCount}</span>}
        {!isOpen && (
          <span className="text-muted font-normal text-[10px] truncate max-w-[80px]">{currentBranch}</span>
        )}
      </div>

      {isOpen && (
        <div>
          {/* Search / Create */}
          <div className="border-y border-subtle bg-surface-1/50 p-3">
            {creating ? (
              <div className="flex gap-1">
                <input
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false) }}
                  className="flex-1 min-w-0 bg-surface-2 border border-subtle rounded-lg px-2 py-1 text-[11px] text-primary placeholder:text-muted focus:outline-none focus:border-subtle"
                  placeholder="New branch name..."
                  autoFocus
                />
                <Tooltip label="Create branch">
                  <button onClick={handleCreate} aria-label="Create branch" className="p-0.5 rounded-lg hover:bg-hover text-green-400/70"><Check size={13} /></button>
                </Tooltip>
                <Tooltip label="Cancel">
                  <button onClick={() => setCreating(false)} aria-label="Cancel" className="p-0.5 rounded-lg hover:bg-hover text-muted"><X size={13} /></button>
                </Tooltip>
              </div>
            ) : (
              <div className="flex gap-1">
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="flex-1 min-w-0 bg-surface-2 border border-subtle rounded-lg px-2 py-1 text-[11px] text-primary placeholder:text-muted focus:outline-none focus:border-subtle"
                  placeholder="Filter branches..."
                />
                <Tooltip label="New branch">
                  <button
                    onClick={() => setCreating(true)}
                    className="p-0.5 rounded-lg hover:bg-hover text-muted hover:text-primary"
                    aria-label="New branch"
                  >
                    <Plus size={13} />
                  </button>
                </Tooltip>
                <Tooltip label="Delete merged local branches">
                  <button
                    onClick={() => void handleCleanup()}
                    disabled={cleaning || localBranches.every((branch) => branch.name === currentBranch)}
                    className="p-0.5 rounded-lg hover:bg-hover text-muted hover:text-red-400 disabled:opacity-40"
                    aria-label="Delete merged local branches"
                  >
                    {cleaning ? <Spinner size={13} /> : <Trash size={13} />}
                  </button>
                </Tooltip>
              </div>
            )}
          </div>

          {error && (
            <div className="px-2 py-1 text-[10px] text-red-400/80 bg-red-500/[0.1]">{error}</div>
          )}

          {/* Branch list */}
          {branches === null && !error && <LoadingState label="Loading branches" className="py-6 text-xs" />}
          {filtered(localBranches).map(b => {
            // git branch list is loaded from the canonical repository root, so
            // its `current` bit describes that checkout. The selected Changes
            // checkout has its own current branch from the status snapshot.
            const isSelectedCurrent = b.name === currentBranch
            return (
              <div
                key={b.name}
                className={`group flex items-center gap-2 border-b border-subtle last:border-b-0 px-4 py-3 cursor-pointer hover:bg-hover text-[13px] ${isSelectedCurrent ? 'text-primary' : 'text-secondary'}`}
                onClick={() => handleCheckout(b.name)}
              >
                <GitBranch size={11} className="flex-shrink-0" />
                <span className="truncate flex-1 min-w-0">{b.name}</span>
                {isSelectedCurrent && <span className="text-[9px] text-green-400/60 flex-shrink-0">current</span>}
                {!isSelectedCurrent && (
                  <div className="hidden group-hover:flex items-center">
                    <Tooltip label="Review branch against current">
                      <button className="p-0.5 rounded-lg hover:bg-hover text-muted hover:text-primary" onClick={(e) => { e.stopPropagation(); onReview(b.name) }} aria-label="Review branch"><GitDiff size={11} /></button>
                    </Tooltip>
                    <Tooltip label="Delete branch">
                      <button
                        className="p-0.5 rounded-lg hover:bg-hover text-muted hover:text-red-400 flex-shrink-0"
                        onClick={(e) => handleDelete(b.name, e)}
                        aria-label="Delete branch"
                      >
                        <Trash size={10} />
                      </button>
                    </Tooltip>
                  </div>
                )}
              </div>
            )
          })}
          {filtered(remoteBranches).length > 0 && (
            <>
              <div className="border-y border-subtle bg-surface-1 px-4 py-2 text-xs font-semibold text-secondary">Remote</div>
              {filtered(remoteBranches).map(b => (
                <div
                  key={b.name}
                  className="flex items-center gap-2 border-b border-subtle last:border-b-0 px-4 py-3 cursor-pointer hover:bg-hover text-[13px] text-secondary"
                  onClick={() => handleCheckout(b.name)}
                >
                  <GitBranch size={11} className="flex-shrink-0" />
                  <span className="truncate flex-1 min-w-0">{b.name.replace('remotes/', '')}</span>
                  <Tooltip label="Review branch against current">
                    <button className="p-0.5 rounded-lg hover:bg-hover text-muted hover:text-primary" onClick={(e) => { e.stopPropagation(); onReview(b.name) }} aria-label="Review branch"><GitDiff size={11} /></button>
                  </Tooltip>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Repository sections share the existing Git actions and status owner.
// Only Changes follows the selected worktree; other sections use the repo root.
// ---------------------------------------------------------------------------

export interface SourceControlViewProps {
  /** The repository: the workspace root or a repository nested in it. */
  rootPath: string
  onOpenFile?(): void
}

export const SourceControlView: React.FC<SourceControlViewProps> = ({ rootPath, onOpenFile }) => {
  const host = useRepositoryUi()
  const selectedWorkspaceId = host.workspaceId
  const runtime = useRuntime(selectedWorkspaceId)
  const [comparison, setComparison] = useState<ReviewRequest | null>(null)
  const [section, setSection] = useState<'changes' | 'branches' | 'history' | 'worktrees'>('changes')
  const repositorySnapshot = useGitStatus(selectedWorkspaceId, rootPath)
  // Status and worktrees come from the shared git status store, so this list
  // agrees with the Explorer and Search tints. Only the commit log is fetched
  // here.
  const worktrees = useWorktrees(rootPath)
  const selectedChangesWorktreeId = useViewState(() => changesWorktrees.get(rootPath))
  const setSourceControlWorktree = useCallback((repo: string, id: string) => setViewState(changesWorktrees, repo, id), [])
  const changesWorktree = selectedWorktree(worktrees, selectedChangesWorktreeId)
  const checkoutRoot = changesWorktree?.path ?? rootPath
  const snapshot = useGitStatus(selectedWorkspaceId, checkoutRoot)
  const status: GitStatusResult | null = snapshot.isRepo
    ? {
        files: snapshot.files,
        current: snapshot.branch,
        tracking: snapshot.tracking,
        ahead: snapshot.ahead,
        behind: snapshot.behind,
      }
    : null

  const cache = runtime ? repositoryReadCacheFor(runtime) : null
  const [logEntries, setLogEntries] = useState<GitLogEntry[] | null>(() => cache?.peek('log', { cwd: rootPath, maxCount: 30 }) ?? null)
  const commitMessage = useViewState(() => drafts.get(checkoutRoot) ?? '')
  const setCommitMessage = useCallback((draft: string) => {
    setViewState(drafts, checkoutRoot, draft)
  }, [checkoutRoot])
  const [loading, setLoading] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // -------------------------------------------------------------------------
  // Data fetching — kick the shared git store and refresh the local commit log.
  // The store's own loop already refreshes on fs-watch / focus / branch-update,
  // so this is for explicit user actions (the toolbar Refresh button + after a
  // git mutation below).
  // -------------------------------------------------------------------------

  const refresh = useCallback(async () => {
    if (!rootPath || !runtime) return
    setLoading(true)
    setActionError(null)
    try {
      // History follows the repository root; the Changes worktree is
      // independent. Status needs no refresh: the runtime pushes changes.
      const logResult = await repositoryReadCacheFor(runtime).read('log', { cwd: rootPath, maxCount: 30 })
      setLogEntries(logResult)
    } catch (err) {
      setActionError(errorMessage(err, 'Could not load commit history.'))
    } finally {
      setLoading(false)
    }
  }, [runtime, rootPath])

  useEffect(() => {
    refresh()
  }, [refresh])

  const openReview = useCallback((
    spec: GitComparisonSpec,
    focusedFile?: string,
    repoPath = checkoutRoot,
  ) => {
    setComparison({ repoPath, spec, focusedFile })
    setSection('changes')
  }, [checkoutRoot])

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const [staging, setStaging] = useState(false)
  const updateStaging = useCallback(async (files: GitFileStatus[], action: 'stage' | 'unstage') => {
    if (!runtime || staging) return
    setStaging(true)
    setActionError(null)
    try {
      for (const file of files) await runtime.vcs[action]({ cwd: checkoutRoot, path: file.path })
    } catch (err) {
      setActionError(errorMessage(err, 'Could not update staged files.'))
    } finally {
      setStaging(false)
    }
  }, [runtime, checkoutRoot, staging])

  const commit = useCallback(async () => {
    if (!commitMessage.trim() || committing) return
    setCommitting(true)
    setActionError(null)
    try {
      await runtime?.vcs.commit({ cwd: checkoutRoot, message: commitMessage.trim() })
      setCommitMessage('')
      refresh()
    } catch (err: unknown) {
      setActionError(errorMessage(err, 'Commit failed'))
    } finally {
      setCommitting(false)
    }
  }, [runtime, checkoutRoot, commitMessage, committing, refresh, setCommitMessage])

  const push = useCallback(async () => {
    if (pushing) return
    setPushing(true)
    setActionError(null)
    try {
      await runtime?.vcs.push({ cwd: checkoutRoot })
      refresh()
    } catch (err: unknown) {
      setActionError(errorMessage(err, 'Push failed'))
    } finally {
      setPushing(false)
    }
  }, [runtime, checkoutRoot, pushing, refresh])

  const pull = useCallback(async () => {
    if (pulling) return
    setPulling(true)
    setActionError(null)
    try {
      await runtime?.vcs.pull({ cwd: checkoutRoot })
      refresh()
    } catch (err: unknown) {
      setActionError(errorMessage(err, 'Pull failed'))
    } finally {
      setPulling(false)
    }
  }, [runtime, checkoutRoot, pulling, refresh])

  const fetch_ = useCallback(async () => {
    if (fetching) return
    setFetching(true)
    setActionError(null)
    try {
      await runtime?.vcs.fetch({ cwd: rootPath })
      refresh()
    } catch (err: unknown) {
      setActionError(errorMessage(err, 'Fetch failed'))
    } finally {
      setFetching(false)
    }
  }, [runtime, rootPath, fetching, refresh])

  const stash = useCallback(async () => {
    setActionError(null)
    try {
      await runtime?.vcs.stash({ cwd: checkoutRoot })
      refresh()
    } catch (err: unknown) {
      setActionError(errorMessage(err, 'Stash failed'))
    }
  }, [runtime, checkoutRoot, refresh])

  const stashPop = useCallback(async () => {
    setActionError(null)
    try {
      await runtime?.vcs.stashPop({ cwd: checkoutRoot })
      refresh()
    } catch (err: unknown) {
      setActionError(errorMessage(err, 'Stash pop failed'))
    }
  }, [runtime, checkoutRoot, refresh])

  // -------------------------------------------------------------------------
  // Categorize files
  // -------------------------------------------------------------------------

  const stagedFiles = status?.files.filter(
    (f) => f.index && f.index !== ' ' && f.index !== '?'
  ) ?? []

  const changedFiles = status?.files.filter(
    (f) => f.working_dir && f.working_dir !== ' ' && f.working_dir !== '?'
  ) ?? []

  const untrackedFiles = status?.files.filter(
    (f) => f.working_dir === '?'
  ) ?? []

  // -------------------------------------------------------------------------
  // Auto-resize textarea
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      // Floor at 72px (a comfortable multi-line box) and cap at 160 before the
      // hidden overflow kicks in.
      textareaRef.current.style.height = `${Math.min(Math.max(textareaRef.current.scrollHeight, 72), 160)}px`
    }
  }, [commitMessage])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!rootPath) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-xs p-4">
        No folder open
      </div>
    )
  }

  const repoName = pathDisplayName(rootPath)

  const branchSubtitle = (
    <span className="flex items-center gap-1.5">
      <GitBranch size={11} className="text-muted flex-shrink-0" />
      <span className="truncate">{status?.current ?? '...'}</span>
      {status && (status.ahead > 0 || status.behind > 0) && (
        <span className="text-muted text-[10px] flex-shrink-0 tabular-nums">
          {status.ahead > 0 && `↑${status.ahead}`}
          {status.behind > 0 && ` ↓${status.behind}`}
        </span>
      )}
    </span>
  )

  const liveWorktrees = worktrees.filter((worktree) => !worktree.isOrphan)
  const changesScope = liveWorktrees.length > 1 ? (
    <div role="group" aria-label={`Changes worktree for ${repoName}`} className="flex flex-wrap gap-1">
      {liveWorktrees.map((worktree) => <button key={worktree.id} aria-label={`Changes worktree: ${worktreeLabel(worktree)}`} aria-pressed={changesWorktree?.id === worktree.id}
        title={worktree.path} className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${changesWorktree?.id === worktree.id ? 'bg-surface-3 text-primary' : 'text-muted hover:bg-hover hover:text-primary'}`}
        onClick={() => { setSourceControlWorktree(rootPath, worktree.id); setComparison(null) }}><GitBranch size={12} />{worktreeLabel(worktree)}</button>)}
    </div>
  ) : branchSubtitle

  const headerActions = <Button variant="ghost" size="sm" onClick={refresh} loading={loading}>{!loading && <ArrowClockwise size={14} />}Refresh</Button>

  if (repositorySnapshot.loading || snapshot.loading) return <LoadingState label="Loading Git status" className="h-full text-xs" />
  if (repositorySnapshot.error || snapshot.error) return <p role="alert" className="p-4 text-xs text-muted">{repositorySnapshot.error || snapshot.error}</p>
  if (!snapshot.isRepo) return <p className="p-4 text-xs text-muted">This folder is not a Git repository.</p>

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden text-[12px]" style={{ containerType: 'inline-size', containerName: 'repository' }} data-worktree-room>
      <nav aria-label="Repository sections" className="mb-2 flex shrink-0 items-center gap-1 border-b border-subtle pb-3">
        {(['changes', 'branches', 'history', 'worktrees'] as const).map(value => <Button variant="ghost" key={value} size="sm" aria-pressed={section === value} className={section === value ? 'bg-surface-3 font-semibold text-primary' : 'text-secondary'} onClick={() => { setSection(value); setComparison(null) }}>{value === 'history' ? 'History' : value[0].toUpperCase() + value.slice(1)}</Button>)}
        <div className="ml-auto">{headerActions}</div>
      </nav>
      {section === 'changes' && (
        <div className="px-1 pb-2">
          <div className="flex flex-wrap items-center justify-between gap-3 py-2">
            <div className="flex items-center gap-3">{changesScope}<span className="text-muted">{status?.files.length ?? 0} {(status?.files.length ?? 0) === 1 ? 'file' : 'files'} changed</span></div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={fetch_} loading={fetching}>{!fetching && <Download size={14} />}Fetch</Button>
              <Button variant="ghost" size="sm" onClick={pull} loading={pulling}>{!pulling && <ArrowDown size={14} />}Pull</Button>
              <Button variant="ghost" size="sm" onClick={push} loading={pushing}>{!pushing && <ArrowUp size={14} />}Push{status?.ahead ? ` (${status.ahead})` : ''}</Button>
            </div>
          </div>
        </div>
      )}

      <>
      {/* Error banner */}
      {actionError && (
        <div className="flex items-center gap-1 px-2 py-1 bg-red-500/[0.1] text-red-400/80 text-[11px] flex-shrink-0">
          <span className="flex-1 truncate">{actionError}</span>
          <Tooltip label="Dismiss">
            <button onClick={() => setActionError(null)} aria-label="Dismiss" className="p-0.5 hover:bg-hover rounded-lg">
              <X size={12} />
            </button>
          </Tooltip>
        </div>
      )}

      <div className={section === 'changes' ? 'repository-changes-grid grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden pt-2 pb-4' : 'min-h-0 flex-1 overflow-y-auto pt-2 pb-6'}>
      {/* Commit area */}
      {section === 'changes' && (
      <div className="repository-commit order-2 self-start min-h-0 overflow-y-auto rounded-xl border border-subtle bg-surface-1 p-4">
        <h2 className="mb-1 text-sm font-semibold">Commit</h2>
        <p className="mb-4 text-xs text-muted">{stagedFiles.length} staged {stagedFiles.length === 1 ? 'file' : 'files'} · {status?.current ?? 'Detached HEAD'}</p>
        <div className="mb-3 flex flex-wrap gap-1">
          <Button variant="ghost" size="sm" disabled={staging || (!changedFiles.length && !untrackedFiles.length)} onClick={() => void updateStaging([...changedFiles, ...untrackedFiles], 'stage')}><Plus size={12} />Stage all</Button>
          <Button variant="ghost" size="sm" disabled={staging || !stagedFiles.length} onClick={() => void updateStaging(stagedFiles, 'unstage')}><Minus size={12} />Unstage all</Button>
        </div>
        <textarea
          ref={textareaRef}
          className="w-full bg-surface-2 border border-subtle rounded-lg px-2 py-1.5 text-[12px] text-primary placeholder:text-muted resize-none focus:outline-none focus:border-subtle min-h-[72px] no-scrollbar"
          aria-label="Commit message"
          placeholder="Describe what changed…"
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              commit()
            }
          }}
          rows={1}
        />
        <div className="flex gap-1 mt-1.5">
          <button
            className="flex-1 inline-flex items-center justify-center gap-1 py-1 rounded-lg text-[11px] font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed bg-surface-2 hover:bg-hover text-primary"
            disabled={!commitMessage.trim() || stagedFiles.length === 0 || committing}
            onClick={commit}
          >
            {committing && <Spinner size={12} />}
            {committing ? 'Committing' : 'Commit'}
          </button>
          <Tooltip label="Stash changes" placement="top">
            <button
              className="px-2 py-1 rounded-lg text-[11px] transition-colors bg-surface-2 hover:bg-hover text-secondary"
              onClick={stash}
              aria-label="Stash changes"
            >
              <Archive size={13} />
            </button>
          </Tooltip>
          <Tooltip label="Pop latest stash" placement="top">
            <button
              className="px-2 py-1 rounded-lg text-[11px] transition-colors bg-surface-2 hover:bg-hover text-secondary"
              onClick={stashPop}
              aria-label="Pop latest stash"
            >
              <BoxArrowUp size={13} />
            </button>
          </Tooltip>
        </div>
      </div>

      )}
      <div className="min-h-0 min-w-0">
        {section === 'changes' && <GitComparisonView onOpenFile={onOpenFile}
          key={comparison ? JSON.stringify(comparison) : checkoutRoot}
          workspaceId={selectedWorkspaceId}
          request={comparison ?? { repoPath: checkoutRoot, spec: { kind: 'uncommitted' } }}
          onBack={comparison ? () => setComparison(null) : undefined} />}
        {section === 'branches' && <>
        {/* Branches */}
        <BranchPicker
          workspaceId={selectedWorkspaceId}
          repositoryRoot={rootPath}
          checkoutRoot={rootPath}
          currentBranch={repositorySnapshot.branch ?? null}
          onSwitch={refresh}
          onReview={(base) => {
            const target = repositorySnapshot.branch
            if (target && target !== base) openReview({ kind: 'branch', base, target }, undefined, rootPath)
          }}
        />

        </>}
        {section === 'history' && <>
        {logEntries === null ? !actionError && <LoadingState label="Loading commits" className="p-6 text-xs" /> : !logEntries.length && <p className="p-6 text-sm text-muted">No commits to display.</p>}
        {/* Commit Log */}
        {logEntries !== null && <Section title="Commit history" count={logEntries.length}>
          {logEntries?.map((entry) => (
            <div
              key={entry.hash}
              className="flex items-start gap-3 px-4 py-3 hover:bg-hover text-xs cursor-pointer"
              onClick={() => openReview({ kind: 'commit', commit: entry.hash }, undefined, rootPath)}
            >
              <ClockCounterClockwise size={11} className="text-muted flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-primary truncate">{entry.message}</div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
                  <span className="font-mono">{entry.hash.slice(0, 7)}</span>
                  <span>{entry.author_name}</span>
                  <span>{relativeTime(entry.date)}</span>
                </div>
              </div>
            </div>
          ))}
        </Section>}

        </>}
        {section === 'worktrees' && <>
        {/* Worktrees — read-only mirror; manage from the canvas toolbar's
            parallel-worktrees drop-up. */}
        <Section
          title="Worktrees"
          count={worktrees.filter((wt) => !wt.isOrphan).length}
        >
          {worktrees.filter((wt) => !wt.isOrphan).map((wt) => (
            <button
              type="button"
              key={wt.path}
              className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-hover text-[13px] text-left ${
                wt.id === changesWorktree?.id ? 'text-primary bg-surface-3' : 'text-secondary'
              }`}
              title={wt.path}
              onClick={() => { setSourceControlWorktree(rootPath, wt.id); setSection('changes') }}
            >
              <GitBranch size={12} className="flex-shrink-0" />
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{wt.label || wt.branch || '(detached)'}</span><span className="mt-1 block truncate text-xs text-muted" title={wt.path}>{wt.path}</span></span>
              {wt.id === changesWorktree?.id && (
                <span className="text-[10px] text-green-400/60">changes</span>
              )}
              {wt.isPrimary && wt.id !== changesWorktree?.id && (
                <span className="text-[10px] text-muted">primary</span>
              )}
            </button>
          ))}
        </Section>

        </>}
      </div>
      </div>
      </>
    </div>
  )
}

