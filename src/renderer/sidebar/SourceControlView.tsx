import React, { useCallback, useEffect, useRef, useState } from 'react'
import log from '../lib/logger'
import {
  GitBranch,
  ArrowClockwise,
  CaretDown,
  CaretRight,
  Plus,
  Minus,
  ArrowUp,
  ArrowDown,
  Download,
  Trash,
  ArrowUUpLeft,
  Archive,
  BoxArrowUp,
  ClockCounterClockwise,
  X,
  Check,
  GitDiff,
  FileMagnifyingGlass,
} from '@phosphor-icons/react'
import { useAppStore } from '../stores/appStore'
import { SidebarSectionHeader, SidebarHeaderButton } from './SidebarSectionHeader'
import { pathDisplayName } from '../lib/fs/displayPath'
import { Tooltip } from '../ui/Tooltip'
import { Spinner } from '../ui/Spinner'
import { useGitStatusSnapshot, gitStatusStore, workspaceIdForRoot } from '../stores/gitStatusStore'
import { useWorktrees } from '../stores/useWorktrees'
import { errorMessage } from '../lib/errorMessage'
import { parseLocator, formatLocator } from '../../shared/runtimeLocator'
import { openReviewPanel } from '../lib/review/openReviewPanel'
import type { GitComparisonSpec } from '../../shared/types'
import { useUIStore } from '../stores/uiStore'
import { selectedWorktree } from '../lib/worktreeContext'
import { WorktreeScopeSelect } from './WorktreeScopeSelect'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GitFileStatus {
  path: string
  index: string
  working_dir: string
}

interface GitStatusResult {
  files: GitFileStatus[]
  current: string | null
  tracking: string | null
  ahead: number
  behind: number
}

interface GitBranchInfo {
  name: string
  current: boolean
  commit: string
  label: string
  isRemote: boolean
}

