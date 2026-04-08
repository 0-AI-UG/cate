// =============================================================================
// GitPanel — Full-featured Git panel for the canvas
// =============================================================================

import React, { useState, useCallback, useEffect, useRef } from 'react'
import {
  GitBranch,
  ArrowClockwise,
  Plus,
  Minus,
  ArrowUp,
  ArrowDown,
  Download,
  ArrowUUpLeft,
  Archive,
  BoxArrowUp,
  X,
  Check,
  Trash,
} from '@phosphor-icons/react'
import { useAppStore } from '../stores/appStore'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GitFile {
  path: string
  index: string
  working_dir: string
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

interface GitPanelProps {
  panelId: string
  workspaceId: string
  nodeId: string
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
    case '?': return 'text-muted'
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
// Tab type
// ---------------------------------------------------------------------------

type GitTab = 'changes' | 'log' | 'branches'

export default function GitPanel({ panelId: _panelId, workspaceId, nodeId: _nodeId }: GitPanelProps) {
  const rootPath = useAppStore((s) => s.workspaces.find(w => w.id === workspaceId)?.rootPath)

  // State
  const [files, setFiles] = useState<GitFile[]>([])
  const [branch, setBranch] = useState<string | null>(null)
  const [ahead, setAhead] = useState(0)
  const [behind, setBehind] = useState(0)
  const [commitMsg, setCommitMsg] = useState('')
  const [logEntries, setLogEntries] = useState<GitLogEntry[]>([])
  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<GitTab>('changes')
  const [actionError, setActionError] = useState<string | null>(null)
  const [pushing, setPushing] = useState(false)
  const [pulling, setPulling] = useState(false)

  const createDiffEditor = useAppStore((s) => s.createDiffEditor)

  // Branch creation
  const [creatingBranch, setCreatingBranch] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')

  const refresh = useCallback(async () => {
    if (!rootPath) return
    setIsLoading(true)
    setActionError(null)
    try {
      const [status, log, branchList] = await Promise.all([
        window.electronAPI.gitStatus(rootPath) as Promise<any>,
        window.electronAPI.gitLog(rootPath, 50),
        window.electronAPI.gitBranchList(rootPath),
      ])
      setFiles(status.files)
      setBranch(status.current)
      setAhead(status.ahead)
      setBehind(status.behind)
      setLogEntries(log)
      setBranches(branchList.branches)
    } catch { /* not a git repo */ }
    setIsLoading(false)
  }, [rootPath])

  useEffect(() => { refresh() }, [refresh])

  // Listen for branch updates
  useEffect(() => {
    const cleanup = window.electronAPI.onGitBranchUpdate(() => refresh())
    return cleanup
  }, [refresh])

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const openFileDiff = useCallback((filePath: string, staged: boolean) => {
    if (!rootPath) return
    const fullPath = filePath.startsWith('/') ? filePath : `${rootPath}/${filePath}`
    createDiffEditor(workspaceId, fullPath, staged ? 'staged' : 'working')
  }, [rootPath, workspaceId, createDiffEditor])

  const handleStage = useCallback(async (filePath: string) => {
    if (!rootPath) return
    await window.electronAPI.gitStage(rootPath, filePath)
    refresh()
  }, [rootPath, refresh])

  const handleUnstage = useCallback(async (filePath: string) => {
    if (!rootPath) return
    await window.electronAPI.gitUnstage(rootPath, filePath)
    refresh()
  }, [rootPath, refresh])

  const handleDiscard = useCallback(async (filePath: string) => {
    if (!rootPath) return
    try {
      await window.electronAPI.gitDiscardFile(rootPath, filePath)
      refresh()
    } catch (err: any) {
      setActionError(err?.message || 'Discard failed')
    }
  }, [rootPath, refresh])

  const handleCommit = useCallback(async () => {
    if (!rootPath || !commitMsg.trim()) return
    setActionError(null)
    try {
      await window.electronAPI.gitCommit(rootPath, commitMsg.trim())
      setCommitMsg('')
      refresh()
    } catch (err: any) {
      setActionError(err?.message || 'Commit failed')
    }
  }, [rootPath, commitMsg, refresh])

  const handlePush = useCallback(async () => {
    if (!rootPath || pushing) return
    setPushing(true)
    setActionError(null)
    try {
      await window.electronAPI.gitPush(rootPath)
      refresh()
    } catch (err: any) {
      setActionError(err?.message || 'Push failed')
    } finally { setPushing(false) }
  }, [rootPath, pushing, refresh])

  const handlePull = useCallback(async () => {
    if (!rootPath || pulling) return
    setPulling(true)
    setActionError(null)
    try {
      await window.electronAPI.gitPull(rootPath)
      refresh()
    } catch (err: any) {
      setActionError(err?.message || 'Pull failed')
    } finally { setPulling(false) }
  }, [rootPath, pulling, refresh])

  const handleFetch = useCallback(async () => {
    if (!rootPath) return
    setActionError(null)
    try {
      await window.electronAPI.gitFetch(rootPath)
      refresh()
    } catch (err: any) {
      setActionError(err?.message || 'Fetch failed')
    }
  }, [rootPath, refresh])

  const handleStash = useCallback(async () => {
    if (!rootPath) return
    setActionError(null)
    try {
      await window.electronAPI.gitStash(rootPath)
      refresh()
    } catch (err: any) {
      setActionError(err?.message || 'Stash failed')
    }
  }, [rootPath, refresh])

  const handleStashPop = useCallback(async () => {
    if (!rootPath) return
    setActionError(null)
    try {
      await window.electronAPI.gitStashPop(rootPath)
      refresh()
    } catch (err: any) {
      setActionError(err?.message || 'Stash pop failed')
    }
  }, [rootPath, refresh])

  const handleCheckout = useCallback(async (name: string) => {
    if (!rootPath) return
    setActionError(null)
    try {
      const branchName = name.replace(/^remotes\/origin\//, '')
      await window.electronAPI.gitCheckout(rootPath, branchName)
      refresh()
    } catch (err: any) {
      setActionError(err?.message || 'Checkout failed')
    }
  }, [rootPath, refresh])

  const handleCreateBranch = useCallback(async () => {
    if (!rootPath || !newBranchName.trim()) return
    setActionError(null)
    try {
      await window.electronAPI.gitBranchCreate(rootPath, newBranchName.trim())
      setNewBranchName('')
      setCreatingBranch(false)
      refresh()
    } catch (err: any) {
      setActionError(err?.message || 'Create branch failed')
    }
  }, [rootPath, newBranchName, refresh])

  const handleDeleteBranch = useCallback(async (name: string) => {
    if (!rootPath || name === branch) return
    setActionError(null)
    try {
      await window.electronAPI.gitBranchDelete(rootPath, name)
      refresh()
    } catch (err: any) {
      setActionError(err?.message || 'Delete branch failed')
    }
  }, [rootPath, branch, refresh])

  // -------------------------------------------------------------------------
  // Categorize files
  // -------------------------------------------------------------------------

  const staged = files.filter(f => f.index !== ' ' && f.index !== '?')
  const changed = files.filter(f => f.working_dir !== ' ' && f.working_dir !== '?' && (f.index === ' ' || f.index === '?' || !f.index))
  const untracked = files.filter(f => f.working_dir === '?')

  if (!rootPath) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Set a workspace root to use Git
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-surface-4 text-sm">
      {/* Header: branch + actions */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-subtle flex-shrink-0">
        <GitBranch size={14} className="text-muted flex-shrink-0" />
        <span className="text-secondary text-xs truncate">{branch ?? '...'}</span>
        {(ahead > 0 || behind > 0) && (
          <span className="text-muted text-[10px] flex-shrink-0">
            {ahead > 0 && `↑${ahead}`}{behind > 0 && ` ↓${behind}`}
          </span>
        )}
        <div className="flex-1" />
        <button onClick={handleFetch} className="p-1 rounded hover:bg-hover text-muted hover:text-secondary" title="Fetch"><Download size={13} /></button>
        <button onClick={handlePull} className={`p-1 rounded hover:bg-hover text-muted hover:text-secondary ${pulling ? 'animate-pulse' : ''}`} title="Pull" disabled={pulling}><ArrowDown size={13} /></button>
        <button onClick={handlePush} className={`p-1 rounded hover:bg-hover text-muted hover:text-secondary ${pushing ? 'animate-pulse' : ''}`} title="Push" disabled={pushing}><ArrowUp size={13} /></button>
        <button onClick={refresh} className={`p-1 rounded hover:bg-hover text-muted hover:text-secondary ${isLoading ? 'animate-spin' : ''}`} title="Refresh"><ArrowClockwise size={13} /></button>
      </div>

      {/* Error banner */}
      {actionError && (
        <div className="flex items-center gap-1 px-3 py-1 bg-red-500/[0.1] text-red-400/80 text-[11px] flex-shrink-0">
          <span className="flex-1 truncate">{actionError}</span>
          <button onClick={() => setActionError(null)} className="p-0.5 hover:bg-hover rounded"><X size={12} /></button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-subtle flex-shrink-0">
        {(['changes', 'log', 'branches'] as GitTab[]).map(tab => (
          <button
            key={tab}
            className={`flex-1 py-1.5 text-[11px] font-medium transition-colors ${
              activeTab === tab ? 'text-primary border-b-2 border-focus' : 'text-muted hover:text-secondary'
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'changes' ? `Changes (${files.length})` : tab === 'log' ? 'Log' : 'Branches'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* ---- CHANGES TAB ---- */}
        {activeTab === 'changes' && (
          <>
            {/* Commit area */}
            <div className="px-3 py-2 border-b border-subtle flex-shrink-0">
              <input
                type="text"
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCommit() }}
                className="w-full bg-surface-3 text-primary text-xs px-2 py-1.5 rounded border border-subtle outline-none focus:border-blue-500/50 mb-1.5"
                placeholder="Commit message..."
              />
              <div className="flex gap-1">
                <button
                  onClick={handleCommit}
                  disabled={!commitMsg.trim() || staged.length === 0}
                  className="flex-1 py-1.5 bg-green-600/30 hover:bg-green-600/40 text-primary text-xs rounded disabled:opacity-30 transition-colors"
                >
                  Commit ({staged.length})
                </button>
                <button onClick={handleStash} className="px-2 py-1.5 bg-surface-5 hover:bg-hover text-secondary text-xs rounded" title="Stash">
                  <Archive size={13} />
                </button>
                <button onClick={handleStashPop} className="px-2 py-1.5 bg-surface-5 hover:bg-hover text-secondary text-xs rounded" title="Pop Stash">
                  <BoxArrowUp size={13} />
                </button>
              </div>
            </div>

            {/* File lists */}
            <div className="flex-1 min-h-0 overflow-y-auto">
                {staged.length > 0 && (
                  <div>
                    <div className="flex items-center px-3 py-1 text-xs text-green-400/60">
                      <span className="flex-1 uppercase">Staged</span>
                      <button
                        className="p-0.5 rounded hover:bg-hover text-muted hover:text-secondary"
                        onClick={() => { for (const f of staged) handleUnstage(f.path) }}
                        title="Unstage All"
                      ><Minus size={12} /></button>
                    </div>
                    {staged.map(f => (
                      <div
                        key={`s-${f.path}`}
                        className="group flex items-center px-3 py-1 hover:bg-hover cursor-pointer"
                        onClick={() => openFileDiff(f.path, true)}
                      >
                        <span className={`w-4 text-center mr-1 font-mono text-[11px] ${statusColor(f.index)}`}>{f.index}</span>
                        <span className="text-primary flex-1 truncate text-xs">{f.path}</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleUnstage(f.path) }}
                          className="hidden group-hover:block text-muted hover:text-secondary ml-1"
                        ><Minus size={12} /></button>
                      </div>
                    ))}
                  </div>
                )}
                {changed.length > 0 && (
                  <div>
                    <div className="flex items-center px-3 py-1 text-xs text-orange-400/60">
                      <span className="flex-1 uppercase">Changes</span>
                      <button
                        className="p-0.5 rounded hover:bg-hover text-muted hover:text-secondary"
                        onClick={() => { for (const f of changed) handleStage(f.path) }}
                        title="Stage All"
                      ><Plus size={12} /></button>
                    </div>
                    {changed.map(f => (
                      <div
                        key={`u-${f.path}`}
                        className="group flex items-center px-3 py-1 hover:bg-hover cursor-pointer"
                        onClick={() => openFileDiff(f.path, false)}
                      >
                        <span className={`w-4 text-center mr-1 font-mono text-[11px] ${statusColor(f.working_dir)}`}>{f.working_dir}</span>
                        <span className="text-primary flex-1 truncate text-xs">{f.path}</span>
                        <div className="hidden group-hover:flex items-center gap-0.5 ml-1">
                          <button onClick={(e) => { e.stopPropagation(); handleDiscard(f.path) }} className="text-muted hover:text-red-400"><ArrowUUpLeft size={12} /></button>
                          <button onClick={(e) => { e.stopPropagation(); handleStage(f.path) }} className="text-muted hover:text-secondary"><Plus size={12} /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {untracked.length > 0 && (
                  <div>
                    <div className="flex items-center px-3 py-1 text-xs text-muted">
                      <span className="flex-1 uppercase">Untracked</span>
                      <button
                        className="p-0.5 rounded hover:bg-hover text-muted hover:text-secondary"
                        onClick={() => { for (const f of untracked) handleStage(f.path) }}
                        title="Stage All"
                      ><Plus size={12} /></button>
                    </div>
                    {untracked.map(f => (
                      <div
                        key={`ut-${f.path}`}
                        className="group flex items-center px-3 py-1 hover:bg-hover cursor-pointer"
                        onClick={() => handleStage(f.path)}
                      >
                        <span className="w-4 text-center mr-1 font-mono text-[11px] text-muted">?</span>
                        <span className="text-secondary flex-1 truncate text-xs">{f.path}</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleStage(f.path) }}
                          className="hidden group-hover:block text-muted hover:text-secondary ml-1"
                        ><Plus size={12} /></button>
                      </div>
                    ))}
                  </div>
                )}
                {files.length === 0 && !isLoading && (
                  <div className="px-3 py-4 text-muted text-center text-xs">Clean working tree</div>
                )}
            </div>
          </>
        )}

        {/* ---- LOG TAB ---- */}
        {activeTab === 'log' && (
          <div className="flex-1 overflow-y-auto">
            {logEntries.map((entry) => (
              <div key={entry.hash} className="px-3 py-2 hover:bg-hover border-b border-subtle">
                <div className="flex items-start gap-2">
                  <span className="font-mono text-[11px] text-blue-400/60 flex-shrink-0 mt-0.5">{entry.hash.slice(0, 7)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-primary text-xs">{entry.message}</div>
                    <div className="flex items-center gap-2 text-[10px] text-muted mt-0.5">
                      <span>{entry.author_name}</span>
                      <span>{relativeTime(entry.date)}</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {logEntries.length === 0 && !isLoading && (
              <div className="flex items-center justify-center py-8 text-muted text-xs">No commits</div>
            )}
          </div>
        )}

        {/* ---- BRANCHES TAB ---- */}
        {activeTab === 'branches' && (
          <div className="flex-1 overflow-y-auto">
            {/* Create branch */}
            <div className="px-3 py-2 border-b border-subtle">
              {creatingBranch ? (
                <div className="flex gap-1">
                  <input
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleCreateBranch(); if (e.key === 'Escape') setCreatingBranch(false) }}
                    className="flex-1 bg-surface-3 text-primary text-xs px-2 py-1 rounded border border-subtle outline-none focus:border-blue-500/50"
                    placeholder="Branch name..."
                    autoFocus
                  />
                  <button onClick={handleCreateBranch} className="p-1 rounded hover:bg-hover text-green-400/70"><Check size={14} /></button>
                  <button onClick={() => setCreatingBranch(false)} className="p-1 rounded hover:bg-hover text-muted"><X size={14} /></button>
                </div>
              ) : (
                <button
                  onClick={() => setCreatingBranch(true)}
                  className="flex items-center gap-1.5 text-muted hover:text-secondary text-xs"
                >
                  <Plus size={13} /> Create Branch
                </button>
              )}
            </div>

            {/* Local branches */}
            <div className="px-3 py-1 text-[10px] text-muted uppercase">Local</div>
            {branches.filter(b => !b.isRemote).map(b => (
              <div
                key={b.name}
                className={`group flex items-center gap-2 px-3 py-1.5 hover:bg-hover cursor-pointer ${b.current ? 'text-primary' : 'text-secondary'}`}
                onClick={() => handleCheckout(b.name)}
              >
                <GitBranch size={12} className="flex-shrink-0" />
                <span className="truncate flex-1 text-xs">{b.name}</span>
                {b.current && <span className="text-[10px] text-green-400/60">current</span>}
                {!b.current && (
                  <button
                    className="hidden group-hover:block p-0.5 rounded hover:bg-hover text-muted hover:text-red-400"
                    onClick={(e) => { e.stopPropagation(); handleDeleteBranch(b.name) }}
                    title="Delete"
                  ><Trash size={11} /></button>
                )}
              </div>
            ))}

            {/* Remote branches */}
            {branches.filter(b => b.isRemote).length > 0 && (
              <>
                <div className="px-3 py-1 text-[10px] text-muted uppercase mt-2">Remote</div>
                {branches.filter(b => b.isRemote).map(b => (
                  <div
                    key={b.name}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-hover cursor-pointer text-muted"
                    onClick={() => handleCheckout(b.name)}
                  >
                    <GitBranch size={12} className="flex-shrink-0" />
                    <span className="truncate flex-1 text-xs">{b.name.replace('remotes/', '')}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
