import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  GitBranch,
  RotateCw,
  ChevronDown,
  ChevronRight,
  Plus,
  Minus,
  Undo2,
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
            className="p-0.5 rounded hover:bg-white/10 text-white/40 hover:text-white/70"
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
// SourceControlView
// ---------------------------------------------------------------------------

interface SourceControlViewProps {
  rootPath: string
}

export const SourceControlView: React.FC<SourceControlViewProps> = ({ rootPath }) => {
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [commitMessage, setCommitMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [committing, setCommitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const createEditor = useAppStore((s) => s.createEditor)
  const setWorkspaceRootPath = useAppStore((s) => s.setWorkspaceRootPath)
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------

  const refresh = useCallback(async () => {
    if (!rootPath) return
    setLoading(true)
    try {
      const [statusResult, worktreeResult] = await Promise.all([
        window.electronAPI.gitStatus(rootPath),
        window.electronAPI.gitWorktreeList(rootPath),
      ])
      setStatus(statusResult as GitStatusResult)
      setWorktrees(worktreeResult as Worktree[])
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
    try {
      await window.electronAPI.gitCommit(rootPath, commitMessage.trim())
      setCommitMessage('')
      refresh()
    } catch (err) {
      console.error('Commit error:', err)
    } finally {
      setCommitting(false)
    }
  }, [rootPath, commitMessage, committing, refresh])

  const openDiff = useCallback(async (filePath: string) => {
    try {
      const fullPath = filePath.startsWith('/') ? filePath : `${rootPath}/${filePath}`
      createEditor(selectedWorkspaceId, fullPath)
    } catch (err) {
      console.error('Diff error:', err)
    }
  }, [rootPath, selectedWorkspaceId, createEditor])

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
      {/* Branch + refresh */}
      <div className="flex items-center gap-1.5 px-3 py-2 flex-shrink-0">
        <GitBranch size={14} className="text-white/40 flex-shrink-0" />
        <span className="truncate text-[12px] text-white/40 flex-1">
          {status?.current ?? '...'}
        </span>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="text-white/30 text-[10px] flex-shrink-0">
            {status.ahead > 0 && `↑${status.ahead}`}
            {status.behind > 0 && ` ↓${status.behind}`}
          </span>
        )}
        <button
          className={`p-0.5 rounded hover:bg-white/10 text-white/30 hover:text-white/60 transition-colors flex-shrink-0 ${loading ? 'animate-spin' : ''}`}
          onClick={refresh}
          title="Refresh"
        >
          <RotateCw size={14} strokeWidth={1.5} />
        </button>
      </div>

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
        <button
          className="w-full mt-1.5 py-1 rounded text-[11px] font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed bg-white/10 hover:bg-white/15 text-white/80"
          disabled={!commitMessage.trim() || stagedFiles.length === 0 || committing}
          onClick={commit}
        >
          {committing ? 'Committing...' : 'Commit'}
        </button>
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
              onClick={() => openDiff(f.path)}
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
              onDiscard={() => {/* TODO: implement discard */}}
              onClick={() => openDiff(f.path)}
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
              onClick={() => openDiff(f.path)}
            />
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
