import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  GitBranch,
  RotateCw,
  ChevronDown,
  ChevronRight,
  Plus,
  Minus,
  ArrowUp,
  ArrowDown,
  Download,
  Trash2,
  Undo2,
  Archive,
  ArchiveRestore,
  History,
  X,
  Check,
} from 'lucide-react'
import { useAppStore } from '../stores/appStore'

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

interface Worktree {
  path: string
  branch: string
  isBare: boolean
  isCurrent: boolean
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
  return path.split('/').pop() || path
}

function dirName(path: string): string {
  const parts = path.split('/')
  parts.pop()
  return parts.join('/')
}

function statusColor(status: string): string {
  switch (status) {
    case 'M': return 'text-yellow-400'
    case 'A': return 'text-green-400'
    case 'D': return 'text-red-400'
    case 'R': return 'text-blue-400'
    case '?': return 'text-white/40'
    case 'U': return 'text-orange-400'
    default: return 'text-white/40'
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
        className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-white/40 cursor-pointer hover:bg-white/5 select-none"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="flex-1">{title}</span>
        <span className="text-white/30 font-normal normal-case">{count}</span>
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
}> = ({ file, statusChar, onStage, onUnstage, onDiscard, onClick }) => {
  const dir = dirName(file.path)
  return (
    <div
      className="group flex items-center gap-1 px-3 py-[3px] text-[12px] cursor-pointer hover:bg-white/5"
      onClick={onClick}
    >
      <span className={`w-4 text-center font-mono text-[11px] flex-shrink-0 ${statusColor(statusChar)}`}>
        {statusChar}
      </span>
      <span className="truncate text-white/80 flex-1 min-w-0">
        {fileName(file.path)}
        {dir && <span className="text-white/30 ml-1">{dir}</span>}
      </span>
      <div className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
        {onDiscard && (
          <button
            className="p-0.5 rounded hover:bg-white/10 text-white/40 hover:text-red-400"
            onClick={(e) => { e.stopPropagation(); onDiscard() }}
            title="Discard Changes"
          >
            <Undo2 size={13} />
          </button>
        )}
        {onStage && (
          <button
            className="p-0.5 rounded hover:bg-white/10 text-white/40 hover:text-white/70"
            onClick={(e) => { e.stopPropagation(); onStage() }}
            title="Stage"
          >
            <Plus size={13} />
          </button>
        )}
        {onUnstage && (
          <button
            className="p-0.5 rounded hover:bg-white/10 text-white/40 hover:text-white/70"
            onClick={(e) => { e.stopPropagation(); onUnstage() }}
            title="Unstage"
          >
            <Minus size={13} />
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Branch Picker — inline expandable within the sidebar
// ---------------------------------------------------------------------------

const BranchPicker: React.FC<{
  rootPath: string
  currentBranch: string | null
  onSwitch: () => void
}> = ({ rootPath, currentBranch, onSwitch }) => {
  const [isOpen, setIsOpen] = useState(false)
  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [filter, setFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const loadBranches = useCallback(async () => {
    try {
      const result = await window.electronAPI.gitBranchList(rootPath)
      setBranches(result.branches)
    } catch { /* ignore */ }
  }, [rootPath])

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
      await window.electronAPI.gitCheckout(rootPath, branchName)
      setIsOpen(false)
      onSwitch()
    } catch (err: any) {
      setError(err?.message || 'Checkout failed')
    }
  }, [rootPath, onSwitch])

  const handleCreate = useCallback(async () => {
    if (!newBranchName.trim()) return
    setError(null)
    try {
      await window.electronAPI.gitBranchCreate(rootPath, newBranchName.trim())
      setIsOpen(false)
      onSwitch()
    } catch (err: any) {
      setError(err?.message || 'Create failed')
    }
  }, [rootPath, newBranchName, onSwitch])

  const handleDelete = useCallback(async (name: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (name === currentBranch) return
    setError(null)
    try {
      await window.electronAPI.gitBranchDelete(rootPath, name)
      loadBranches()
    } catch (err: any) {
      setError(err?.message || 'Delete failed')
    }
  }, [rootPath, currentBranch, loadBranches])

  const localBranches = branches.filter(b => !b.isRemote)
  const remoteBranches = branches.filter(b => b.isRemote)

  const filtered = (list: GitBranchInfo[]) =>
    filter ? list.filter(b => b.name.toLowerCase().includes(filter.toLowerCase())) : list

  const branchCount = branches.length || 1 // at least show current

  return (
    <div className="mb-1">
      {/* Section header — matches Section component style */}
      <div
        className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-white/40 cursor-pointer hover:bg-white/5 select-none"
        onClick={() => setIsOpen(!isOpen)}
      >
        {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="flex-1">Branches</span>
        <span className="text-white/30 font-normal normal-case">{branchCount}</span>
        {!isOpen && (
          <span className="text-white/30 font-normal text-[10px] truncate max-w-[80px]">{currentBranch}</span>
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
                  className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded px-2 py-1 text-[11px] text-white/80 placeholder-white/25 focus:outline-none focus:border-white/20"
                  placeholder="New branch name..."
                  autoFocus
                />
                <button onClick={handleCreate} className="p-0.5 rounded hover:bg-white/10 text-green-400/70"><Check size={13} /></button>
                <button onClick={() => setCreating(false)} className="p-0.5 rounded hover:bg-white/10 text-white/40"><X size={13} /></button>
              </div>
            ) : (
              <div className="flex gap-1">
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded px-2 py-1 text-[11px] text-white/80 placeholder-white/25 focus:outline-none focus:border-white/20"
                  placeholder="Filter branches..."
                />
                <button
                  onClick={() => setCreating(true)}
                  className="p-0.5 rounded hover:bg-white/10 text-white/40 hover:text-white/70"
                  title="Create branch"
                >
                  <Plus size={13} />
                </button>
              </div>
            )}
          </div>

          {error && (
            <div className="px-2 py-1 text-[10px] text-red-400/80 bg-red-500/[0.1]">{error}</div>
          )}

          {/* Branch list */}
          {filtered(localBranches).map(b => (
            <div
              key={b.name}
              className={`group flex items-center gap-1 px-3 py-[3px] cursor-pointer hover:bg-white/5 text-[12px] ${b.current ? 'text-white/90' : 'text-white/60'}`}
              onClick={() => handleCheckout(b.name)}
            >
              <GitBranch size={11} className="flex-shrink-0" />
              <span className="truncate flex-1 min-w-0">{b.name}</span>
              {b.current && <span className="text-[9px] text-green-400/60 flex-shrink-0">current</span>}
              {!b.current && (
                <button
                  className="hidden group-hover:block p-0.5 rounded hover:bg-white/10 text-white/30 hover:text-red-400 flex-shrink-0"
                  onClick={(e) => handleDelete(b.name, e)}
                  title="Delete branch"
                >
                  <Trash2 size={10} />
                </button>
              )}
            </div>
          ))}
          {filtered(remoteBranches).length > 0 && (
            <>
              <div className="px-3 py-0.5 text-[10px] text-white/25 uppercase mt-1">Remote</div>
              {filtered(remoteBranches).map(b => (
                <div
                  key={b.name}
                  className="flex items-center gap-1 px-3 py-[3px] cursor-pointer hover:bg-white/5 text-[12px] text-white/40"
                  onClick={() => handleCheckout(b.name)}
                >
                  <GitBranch size={11} className="flex-shrink-0" />
                  <span className="truncate flex-1 min-w-0">{b.name.replace('remotes/', '')}</span>
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
// SourceControlView
// ---------------------------------------------------------------------------

interface SourceControlViewProps {
  rootPath: string
}

export const SourceControlView: React.FC<SourceControlViewProps> = ({ rootPath }) => {
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
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
  const setWorkspaceRootPath = useAppStore((s) => s.setWorkspaceRootPath)
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------

  const refresh = useCallback(async () => {
    if (!rootPath) return
    setLoading(true)
    setActionError(null)
    try {
      const [statusResult, worktreeResult, logResult] = await Promise.all([
        window.electronAPI.gitStatus(rootPath),
        window.electronAPI.gitWorktreeList(rootPath),
        window.electronAPI.gitLog(rootPath, 30),
      ])
      setStatus(statusResult as GitStatusResult)
      setWorktrees(worktreeResult as Worktree[])
      setLogEntries(logResult)
    } catch (err) {
      console.error('Git status error:', err)
    } finally {
      setLoading(false)
    }
  }, [rootPath])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Refresh on window focus
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [refresh])

  // Listen for branch updates
  useEffect(() => {
    const cleanup = window.electronAPI.onGitBranchUpdate(() => {
      refresh()
    })
    return cleanup
  }, [refresh])

  // -------------------------------------------------------------------------
  // Open diff on canvas
  // -------------------------------------------------------------------------

  const openFileDiff = useCallback((filePath: string, staged: boolean) => {
    const fullPath = filePath.startsWith('/') ? filePath : `${rootPath}/${filePath}`
    createDiffEditor(selectedWorkspaceId, fullPath, staged ? 'staged' : 'working')
  }, [rootPath, selectedWorkspaceId, createDiffEditor])

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const stageFile = useCallback(async (filePath: string) => {
    await window.electronAPI.gitStage(rootPath, filePath)
    refresh()
  }, [rootPath, refresh])

  const unstageFile = useCallback(async (filePath: string) => {
    await window.electronAPI.gitUnstage(rootPath, filePath)
    refresh()
  }, [rootPath, refresh])

  const discardFile = useCallback(async (filePath: string) => {
    try {
      await window.electronAPI.gitDiscardFile(rootPath, filePath)
      refresh()
    } catch (err: any) {
      setActionError(err?.message || 'Discard failed')
    }
  }, [rootPath, refresh])

  const stageAll = useCallback(async (files: GitFileStatus[]) => {
    for (const f of files) {
      await window.electronAPI.gitStage(rootPath, f.path)
    }
    refresh()
  }, [rootPath, refresh])

  const unstageAll = useCallback(async (files: GitFileStatus[]) => {
    for (const f of files) {
      await window.electronAPI.gitUnstage(rootPath, f.path)
    }
    refresh()
  }, [rootPath, refresh])

  const commit = useCallback(async () => {
    if (!commitMessage.trim() || committing) return
    setCommitting(true)
    setActionError(null)
    try {
      await window.electronAPI.gitCommit(rootPath, commitMessage.trim())
      setCommitMessage('')
      refresh()
    } catch (err: any) {
      setActionError(err?.message || 'Commit failed')
    } finally {
      setCommitting(false)
    }
  }, [rootPath, commitMessage, committing, refresh])

  const push = useCallback(async () => {
    if (pushing) return
    setPushing(true)
    setActionError(null)
    try {
      await window.electronAPI.gitPush(rootPath)
      refresh()
    } catch (err: any) {
      setActionError(err?.message || 'Push failed')
    } finally {
      setPushing(false)
    }
  }, [rootPath, pushing, refresh])

  const pull = useCallback(async () => {
    if (pulling) return
    setPulling(true)
    setActionError(null)
    try {
      await window.electronAPI.gitPull(rootPath)
      refresh()
    } catch (err: any) {
      setActionError(err?.message || 'Pull failed')
    } finally {
      setPulling(false)
    }
  }, [rootPath, pulling, refresh])

  const fetch_ = useCallback(async () => {
    if (fetching) return
    setFetching(true)
    setActionError(null)
    try {
      await window.electronAPI.gitFetch(rootPath)
      refresh()
    } catch (err: any) {
      setActionError(err?.message || 'Fetch failed')
    } finally {
      setFetching(false)
    }
  }, [rootPath, fetching, refresh])

  const stash = useCallback(async () => {
    setActionError(null)
    try {
      await window.electronAPI.gitStash(rootPath)
      refresh()
    } catch (err: any) {
      setActionError(err?.message || 'Stash failed')
    }
  }, [rootPath, refresh])

  const stashPop = useCallback(async () => {
    setActionError(null)
    try {
      await window.electronAPI.gitStashPop(rootPath)
      refresh()
    } catch (err: any) {
      setActionError(err?.message || 'Stash pop failed')
    }
  }, [rootPath, refresh])

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
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`
    }
  }, [commitMessage])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!rootPath) {
    return (
      <div className="flex items-center justify-center h-full text-white/30 text-xs p-4">
        No folder open
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden text-[12px]">
      {/* Branch + actions */}
      <div className="flex items-center gap-1 px-2 py-1.5 flex-shrink-0">
        <GitBranch size={13} className="text-white/40 flex-shrink-0" />
        <span className="truncate text-[12px] text-white/40 flex-1 min-w-0">
          {status?.current ?? '...'}
        </span>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="text-white/30 text-[10px] flex-shrink-0 mr-1">
            {status.ahead > 0 && `↑${status.ahead}`}
            {status.behind > 0 && ` ↓${status.behind}`}
          </span>
        )}
        <button
          className={`p-1 rounded hover:bg-white/10 text-white/30 hover:text-white/60 transition-colors flex-shrink-0 ${fetching ? 'animate-spin' : ''}`}
          onClick={fetch_}
          title="Fetch"
          disabled={fetching}
        >
          <Download size={13} strokeWidth={1.5} />
        </button>
        <button
          className={`p-1 rounded hover:bg-white/10 text-white/30 hover:text-white/60 transition-colors flex-shrink-0 ${pulling ? 'animate-pulse' : ''}`}
          onClick={pull}
          title="Pull"
          disabled={pulling}
        >
          <ArrowDown size={13} strokeWidth={1.5} />
        </button>
        <button
          className={`p-1 rounded hover:bg-white/10 text-white/30 hover:text-white/60 transition-colors flex-shrink-0 ${pushing ? 'animate-pulse' : ''}`}
          onClick={push}
          title="Push"
          disabled={pushing}
        >
          <ArrowUp size={13} strokeWidth={1.5} />
        </button>
        <button
          className={`p-1 rounded hover:bg-white/10 text-white/30 hover:text-white/60 transition-colors flex-shrink-0 ${loading ? 'animate-spin' : ''}`}
          onClick={refresh}
          title="Refresh"
        >
          <RotateCw size={13} strokeWidth={1.5} />
        </button>
      </div>

      {/* Error banner */}
      {actionError && (
        <div className="flex items-center gap-1 px-2 py-1 bg-red-500/[0.1] text-red-400/80 text-[11px] flex-shrink-0">
          <span className="flex-1 truncate">{actionError}</span>
          <button onClick={() => setActionError(null)} className="p-0.5 hover:bg-white/10 rounded">
            <X size={12} />
          </button>
        </div>
      )}

      {/* Commit area */}
      <div className="px-2 pb-2 flex-shrink-0">
        <textarea
          ref={textareaRef}
          className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-[12px] text-white/80 placeholder-white/25 resize-none focus:outline-none focus:border-white/20"
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
            className="flex-1 py-1 rounded text-[11px] font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed bg-white/10 hover:bg-white/15 text-white/80"
            disabled={!commitMessage.trim() || stagedFiles.length === 0 || committing}
            onClick={commit}
          >
            {committing ? 'Committing...' : 'Commit'}
          </button>
          <button
            className="px-2 py-1 rounded text-[11px] transition-colors bg-white/5 hover:bg-white/10 text-white/50"
            onClick={stash}
            title="Stash"
          >
            <Archive size={13} />
          </button>
          <button
            className="px-2 py-1 rounded text-[11px] transition-colors bg-white/5 hover:bg-white/10 text-white/50"
            onClick={stashPop}
            title="Stash Pop"
          >
            <ArchiveRestore size={13} />
          </button>
        </div>
      </div>

      {/* Scrollable file sections */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Staged Changes */}
        <Section
          title="Staged Changes"
          count={stagedFiles.length}
          actions={
            <button
              className="p-0.5 rounded hover:bg-white/10 text-white/40 hover:text-white/70"
              onClick={() => unstageAll(stagedFiles)}
              title="Unstage All"
            >
              <Minus size={13} />
            </button>
          }
        >
          {stagedFiles.map((f) => (
            <FileEntry
              key={`staged-${f.path}`}
              file={f}
              statusChar={f.index}
              onUnstage={() => unstageFile(f.path)}
              onClick={() => openFileDiff(f.path, true)}
            />
          ))}
        </Section>

        {/* Changes */}
        <Section
          title="Changes"
          count={changedFiles.length}
          actions={
            <button
              className="p-0.5 rounded hover:bg-white/10 text-white/40 hover:text-white/70"
              onClick={() => stageAll(changedFiles)}
              title="Stage All"
            >
              <Plus size={13} />
            </button>
          }
        >
          {changedFiles.map((f) => (
            <FileEntry
              key={`changed-${f.path}`}
              file={f}
              statusChar={f.working_dir}
              onStage={() => stageFile(f.path)}
              onDiscard={() => discardFile(f.path)}
              onClick={() => openFileDiff(f.path, false)}
            />
          ))}
        </Section>

        {/* Untracked */}
        <Section
          title="Untracked"
          count={untrackedFiles.length}
          defaultOpen={false}
          actions={
            <button
              className="p-0.5 rounded hover:bg-white/10 text-white/40 hover:text-white/70"
              onClick={() => stageAll(untrackedFiles)}
              title="Stage All"
            >
              <Plus size={13} />
            </button>
          }
        >
          {untrackedFiles.map((f) => (
            <FileEntry
              key={`untracked-${f.path}`}
              file={f}
              statusChar="?"
              onStage={() => stageFile(f.path)}
              onClick={() => openFileDiff(f.path, false)}
            />
          ))}
        </Section>

        {/* Branches */}
        <BranchPicker
          rootPath={rootPath}
          currentBranch={status?.current ?? null}
          onSwitch={refresh}
        />

        {/* Commit Log */}
        <Section title="Commit Log" count={logEntries.length} defaultOpen={false}>
          {logEntries.map((entry) => (
            <div
              key={entry.hash}
              className="flex items-start gap-1.5 px-3 py-[4px] hover:bg-white/5 text-[11px]"
            >
              <History size={11} className="text-white/20 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-white/70 truncate">{entry.message}</div>
                <div className="flex items-center gap-1.5 text-white/30">
                  <span className="font-mono">{entry.hash.slice(0, 7)}</span>
                  <span>{entry.author_name}</span>
                  <span>{relativeTime(entry.date)}</span>
                </div>
              </div>
            </div>
          ))}
        </Section>

        {/* Worktrees */}
        <Section title="Worktrees" count={worktrees.length} defaultOpen={false}>
          {worktrees.map((wt) => (
            <div
              key={wt.path}
              className={`flex items-center gap-1.5 px-3 py-[3px] cursor-pointer hover:bg-white/5 ${
                wt.isCurrent ? 'text-white/80' : 'text-white/50'
              }`}
              onClick={() => {
                if (selectedWorkspaceId) {
                  setWorkspaceRootPath(selectedWorkspaceId, wt.path)
                }
              }}
            >
              <GitBranch size={12} className="flex-shrink-0" />
              <span className="truncate flex-1">{wt.branch || '(detached)'}</span>
              {wt.isCurrent && (
                <span className="text-[10px] text-green-400/60">current</span>
              )}
            </div>
          ))}
        </Section>

        {/* Empty state */}
        {status && stagedFiles.length === 0 && changedFiles.length === 0 && untrackedFiles.length === 0 && (
          <div className="flex items-center justify-center py-8 text-white/25 text-[11px]">
            No changes detected
          </div>
        )}
      </div>
    </div>
  )
}