interface GitLogEntry {
  hash: string
  message: string
  author_name: string
  author_email: string
  date: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileName(path: string): string {
  return pathDisplayName(path) || path
}

function dirName(path: string): string {
  const parts = path.split('/')
  parts.pop()
  return parts.join('/')
}

/** Last path segment of a rootPath, for the nested-mode section header.
 *  rootPath may be a locator (`cate-runtime://<id>/<path>`) for a remote
 *  workspace, so decode it before taking the basename. */
function repoDisplayName(rootPath: string): string {
  let p = rootPath
  try { p = parseLocator(rootPath).path } catch { /* already a plain path */ }
  const segs = p.split(/[/\\]/).filter(Boolean)
  return segs[segs.length - 1] || p
}

function statusColor(status: string): string {
  switch (status) {
    case 'M': return 'text-yellow-400'
    case 'A': return 'text-green-400'
    case 'D': return 'text-red-400'
    case 'R': return 'text-blue-400'
    case '?': return 'text-muted'
    case 'U': return 'text-orange-400'
    default: return 'text-muted'
  }
}

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
    <div className="mb-1">
      <div
        className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-muted cursor-pointer hover:bg-hover select-none"
        onClick={() => setOpen(!open)}
      >
        {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
        <span className="flex-1">{title}</span>
        <span className="text-muted font-normal normal-case">{count}</span>
        {actions && (
          <div className="flex items-center gap-0.5 ml-1" onClick={(e) => e.stopPropagation()}>
            {actions}
          </div>
        )}
      </div>
      {open && <div>{children}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// File Entry
// ---------------------------------------------------------------------------

const FileEntry: React.FC<{
  file: GitFileStatus
  statusChar: string
  onStage?: () => void
  onUnstage?: () => void
  onDiscard?: () => void
  onClick?: () => void
  onStandaloneDiff?: () => void
}> = ({ file, statusChar, onStage, onUnstage, onDiscard, onClick, onStandaloneDiff }) => {
  const dir = dirName(file.path)
  return (
    <div
      className="group flex items-center gap-1 mx-1.5 my-0.5 rounded-lg px-3 py-[3px] text-[12px] cursor-pointer hover:bg-hover"
      onClick={onClick}
    >
      <span className={`w-4 text-center font-mono text-[11px] flex-shrink-0 ${statusColor(statusChar)}`}>
        {statusChar}
      </span>
      <span className="truncate text-primary flex-1 min-w-0">
        {fileName(file.path)}
        {dir && <span className="text-muted ml-1">{dir}</span>}
      </span>
      <div className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
        {onStandaloneDiff && (
          <Tooltip label="Open standalone diff">
            <button
              className="p-0.5 rounded-lg hover:bg-hover text-muted hover:text-primary"
              onClick={(e) => { e.stopPropagation(); onStandaloneDiff() }}
              aria-label="Open standalone diff"
            >
              <FileMagnifyingGlass size={13} />
            </button>
          </Tooltip>
        )}
        {onDiscard && (
          <Tooltip label="Discard changes">
            <button
              className="p-0.5 rounded-lg hover:bg-hover text-muted hover:text-red-400"
              onClick={(e) => { e.stopPropagation(); onDiscard() }}
              aria-label="Discard changes"
            >
              <ArrowUUpLeft size={13} />
            </button>
          </Tooltip>
        )}
        {onStage && (
          <Tooltip label="Stage file">
            <button
              className="p-0.5 rounded-lg hover:bg-hover text-muted hover:text-primary"
              onClick={(e) => { e.stopPropagation(); onStage() }}
              aria-label="Stage file"
            >
              <Plus size={13} />
            </button>
          </Tooltip>
        )}
        {onUnstage && (
          <Tooltip label="Unstage file">
            <button
              className="p-0.5 rounded-lg hover:bg-hover text-muted hover:text-primary"
              onClick={(e) => { e.stopPropagation(); onUnstage() }}
              aria-label="Unstage file"
            >
              <Minus size={13} />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Branch Picker — inline expandable within the sidebar
// ---------------------------------------------------------------------------

const BranchPicker: React.FC<{
  repositoryRoot: string
  checkoutRoot: string
  currentBranch: string | null
  onSwitch: () => void
  onReview: (branch: string) => void
}> = ({ repositoryRoot, checkoutRoot, currentBranch, onSwitch, onReview }) => {
  const [isOpen, setIsOpen] = useState(false)
  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [filter, setFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const loadBranches = useCallback(async () => {
    try {
      const result = await window.electronAPI.gitBranchList(repositoryRoot, workspaceIdForRoot(repositoryRoot))
      setBranches(result.branches)
    } catch { /* ignore */ }
  }, [repositoryRoot])

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
      await window.electronAPI.gitCheckout(checkoutRoot, branchName, workspaceIdForRoot(checkoutRoot))
      setIsOpen(false)
      onSwitch()
    } catch (err: any) {
      setError(errorMessage(err, 'Checkout failed'))
    }
  }, [checkoutRoot, onSwitch])

  const handleCreate = useCallback(async () => {
    if (!newBranchName.trim()) return
    setError(null)
    try {
      // Creating a branch also checks it out, so it belongs to the selected
      // checkout even though the branch inventory itself is repository-wide.
      await window.electronAPI.gitBranchCreate(checkoutRoot, newBranchName.trim(), undefined, workspaceIdForRoot(checkoutRoot))
      setIsOpen(false)
      onSwitch()
    } catch (err: any) {
      setError(errorMessage(err, 'Create failed'))
    }
  }, [checkoutRoot, newBranchName, onSwitch])

  const handleDelete = useCallback(async (name: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (name === currentBranch) return
    setError(null)
    try {
      await window.electronAPI.gitBranchDelete(repositoryRoot, name, undefined, workspaceIdForRoot(repositoryRoot))
      loadBranches()
    } catch (err: any) {
      setError(errorMessage(err, 'Delete failed'))
    }
  }, [repositoryRoot, currentBranch, loadBranches])

  const localBranches = branches.filter(b => !b.isRemote)
  const remoteBranches = branches.filter(b => b.isRemote)

  const filtered = (list: GitBranchInfo[]) =>
    filter ? list.filter(b => b.name.toLowerCase().includes(filter.toLowerCase())) : list

  const branchCount = branches.length || 1 // at least show current

  return (
    <div className="mb-1">
      {/* Section header — matches Section component style */}
      <div
        className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-muted cursor-pointer hover:bg-hover select-none"
        onClick={() => setIsOpen(!isOpen)}
      >
        {isOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
        <span className="flex-1">Branches</span>
        <span className="text-muted font-normal normal-case">{branchCount}</span>
        {!isOpen && (
          <span className="text-muted font-normal text-[10px] truncate max-w-[80px]">{currentBranch}</span>
        )}
      </div>

      {isOpen && (
        <div>
          {/* Search / Create */}
          <div className="px-2 py-1">
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
              </div>
            )}
          </div>

          {error && (
            <div className="px-2 py-1 text-[10px] text-red-400/80 bg-red-500/[0.1]">{error}</div>
          )}

          {/* Branch list */}
          {filtered(localBranches).map(b => {
            // git branch list is loaded from the canonical repository root, so
            // its `current` bit describes that checkout. The selected Changes
            // checkout has its own current branch from the status snapshot.
            const isSelectedCurrent = b.name === currentBranch
            return (
              <div
                key={b.name}
                className={`group flex items-center gap-1 mx-1.5 my-0.5 rounded-lg px-3 py-[3px] cursor-pointer hover:bg-hover text-[12px] ${isSelectedCurrent ? 'text-primary' : 'text-secondary'}`}
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
              <div className="px-3 py-0.5 text-[10px] text-muted uppercase mt-1">Remote</div>
              {filtered(remoteBranches).map(b => (
                <div
                  key={b.name}
                  className="flex items-center gap-1 mx-1.5 my-0.5 rounded-lg px-3 py-[3px] cursor-pointer hover:bg-hover text-[12px] text-muted"
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
// RepoSourceControl — the full single-repo view (staged/changes/branches/log/
// worktrees + commit box). Rendered standalone when the workspace root is
// itself a repo, or once per discovered repo (nested) in a multi-repo
// workspace. `nested` swaps the "Source Control" panel header for a
// collapsible section headed by the repo's folder name.
// ---------------------------------------------------------------------------

interface RepoSourceControlProps {
  rootPath: string
  nested?: boolean
}

const RepoSourceControl: React.FC<RepoSourceControlProps> = ({ rootPath, nested = false }) => {
  const [sectionOpen, setSectionOpen] = useState(true)
  // status + worktrees come from the single per-workspace gitStatusStore (the
  // shared fsWatch + focus + branch-update loop). The Source Control list can
  // therefore no longer disagree with the Explorer / Search git tints. Only the
  // commit log is still fetched locally (it isn't part of the shared snapshot).
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const worktrees = useWorktrees(rootPath, selectedWorkspaceId)
  const selectedChangesWorktreeId = useUIStore(
    (s) => s.sourceControlWorktreeByRepository[rootPath],
  )
  const setSourceControlWorktree = useUIStore((s) => s.setSourceControlWorktree)
  const changesWorktree = selectedWorktree(worktrees, selectedChangesWorktreeId)
  const checkoutRoot = changesWorktree?.path ?? rootPath
  const snapshot = useGitStatusSnapshot(checkoutRoot)
  const status: GitStatusResult | null = snapshot.isRepo
    ? {
        files: snapshot.statusFiles,
        current: snapshot.branch,
        tracking: null,
        ahead: snapshot.ahead,
        behind: snapshot.behind,
      }
    : null

  const [logEntries, setLogEntries] = useState<GitLogEntry[]>([])
  const [commitMessage, setCommitMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const createDiffEditor = useAppStore((s) => s.createDiffEditor)

  // -------------------------------------------------------------------------
  // Data fetching — kick the shared git store and refresh the local commit log.
  // The store's own loop already refreshes on fs-watch / focus / branch-update,
  // so this is for explicit user actions (the toolbar Refresh button + after a
  // git mutation below).
  // -------------------------------------------------------------------------

  const refresh = useCallback(async () => {
    if (!rootPath) return
    setLoading(true)
    setActionError(null)
    gitStatusStore.refresh(checkoutRoot)
    try {
      // History follows the selected checkout's current branch. Branch and
      // worktree inventories below remain repository-wide.
      const logResult = await window.electronAPI.gitLog(checkoutRoot, 30, workspaceIdForRoot(checkoutRoot))
      setLogEntries(logResult)
    } catch (err) {
      log.error('Git log error:', err)
    } finally {
      setLoading(false)
    }
  }, [rootPath, checkoutRoot])

  useEffect(() => {
    refresh()
  }, [refresh])

  // -------------------------------------------------------------------------
  // Open diff on canvas
  // -------------------------------------------------------------------------

  const openFileDiff = useCallback((filePath: string, staged: boolean) => {
    // filePath is git-relative (POSIX). Join onto the DECODED host root and
    // re-encode through formatLocator — concatenating onto the raw locator
    // string corrupts remote filenames whose bytes collide with the percent
    // encoding. For local roots formatLocator returns the bare path unchanged.
    const { runtimeId, path: root } = parseLocator(checkoutRoot)
    const hostPath = filePath.startsWith('/')
      ? filePath
      : `${root.replace(/\/+$/, '')}/${filePath}`
    createDiffEditor(selectedWorkspaceId, formatLocator({ runtimeId, path: hostPath }), staged ? 'staged' : 'working')
  }, [checkoutRoot, selectedWorkspaceId, createDiffEditor])

  const openReview = useCallback((
    spec: GitComparisonSpec,
    focusedFile?: string,
    openNew = false,
  ) => {
    if (!selectedWorkspaceId) return
    void openReviewPanel({ workspaceId: selectedWorkspaceId, repoPath: checkoutRoot, spec, focusedFile, openNew })
  }, [checkoutRoot, selectedWorkspaceId])

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const stageFile = useCallback(async (filePath: string) => {
    await window.electronAPI.gitStage(checkoutRoot, filePath, workspaceIdForRoot(checkoutRoot))
    refresh()
  }, [checkoutRoot, refresh])

  const unstageFile = useCallback(async (filePath: string) => {
    await window.electronAPI.gitUnstage(checkoutRoot, filePath, workspaceIdForRoot(checkoutRoot))
    refresh()
  }, [checkoutRoot, refresh])

  const discardFile = useCallback(async (filePath: string) => {
    try {
      await window.electronAPI.gitDiscardFile(checkoutRoot, filePath, workspaceIdForRoot(checkoutRoot))
      refresh()
    } catch (err: any) {
      setActionError(errorMessage(err, 'Discard failed'))
    }
  }, [checkoutRoot, refresh])

  const stageAll = useCallback(async (files: GitFileStatus[]) => {
    for (const f of files) {
      await window.electronAPI.gitStage(checkoutRoot, f.path, workspaceIdForRoot(checkoutRoot))
    }
    refresh()
  }, [checkoutRoot, refresh])

  const unstageAll = useCallback(async (files: GitFileStatus[]) => {
    for (const f of files) {
      await window.electronAPI.gitUnstage(checkoutRoot, f.path, workspaceIdForRoot(checkoutRoot))
    }
    refresh()
  }, [checkoutRoot, refresh])

  const commit = useCallback(async () => {
    if (!commitMessage.trim() || committing) return
    setCommitting(true)
    setActionError(null)
    try {
      await window.electronAPI.gitCommit(checkoutRoot, commitMessage.trim(), workspaceIdForRoot(checkoutRoot))
      setCommitMessage('')
      refresh()
    } catch (err: any) {
      setActionError(errorMessage(err, 'Commit failed'))
    } finally {
      setCommitting(false)
    }
  }, [checkoutRoot, commitMessage, committing, refresh])

  const push = useCallback(async () => {
    if (pushing) return
    setPushing(true)
    setActionError(null)
    try {
      await window.electronAPI.gitPush(checkoutRoot, undefined, undefined, workspaceIdForRoot(checkoutRoot))
      refresh()
    } catch (err: any) {
      setActionError(errorMessage(err, 'Push failed'))
    } finally {
      setPushing(false)
    }
  }, [checkoutRoot, pushing, refresh])

  const pull = useCallback(async () => {
    if (pulling) return
    setPulling(true)
    setActionError(null)
    try {
      await window.electronAPI.gitPull(checkoutRoot, undefined, undefined, workspaceIdForRoot(checkoutRoot))
      refresh()
    } catch (err: any) {
      setActionError(errorMessage(err, 'Pull failed'))
    } finally {
      setPulling(false)
    }
  }, [checkoutRoot, pulling, refresh])

  const fetch_ = useCallback(async () => {
    if (fetching) return
    setFetching(true)
    setActionError(null)
    try {
      await window.electronAPI.gitFetch(rootPath, undefined, workspaceIdForRoot(rootPath))
      refresh()
    } catch (err: any) {
      setActionError(errorMessage(err, 'Fetch failed'))
    } finally {
      setFetching(false)
    }
  }, [rootPath, fetching, refresh])

  const stash = useCallback(async () => {
    setActionError(null)
    try {
      await window.electronAPI.gitStash(checkoutRoot, undefined, workspaceIdForRoot(checkoutRoot))
      refresh()
    } catch (err: any) {
      setActionError(errorMessage(err, 'Stash failed'))
    }
  }, [checkoutRoot, refresh])

  const stashPop = useCallback(async () => {
    setActionError(null)
    try {
      await window.electronAPI.gitStashPop(checkoutRoot, workspaceIdForRoot(checkoutRoot))
      refresh()
    } catch (err: any) {
      setActionError(errorMessage(err, 'Stash pop failed'))
    }
  }, [checkoutRoot, refresh])

  // -------------------------------------------------------------------------
  // Categorize files
  // -------------------------------------------------------------------------

  const stagedFiles = status?.files.filter(
    (f) => f.index && f.index !== ' ' && f.index !== '?'
  ) ?? []

  const changedFiles = status?.files.filter(
    (f) => f.working_dir && f.working_dir !== ' ' && f.working_dir !== '?' && (f.index === ' ' || f.index === '?' || !f.index)
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

  const repoName = repoDisplayName(rootPath)

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

  const hasMultipleWorktrees = worktrees.filter((worktree) => !worktree.isOrphan).length > 1
  const changesScope = hasMultipleWorktrees ? (
    <WorktreeScopeSelect
      worktrees={worktrees}
      value={changesWorktree?.id}
      onChange={(id) => setSourceControlWorktree(rootPath, id)}
      prefix="Changes in"
      title={`Changes worktree for ${repoName}`}
    />
  ) : null

  const headerActions = (
    <>
      <SidebarHeaderButton onClick={() => openReview({ kind: 'uncommitted' })} title="Review all uncommitted changes">
        <GitDiff size={12} />
      </SidebarHeaderButton>
      <SidebarHeaderButton onClick={() => openReview({ kind: 'uncommitted' }, undefined, true)} title="Open new diff review">
        <Plus size={12} />
      </SidebarHeaderButton>
      <SidebarHeaderButton onClick={fetch_} title="Fetch from remote" disabled={fetching} spinning={fetching}>
        <Download size={12} />
      </SidebarHeaderButton>
      <SidebarHeaderButton onClick={pull} title="Pull from remote" disabled={pulling} spinning={pulling}>
        <ArrowDown size={12} />
      </SidebarHeaderButton>
      <SidebarHeaderButton onClick={push} title="Push to remote" disabled={pushing} spinning={pushing}>
        <ArrowUp size={12} />
      </SidebarHeaderButton>
      <SidebarHeaderButton onClick={refresh} title="Refresh status" spinning={loading}>
        <ArrowClockwise size={12} />
      </SidebarHeaderButton>
    </>
  )

  // In nested (multi-repo) mode the whole repo body collapses under a header
  // labelled with the repo's folder name; standalone keeps the full panel.
  const bodyVisible = !nested || sectionOpen

  return (
    <div className={nested ? 'flex flex-col text-[12px]' : 'flex flex-col h-full overflow-hidden text-[12px]'}>
      {nested ? (
        <div
          className="flex items-center gap-1 mx-1.5 my-0.5 rounded-lg px-2 py-1 text-[11px] font-medium text-muted cursor-pointer hover:bg-hover select-none"
          onClick={() => setSectionOpen((v) => !v)}
        >
          {sectionOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
          <span className="truncate text-secondary flex-shrink-0 max-w-[45%]">{repoName}</span>
          <span className="flex-1 min-w-0 font-normal normal-case">{branchSubtitle}</span>
          <div className="flex items-center gap-0.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
            {headerActions}
          </div>
        </div>
      ) : (
        <SidebarSectionHeader
          title="Source Control"
          subtitle={changesScope ? repoName : branchSubtitle}
          actions={headerActions}
        />
      )}

      {bodyVisible && changesScope && (
        <div className="px-3 py-1 border-b border-subtle">
          {changesScope}
        </div>
      )}

      {bodyVisible && (
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

      {/* Commit area */}
      <div className="px-2 pt-2 pb-2 flex-shrink-0">
        <textarea
          ref={textareaRef}
          className="w-full bg-surface-2 border border-subtle rounded-lg px-2 py-1.5 text-[12px] text-primary placeholder:text-muted resize-none focus:outline-none focus:border-subtle min-h-[72px] no-scrollbar"
          placeholder="Commit message"
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
            {committing ? 'Committing…' : 'Commit'}
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

      {/* File sections — the standalone panel scrolls here; nested repos flow
          into the wrapper's shared scroll container instead. */}
      <div className={nested ? '' : 'flex-1 min-h-0 overflow-y-auto'}>
        {/* Staged Changes */}
        <Section
          title="Staged Changes"
          count={stagedFiles.length}
          actions={
            <>
              <Tooltip label="Review staged changes">
                <button className="p-0.5 rounded-lg hover:bg-hover text-muted hover:text-primary" onClick={() => openReview({ kind: 'staged' })} aria-label="Review staged changes"><GitDiff size={13} /></button>
              </Tooltip>
              <Tooltip label="Unstage all">
                <button
                  className="p-0.5 rounded-lg hover:bg-hover text-muted hover:text-primary"
                  onClick={() => unstageAll(stagedFiles)}
                  aria-label="Unstage all"
                >
                  <Minus size={13} />
                </button>
              </Tooltip>
            </>
          }
        >
          {stagedFiles.map((f) => (
            <FileEntry
              key={`staged-${f.path}`}
              file={f}
              statusChar={f.index}
              onUnstage={() => unstageFile(f.path)}
              onClick={() => openReview({ kind: 'staged' }, f.path)}
              onStandaloneDiff={() => openFileDiff(f.path, true)}
            />
          ))}
        </Section>

        {/* Changes */}
        <Section
          title="Changes"
          count={changedFiles.length}
          actions={
            <>
              <Tooltip label="Review unstaged changes">
                <button className="p-0.5 rounded-lg hover:bg-hover text-muted hover:text-primary" onClick={() => openReview({ kind: 'unstaged' })} aria-label="Review unstaged changes"><GitDiff size={13} /></button>
              </Tooltip>
              <Tooltip label="Stage all">
                <button
                  className="p-0.5 rounded-lg hover:bg-hover text-muted hover:text-primary"
                  onClick={() => stageAll(changedFiles)}
                  aria-label="Stage all"
                >
                  <Plus size={13} />
                </button>
              </Tooltip>
            </>
          }
        >
          {changedFiles.map((f) => (
            <FileEntry
              key={`changed-${f.path}`}
              file={f}
              statusChar={f.working_dir}
              onStage={() => stageFile(f.path)}
              onDiscard={() => discardFile(f.path)}
              onClick={() => openReview({ kind: 'unstaged' }, f.path)}
              onStandaloneDiff={() => openFileDiff(f.path, false)}
            />
          ))}
        </Section>

        {/* Untracked */}
        <Section
          title="Untracked"
          count={untrackedFiles.length}
          defaultOpen={false}
          actions={
            <Tooltip label="Stage all">
              <button
                className="p-0.5 rounded-lg hover:bg-hover text-muted hover:text-primary"
                onClick={() => stageAll(untrackedFiles)}
                aria-label="Stage all"
              >
                <Plus size={13} />
              </button>
            </Tooltip>
          }
        >
          {untrackedFiles.map((f) => (
            <FileEntry
              key={`untracked-${f.path}`}
              file={f}
              statusChar="?"
              onStage={() => stageFile(f.path)}
              onClick={() => openReview({ kind: 'unstaged' }, f.path)}
              onStandaloneDiff={() => openFileDiff(f.path, false)}
            />
          ))}
        </Section>

        {/* Branches */}
        <BranchPicker
          repositoryRoot={rootPath}
          checkoutRoot={checkoutRoot}
          currentBranch={status?.current ?? null}
          onSwitch={refresh}
          onReview={(base) => {
            const target = status?.current
            if (target && target !== base) openReview({ kind: 'branch', base, target })
          }}
        />

        {/* Commit Log */}
        <Section title="Commit Log" count={logEntries.length} defaultOpen={false}>
          {logEntries.map((entry) => (
            <div
              key={entry.hash}
              className="flex items-start gap-1.5 mx-1.5 my-0.5 rounded-lg px-3 py-[4px] hover:bg-hover text-[11px] cursor-pointer"
              onClick={() => openReview({ kind: 'commit', commit: entry.hash })}
            >
              <ClockCounterClockwise size={11} className="text-muted flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-primary truncate">{entry.message}</div>
                <div className="flex items-center gap-1.5 text-muted">
                  <span className="font-mono">{entry.hash.slice(0, 7)}</span>
                  <span>{entry.author_name}</span>
                  <span>{relativeTime(entry.date)}</span>
                </div>
              </div>
            </div>
          ))}
        </Section>

        {/* Worktrees — read-only mirror; manage from the canvas toolbar's
            parallel-worktrees drop-up. */}
        <Section
          title="Worktrees"
          count={worktrees.filter((wt) => !wt.isOrphan).length}
          defaultOpen={false}
        >
          {worktrees.filter((wt) => !wt.isOrphan).map((wt) => (
            <button
              type="button"
              key={wt.path}
              className={`w-[calc(100%-0.75rem)] flex items-center gap-1.5 mx-1.5 my-0.5 rounded-lg px-3 py-[3px] hover:bg-hover text-left ${
                wt.id === changesWorktree?.id ? 'text-primary bg-surface-3' : 'text-secondary'
              }`}
              title={`${wt.path}\nSelect this checkout for Changes. Manage worktrees in Parallel Work.`}
              onClick={() => setSourceControlWorktree(rootPath, wt.id)}
            >
              <GitBranch size={12} className="flex-shrink-0" />
              <span className="truncate flex-1">{wt.label || wt.branch || '(detached)'}</span>
              {wt.id === changesWorktree?.id && (
                <span className="text-[10px] text-green-400/60">changes</span>
              )}
              {wt.isPrimary && wt.id !== changesWorktree?.id && (
                <span className="text-[10px] text-muted">primary</span>
              )}
            </button>
          ))}
        </Section>

        {/* Empty state */}
        {status && stagedFiles.length === 0 && changedFiles.length === 0 && untrackedFiles.length === 0 && (
          <div className="flex items-center justify-center py-8 text-muted text-[11px]">
            No changes detected
          </div>
        )}
      </div>
      </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SourceControlView — public entry. Discovers the git repos in the workspace
// and renders the single-repo view directly when the root itself is a repo (or
// exactly one repo lives under it, or none is found), or a stacked, collapsible
// section per repo when the root is a multi-repo parent folder (issue #400).
// ---------------------------------------------------------------------------

interface SourceControlViewProps {
  rootPath: string
}

export const SourceControlView: React.FC<SourceControlViewProps> = ({ rootPath }) => {
  // null = discovery hasn't resolved yet; render the single view meanwhile so
  // the common (root-is-a-repo) case never flashes an intermediate layout.
  const [repos, setRepos] = useState<string[] | null>(null)

  useEffect(() => {
    if (!rootPath) {
      setRepos(null)
      return
    }
    let cancelled = false
    const discover = (): void => {
      window.electronAPI
        .gitFindRepos(rootPath, undefined, workspaceIdForRoot(rootPath))
        .then((found) => { if (!cancelled) setRepos(found) })
        .catch(() => { if (!cancelled) setRepos([]) })
    }
    discover()
    // Re-scan on focus so a repo created/removed in a subfolder while the app
    // was backgrounded appears without reopening the workspace. The scan is a
    // cheap depth-1 directory read.
    window.addEventListener('focus', discover)
    return () => {
      cancelled = true
      window.removeEventListener('focus', discover)
    }
  }, [rootPath])

  if (!rootPath) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-xs p-4">
        No folder open
      </div>
    )
  }

  // Single-repo — the common case: root is the repo, one repo sits below it, or
  // nothing was discovered (yet / at all). Render the full panel as before,
  // targeting the discovered repo when it differs from the workspace root.
  if (repos === null || repos.length <= 1) {
    return <RepoSourceControl rootPath={repos && repos.length === 1 ? repos[0] : rootPath} />
  }

  // Multi-repo parent folder: one collapsible section per repo.
  return (
    <div className="flex flex-col h-full overflow-hidden text-[12px]">
      <SidebarSectionHeader
        title="Source Control"
        subtitle={<span className="text-muted">{repos.length} repositories</span>}
      />
      <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-subtle">
        {repos.map((repo) => (
          <RepoSourceControl key={repo} rootPath={repo} nested />
        ))}
      </div>
    </div>
  )
}
