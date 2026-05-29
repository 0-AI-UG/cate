// =============================================================================
// ParallelWorkTab — first-class sidebar tab that promotes git worktrees from
// a hidden, advanced primitive to a user-friendly "parallel branch" concept.
// Hides the word "worktree" from the primary UI.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CateLogo } from '../ui/CateLogo'
import {
  ArrowsSplit,
  Plus,
  ArrowClockwise,
  GitBranch,
  Check,
  X,
  Warning,
  Terminal as TerminalIcon,
  GitMerge,
  Trash,
  CaretRight,
  CaretDown,
} from '@phosphor-icons/react'
import { useAppStore, pickWorktreeColor } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import { SidebarSectionHeader, SidebarHeaderButton } from './SidebarSectionHeader'
import type { WorktreeMeta } from '../../shared/types'
import log from '../lib/logger'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sibling folder convention: <repo>/../<repo-name>.worktrees/<branch-slug>. */
function worktreePathFor(repoRoot: string, branch: string): string {
  const trimmed = repoRoot.replace(/\/+$/, '')
  const parts = trimmed.split('/')
  const repoName = parts.pop() || 'repo'
  const parentDir = parts.join('/') || '/'
  const slug = branch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'wt'
  return `${parentDir}/${repoName}.worktrees/${slug}`
}

interface GitWorktree {
  path: string
  branch: string
  isBare: boolean
  isCurrent: boolean
}

interface WorktreeStatus {
  branch: string
  dirty: boolean
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const StatusBadge: React.FC<{ status?: WorktreeStatus }> = ({ status }) => {
  if (!status) return null
  const parts: React.ReactNode[] = []
  if (status.dirty) {
    parts.push(
      <span key="dirty" className="text-yellow-400/80" title="Uncommitted changes">●</span>,
    )
  }
  if (status.ahead > 0) {
    parts.push(
      <span key="ahead" className="text-green-400/70 tabular-nums" title={`${status.ahead} ahead`}>
        ↑{status.ahead}
      </span>,
    )
  }
  if (status.behind > 0) {
    parts.push(
      <span key="behind" className="text-blue-400/70 tabular-nums" title={`${status.behind} behind`}>
        ↓{status.behind}
      </span>,
    )
  }
  if (parts.length === 0) {
    return <span className="text-muted text-[10px]" title="Clean">clean</span>
  }
  return <span className="flex items-center gap-1 text-[10px]">{parts}</span>
}

// ---------------------------------------------------------------------------
// Create form
// ---------------------------------------------------------------------------

const CreateForm: React.FC<{
  onSubmit: (branch: string, createNew: boolean, baseRef?: string) => Promise<void>
  onCancel: () => void
  defaultBaseBranch: string
  rootPath: string
}> = ({ onSubmit, onCancel, defaultBaseBranch, rootPath }) => {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [baseRef, setBaseRef] = useState<string>('')
  const [branches, setBranches] = useState<Array<{ name: string; isRemote: boolean }>>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [localExpanded, setLocalExpanded] = useState(true)
  const [remoteExpanded, setRemoteExpanded] = useState(false)
  const [filter, setFilter] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    let cancelled = false
    window.electronAPI.gitBranchList(rootPath).then((result) => {
      if (cancelled) return
      setBranches(
        result.branches
          .filter((b) => !b.name.includes('/HEAD'))
          .map((b) => ({ name: b.name, isRemote: b.isRemote })),
      )
    }).catch(() => {})
    return () => { cancelled = true }
  }, [rootPath])

  useEffect(() => {
    if (!pickerOpen) return
    filterRef.current?.focus()
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [pickerOpen])

  const displayBase = baseRef || defaultBaseBranch || 'HEAD'

  const { localBranches, remoteBranches } = useMemo(() => {
    const q = filter.toLowerCase()
    const filtered = q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : branches
    return {
      localBranches: filtered.filter((b) => !b.isRemote),
      remoteBranches: filtered.filter((b) => b.isRemote),
    }
  }, [branches, filter])

  const submit = useCallback(async () => {
    const branch = name.trim()
    if (!branch || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(branch, true, baseRef || undefined)
    } catch (err: any) {
      setError(err?.message || 'Failed to create')
    } finally {
      setBusy(false)
    }
  }, [name, busy, onSubmit, baseRef])

  return (
    <div className="px-1 pt-1">
      <div className="flex items-center gap-1 h-8 px-1.5 rounded-md bg-surface-3 text-secondary focus-within:bg-surface-4 transition-colors">
        <GitBranch size={14} weight="bold" className="flex-shrink-0 opacity-60 ml-1" />
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onCancel()
          }}
          placeholder="new-branch-name"
          disabled={busy}
          className="flex-1 min-w-0 text-[14px] bg-transparent outline-none text-primary placeholder:text-muted"
        />
        <button
          onClick={submit}
          disabled={!name.trim() || busy}
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-muted hover:text-primary hover:bg-hover disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          title="Create"
        >
          <Check size={14} weight="bold" />
        </button>
        <button
          onClick={onCancel}
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-muted hover:text-primary hover:bg-hover transition-colors"
          title="Cancel"
        >
          <X size={14} weight="bold" />
        </button>
      </div>
      <div className="relative px-2 pt-1 pb-1" ref={pickerRef}>
        <button
          onClick={() => { setPickerOpen((v) => !v); setFilter('') }}
          className="flex items-center gap-0.5 text-[11px] text-muted hover:text-secondary transition-colors"
        >
          from <span className="text-secondary ml-0.5 truncate max-w-[140px] inline-block align-bottom">{displayBase}</span>
          <CaretDown size={10} className="flex-shrink-0 opacity-60" />
        </button>
        {pickerOpen && (
          <div className="absolute left-0 right-0 top-full z-50 mt-0.5 mx-1 rounded-md border border-subtle bg-surface-2 shadow-lg max-h-[200px] flex flex-col overflow-hidden">
            <div className="px-2 py-1 border-b border-subtle">
              <input
                ref={filterRef}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setPickerOpen(false)
                }}
                placeholder="Filter branches…"
                className="w-full text-[12px] bg-transparent outline-none text-primary placeholder:text-muted"
              />
            </div>
            <div className="overflow-y-auto">
              {localBranches.length > 0 && (
                <div>
                  <button
                    onClick={() => setLocalExpanded((v) => !v)}
                    className="w-full flex items-center gap-1 px-2 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-muted select-none hover:text-secondary transition-colors"
                  >
                    <CaretRight size={8} className={`flex-shrink-0 transition-transform ${localExpanded ? 'rotate-90' : ''}`} />
                    Local
                    <span className="text-muted/60 normal-case tracking-normal">({localBranches.length})</span>
                  </button>
                  {localExpanded && localBranches.map((b) => (
                    <button
                      key={b.name}
                      onClick={() => { setBaseRef(b.name); setPickerOpen(false) }}
                      className={`w-full text-left px-2 py-1 text-[12px] truncate hover:bg-hover transition-colors ${
                        b.name === (baseRef || defaultBaseBranch) ? 'text-primary bg-hover' : 'text-secondary'
                      }`}
                    >
                      {b.name}
                    </button>
                  ))}
                </div>
              )}
              {remoteBranches.length > 0 && (
                <div>
                  <button
                    onClick={() => setRemoteExpanded((v) => !v)}
                    className={`w-full flex items-center gap-1 px-2 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-muted select-none hover:text-secondary transition-colors ${localBranches.length > 0 ? 'border-t border-subtle mt-1' : ''}`}
                  >
                    <CaretRight size={8} className={`flex-shrink-0 transition-transform ${remoteExpanded ? 'rotate-90' : ''}`} />
                    Remote
                    <span className="text-muted/60 normal-case tracking-normal">({remoteBranches.length})</span>
                  </button>
                  {remoteExpanded && remoteBranches.map((b) => (
                    <button
                      key={b.name}
                      onClick={() => { setBaseRef(b.name); setPickerOpen(false) }}
                      className={`w-full text-left px-2 py-1 text-[12px] truncate hover:bg-hover transition-colors opacity-70 ${
                        b.name === (baseRef || defaultBaseBranch) ? 'text-primary bg-hover' : 'text-secondary'
                      }`}
                    >
                      {b.name}
                    </button>
                  ))}
                </div>
              )}
              {localBranches.length === 0 && remoteBranches.length === 0 && (
                <div className="px-2 py-2 text-[11px] text-muted text-center">No matching branches</div>
              )}
            </div>
          </div>
        )}
      </div>
      {error && (
        <div className="px-2 pb-1 text-[11px] text-red-400/80">{error}</div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

const ChildAction: React.FC<{
  icon: React.ReactNode
  label: string
  onClick: () => void
  destructive?: boolean
}> = ({ icon, label, onClick, destructive }) => (
  <button
    onClick={onClick}
    className={`group/action flex items-center gap-1.5 h-7 pl-7 pr-2 text-[13px] text-secondary hover:bg-hover hover:text-primary text-left min-w-0 focus:outline-none transition-colors ${
      destructive ? 'hover:text-red-400' : ''
    }`}
  >
    <span className="flex-shrink-0 opacity-60 group-hover/action:opacity-100">{icon}</span>
    <span className="truncate">{label}</span>
  </button>
)

const WorktreeCard: React.FC<{
  worktree: WorktreeMeta
  status?: WorktreeStatus
  defaultExpanded?: boolean
  onOpenTerminal: () => void
  onOpenAgent: () => void
  onMerge?: () => void
  onDelete?: () => void
}> = ({ worktree, status, defaultExpanded, onOpenTerminal, onOpenAgent, onMerge, onDelete }) => {
  const [expanded, setExpanded] = useState(!!defaultExpanded)
  const label = worktree.label || worktree.branch || (worktree.isPrimary ? 'main' : '(detached)')

  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1 h-8 px-1.5 text-secondary hover:text-primary hover:bg-hover transition-colors outline-none"
        title={worktree.path}
      >
        <CaretRight
          size={10}
          className={`flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <GitBranch
          size={14}
          weight="bold"
          className="flex-shrink-0 opacity-90"
          style={{ color: worktree.color }}
        />
        <span className="flex-1 min-w-0 text-[14px] truncate text-left">{label}</span>
        {worktree.isPrimary && (
          <span className="flex-shrink-0 text-[9px] uppercase tracking-wide text-muted">primary</span>
        )}
        <span className="flex-shrink-0">
          <StatusBadge status={status} />
        </span>
      </button>

      {expanded && (
        <div className="flex flex-col pb-1">
          <ChildAction
            icon={<TerminalIcon size={12} />}
            label="Open terminal here"
            onClick={onOpenTerminal}
          />
          <ChildAction
            icon={<CateLogo size={12} />}
            label="Open agent here"
            onClick={onOpenAgent}
          />
          {onMerge && (
            <ChildAction
              icon={<GitMerge size={12} />}
              label="Merge into primary"
              onClick={onMerge}
            />
          )}
          {onDelete && (
            <ChildAction
              icon={<Trash size={12} />}
              label="Delete worktree"
              onClick={onDelete}
              destructive
            />
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface ParallelWorkTabProps {
  rootPath: string
}

export const ParallelWorkTab: React.FC<ParallelWorkTabProps> = ({ rootPath }) => {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const workspace = useAppStore((s) => s.workspaces.find((w) => w.id === s.selectedWorkspaceId))
  const ensurePrimaryWorktree = useAppStore((s) => s.ensurePrimaryWorktree)
  const upsertWorktree = useAppStore((s) => s.upsertWorktree)
  const removeWorktree = useAppStore((s) => s.removeWorktree)
  const createTerminal = useAppStore((s) => s.createTerminal)
  const createAgent = useAppStore((s) => s.createAgent)
  const addAdditionalRoot = useAppStore((s) => s.addAdditionalRoot)

  const [gitWorktrees, setGitWorktrees] = useState<GitWorktree[]>([])
  const [statusByPath, setStatusByPath] = useState<Record<string, WorktreeStatus>>({})
  const [creating, setCreating] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [primaryBranch, setPrimaryBranch] = useState<string>('')

  // ---------------------------------------------------------------------------
  // Load + sync
  // ---------------------------------------------------------------------------

  const reconcile = useCallback(async () => {
    if (!rootPath || !selectedWorkspaceId) return
    setRefreshing(true)
    setError(null)
    try {
      const list = await window.electronAPI.gitWorktreeList(rootPath)
      setGitWorktrees(list)

      // Materialize the primary worktree in workspace state if missing.
      ensurePrimaryWorktree(selectedWorkspaceId)

      // For each git-known worktree not already tracked, register it with a
      // freshly assigned color so the canvas can color-code its panels.
      const ws = useAppStore.getState().workspaces.find((w) => w.id === selectedWorkspaceId)
      if (ws) {
        const existing = ws.worktrees ?? []
        for (const g of list) {
          const match = existing.find((w) => w.path === g.path)
          if (!match) {
            const meta: WorktreeMeta = {
              id: `wt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              path: g.path,
              branch: g.branch,
              color: pickWorktreeColor(existing),
              isPrimary: g.path === ws.rootPath,
            }
            upsertWorktree(selectedWorkspaceId, meta)
          } else if (match.branch !== g.branch) {
            upsertWorktree(selectedWorkspaceId, { ...match, branch: g.branch })
          }
        }
      }

      // Fetch status for each worktree (best effort, in parallel).
      const statusEntries = await Promise.all(
        list.map(async (g) => {
          try {
            const s = await window.electronAPI.gitWorktreeStatus(g.path)
            if (!s) return null
            return [g.path, s] as const
          } catch {
            return null
          }
        }),
      )
      const next: Record<string, WorktreeStatus> = {}
      for (const e of statusEntries) if (e) next[e[0]] = e[1]
      setStatusByPath(next)

      const currentEntry = list.find((g) => g.isCurrent)
      if (currentEntry) setPrimaryBranch(currentEntry.branch)
    } catch (err: any) {
      log.warn('[parallel-work] reconcile failed', err)
      setError(err?.message || 'Failed to load worktrees')
    } finally {
      setRefreshing(false)
    }
  }, [rootPath, selectedWorkspaceId, ensurePrimaryWorktree, upsertWorktree])

  useEffect(() => { void reconcile() }, [reconcile])

  useEffect(() => {
    const onFocus = () => { void reconcile() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [reconcile])

  useEffect(() => {
    const off = window.electronAPI.onGitBranchUpdate?.(() => { void reconcile() })
    return () => { off?.() }
  }, [reconcile])

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const handleCreate = useCallback(
    async (branch: string, createNew: boolean, baseRef?: string) => {
      if (!rootPath || !selectedWorkspaceId) return
      const targetPath = worktreePathFor(rootPath, branch)
      await window.electronAPI.gitWorktreeAdd(rootPath, branch, targetPath, {
        createBranch: createNew,
        baseRef,
      })

      const ws = useAppStore.getState().workspaces.find((w) => w.id === selectedWorkspaceId)
      const meta: WorktreeMeta = {
        id: `wt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        path: targetPath,
        branch,
        color: pickWorktreeColor(ws?.worktrees ?? []),
        isPrimary: false,
      }
      upsertWorktree(selectedWorkspaceId, meta)
      addAdditionalRoot(selectedWorkspaceId, targetPath)

      // Spawn a terminal cwd'd to the new worktree so the user can start
      // working immediately. The terminal is tagged with the worktree id so
      // its title-bar pill picks up the right color.
      const panelId = createTerminal(selectedWorkspaceId, undefined, undefined, undefined, targetPath)
      useAppStore.getState().setPanelWorktreeId(selectedWorkspaceId, panelId, meta.id)

      setCreating(false)
      void reconcile()
    },
    [rootPath, selectedWorkspaceId, upsertWorktree, addAdditionalRoot, createTerminal, reconcile],
  )

  const handleDelete = useCallback(
    async (wt: WorktreeMeta) => {
      if (!rootPath || !selectedWorkspaceId || wt.isPrimary) return
      const label = wt.label || wt.branch || wt.path
      const status = statusByPath[wt.path]
      const dirty = !!status?.dirty
      const branchAhead = (status?.ahead ?? 0) > 0
      const ok = window.confirm(
        `Delete parallel branch “${label}”?\n\n` +
          `This removes:\n` +
          `  • the worktree at ${wt.path}\n` +
          (wt.branch ? `  • the branch ${wt.branch}\n` : '') +
          `\n` +
          (dirty
            ? 'WARNING: uncommitted changes in this worktree will be lost.\n'
            : '') +
          (branchAhead
            ? `WARNING: this branch has ${status?.ahead} unmerged commit(s).\n`
            : ''),
      )
      if (!ok) return
      try {
        await window.electronAPI.gitWorktreeRemove(rootPath, wt.path, { force: dirty })
        // Best-effort branch cleanup. Force-delete because the user already
        // confirmed; preserves the cleanup-in-one-step UX even when the
        // branch isn't merged into upstream.
        if (wt.branch) {
          try {
            await window.electronAPI.gitBranchDelete(rootPath, wt.branch, true)
          } catch (err: any) {
            // Surface as warning but don't roll back — the worktree is gone.
            setError(`Worktree removed, but branch ${wt.branch} could not be deleted: ${err?.message || err}`)
          }
        }
        removeWorktree(selectedWorkspaceId, wt.id)
        void reconcile()
      } catch (err: any) {
        setError(err?.message || 'Delete failed')
      }
    },
    [rootPath, selectedWorkspaceId, removeWorktree, reconcile, statusByPath],
  )

  const handleMergeBack = useCallback(
    async (wt: WorktreeMeta) => {
      if (!rootPath) return
      // Resolve the primary branch lazily — `primaryBranch` may be empty if the
      // current cwd doesn't match any worktree row. Fall back to the workspace's
      // primary WorktreeMeta, then to a fresh status read.
      const ws = useAppStore.getState().workspaces.find((w) => w.id === selectedWorkspaceId)
      const primary = ws?.worktrees?.find((w) => w.isPrimary)
      let target = primaryBranch || primary?.branch || ''
      if (!target && primary?.path) {
        try {
          const s = await window.electronAPI.gitWorktreeStatus(primary.path)
          if (s) target = s.branch
        } catch { /* ignore */ }
      }
      if (!wt.branch || !target) {
        setError(
          !wt.branch
            ? 'No branch on this worktree to merge.'
            : 'Could not resolve the primary branch — open Source Control once to refresh.',
        )
        return
      }
      const ok = window.confirm(
        `Merge ${wt.branch} → ${target}?\n\nThis will fetch, check out ${target}, and merge ${wt.branch} into it.`,
      )
      if (!ok) return
      try {
        const result = await window.electronAPI.gitWorktreeMergeTo(rootPath, wt.branch, target)
        if (!result.ok) {
          setError(`Merge ${wt.branch} → ${target}: ${result.message}`)
        } else {
          setError(null)
          void reconcile()
        }
      } catch (err: any) {
        setError(err?.message || 'Merge failed')
      }
    },
    [rootPath, primaryBranch, selectedWorkspaceId, reconcile],
  )

  const handlePrune = useCallback(async () => {
    if (!rootPath) return
    try {
      await window.electronAPI.gitWorktreePrune(rootPath)
      void reconcile()
    } catch (err: any) {
      setError(err?.message || 'Prune failed')
    }
  }, [rootPath, reconcile])

  // ---------------------------------------------------------------------------
  // Derived view state
  // ---------------------------------------------------------------------------

  const worktrees = workspace?.worktrees ?? []
  const gitPaths = useMemo(() => new Set(gitWorktrees.map((g) => g.path)), [gitWorktrees])
  // Orphans: tracked in workspace state but no longer registered with git.
  const orphans = worktrees.filter((w) => !w.isPrimary && !gitPaths.has(w.path))
  const live = worktrees.filter((w) => w.isPrimary || gitPaths.has(w.path))

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!rootPath) {
    return (
      <div className="flex flex-col h-full">
        <SidebarSectionHeader title="Parallel Work" />
        <div className="flex flex-col items-center justify-center flex-1 text-muted text-xs gap-2 p-4">
          <ArrowsSplit size={20} className="opacity-40" />
          <span>Open a folder to use parallel branches.</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <SidebarSectionHeader
        title="Parallel Work"
        actions={
          <>
            <SidebarHeaderButton
              onClick={() => setCreating(true)}
              title="New parallel branch"
            >
              <Plus size={14} />
            </SidebarHeaderButton>
            <SidebarHeaderButton
              onClick={() => reconcile()}
              spinning={refreshing}
              title="Refresh"
            >
              <ArrowClockwise size={14} />
            </SidebarHeaderButton>
          </>
        }
      />

      {creating && (
        <CreateForm
          defaultBaseBranch={primaryBranch}
          rootPath={rootPath}
          onSubmit={handleCreate}
          onCancel={() => setCreating(false)}
        />
      )}

      {error && (
        <div className="px-3 py-1.5 text-[10px] text-red-400/80 bg-red-500/[0.08] border-b border-subtle">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-1 flex flex-col">
        {live.length === 0 && !creating && (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-muted text-[11px] gap-2 text-center">
            <ArrowsSplit size={20} className="opacity-40" />
            <span>No parallel branches yet.</span>
            <span className="opacity-60">
              Spin one up to work on a separate branch without losing your current state.
            </span>
          </div>
        )}

        {live.map((wt) => (
          <WorktreeCard
            key={wt.id}
            worktree={wt}
            status={statusByPath[wt.path]}
            onOpenTerminal={() => {
              if (!selectedWorkspaceId) return
              const panelId = createTerminal(selectedWorkspaceId, undefined, undefined, undefined, wt.path)
              useAppStore.getState().setPanelWorktreeId(selectedWorkspaceId, panelId, wt.id)
            }}
            onOpenAgent={() => {
              if (!selectedWorkspaceId) return
              const panelId = createAgent(selectedWorkspaceId)
              useAppStore.getState().setPanelWorktreeId(selectedWorkspaceId, panelId, wt.id)
            }}
            onMerge={wt.isPrimary ? undefined : () => handleMergeBack(wt)}
            onDelete={wt.isPrimary ? undefined : () => handleDelete(wt)}
          />
        ))}

        {orphans.length > 0 && (
          <div className="mt-2 pt-2 border-t border-subtle flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5 px-1 text-[10px] text-muted">
              <Warning size={11} />
              <span className="flex-1">Orphaned ({orphans.length})</span>
              <button
                onClick={handlePrune}
                className="px-1.5 py-0.5 rounded hover:bg-hover text-secondary hover:text-primary"
                title="Prune missing worktrees"
              >
                Prune
              </button>
            </div>
            {orphans.map((wt) => (
              <WorktreeCard
                key={wt.id}
                worktree={wt}
                onOpenTerminal={() => {}}
                onOpenAgent={() => {}}
                onDelete={() => {
                  if (selectedWorkspaceId) removeWorktree(selectedWorkspaceId, wt.id)
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
