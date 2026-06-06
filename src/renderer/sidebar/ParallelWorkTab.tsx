// =============================================================================
// ParallelWorkTab — first-class sidebar tab that promotes git worktrees from
// a hidden, advanced primitive to a user-friendly "parallel branch" concept.
//
// Design goal: let people work on several things at once without ever needing
// to know what a worktree is. The UI speaks plain language ("2 to publish",
// "in sync", "Discard this work"), launches terminals/agents by click *or* by
// dragging a chip onto the canvas, and folds publish / pull-request / merge
// into a single overflow menu per card.
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
  CaretRight,
  CaretDown,
  DotsThree,
  GitPullRequest,
} from '@phosphor-icons/react'
import { useAppStore, pickWorktreeColor, WORKTREE_COLOR_PALETTE } from '../stores/appStore'
import { useGitStatusSnapshot, gitStatusStore } from '../stores/gitStatusStore'
import { useWorktrees, type JoinedWorktree } from '../stores/useWorktrees'
import { useUIStore } from '../stores/uiStore'
import { SidebarSectionHeader, SidebarHeaderButton } from './SidebarSectionHeader'
import type { WorktreeMeta } from '../../shared/types'
import type { NativeContextMenuItem } from '../../shared/electron-api'
import log from '../lib/logger'
import { errorMessage } from '../lib/errorMessage'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Worktrees live inside the project at <repo>/.cate/worktrees/<branch-slug>.
 *  The worktree-add handler drops a `*` .gitignore in that folder so the
 *  checkouts never show up as untracked noise in the parent repo. */
function worktreePathFor(repoRoot: string, branch: string): string {
  const trimmed = repoRoot.replace(/[/\\]+$/, '')
  const slug = branch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'wt'
  return `${trimmed}/.cate/worktrees/${slug}`
}

/** Turn free-text ("fix the login bug") into a valid branch name
 *  ("fix-the-login-bug") while leaving deliberate branch paths ("feat/x") be. */
function toBranchName(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w./-]+/g, '')
    .replace(/^-+|-+$/g, '')
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

interface PrStatus {
  number: number
  state: string
  url: string
  isDraft: boolean
}

interface PrListItem {
  number: number
  title: string
  headRefName: string
  author: string
  isFork: boolean
}

// ---------------------------------------------------------------------------
// Plain-language status
// ---------------------------------------------------------------------------

function humanStatus(
  status: WorktreeStatus | undefined,
  primaryLabel: string,
): { text: string; tone: string } | null {
  if (!status) return null
  const fileCount = status.staged + status.unstaged + status.untracked
  if (status.dirty) {
    const text = fileCount > 0
      ? `${fileCount} unsaved ${fileCount === 1 ? 'change' : 'changes'}`
      : 'unsaved changes'
    return { text, tone: 'text-yellow-400/80' }
  }
  if (status.ahead > 0 && status.behind > 0) {
    return { text: `${status.ahead} to publish · ${status.behind} behind`, tone: 'text-blue-400/70' }
  }
  if (status.ahead > 0) {
    return { text: `${status.ahead} to publish`, tone: 'text-green-400/70' }
  }
  if (status.behind > 0) {
    return { text: `${status.behind} behind ${primaryLabel}`, tone: 'text-blue-400/70' }
  }
  return { text: 'in sync', tone: 'text-muted' }
}

const PrPill: React.FC<{ pr: PrStatus; onClick: () => void }> = ({ pr, onClick }) => {
  const label = pr.isDraft ? 'draft' : pr.state.toLowerCase()
  const tone =
    pr.state === 'MERGED'
      ? 'text-violet-400/80'
      : pr.state === 'CLOSED'
        ? 'text-red-400/70'
        : 'text-green-400/80'
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      title="Open pull request on GitHub"
      className={`inline-flex items-center gap-1 text-[10px] leading-none ${tone} hover:underline`}
    >
      <GitPullRequest size={11} weight="bold" />
      <span className="tabular-nums">#{pr.number}</span>
      <span>{label}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Create form — "what are you working on?"
// ---------------------------------------------------------------------------

const CreateForm: React.FC<{
  onSubmit: (name: string, baseRef?: string) => Promise<void>
  onCheckoutPr: (pr: PrListItem) => Promise<void>
  onCancel: () => void
  defaultBaseBranch: string
  rootPath: string
}> = ({ onSubmit, onCheckoutPr, onCancel, defaultBaseBranch, rootPath }) => {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [baseRef, setBaseRef] = useState<string>('')
  const [branches, setBranches] = useState<Array<{ name: string; isRemote: boolean }>>([])
  const [prs, setPrs] = useState<PrListItem[]>([])
  const [selectedPr, setSelectedPr] = useState<PrListItem | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [localExpanded, setLocalExpanded] = useState(true)
  const [remoteExpanded, setRemoteExpanded] = useState(false)
  const [prsExpanded, setPrsExpanded] = useState(true)
  const [filter, setFilter] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    let cancelled = false
    window.electronAPI.gitPrList(rootPath).then((list) => {
      if (!cancelled) setPrs(list)
    }).catch(() => {})
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

  const filteredPrs = useMemo(() => {
    const q = filter.toLowerCase()
    if (!q) return prs
    return prs.filter((p) =>
      `#${p.number} ${p.title} ${p.headRefName} ${p.author}`.toLowerCase().includes(q),
    )
  }, [prs, filter])

  const canSubmit = selectedPr ? true : !!name.trim()

  const submit = useCallback(async () => {
    if (busy || !canSubmit) return
    setBusy(true)
    setError(null)
    try {
      if (selectedPr) {
        await onCheckoutPr(selectedPr)
      } else {
        await onSubmit(name.trim(), baseRef || undefined)
      }
    } catch (err: any) {
      setError(errorMessage(err, 'Failed to create'))
    } finally {
      setBusy(false)
    }
  }, [busy, canSubmit, selectedPr, name, baseRef, onSubmit, onCheckoutPr])

  return (
    <div className="px-1 pt-1">
      <div className="flex items-center gap-1 h-8 px-1.5 rounded-md bg-surface-3 text-secondary focus-within:bg-surface-4 transition-colors">
        {selectedPr ? (
          <GitPullRequest size={14} weight="bold" className="flex-shrink-0 opacity-60 ml-1" />
        ) : (
          <GitBranch size={14} weight="bold" className="flex-shrink-0 opacity-60 ml-1" />
        )}
        {selectedPr ? (
          <div className="flex-1 min-w-0 flex items-center gap-1.5 text-[14px] text-primary">
            <span className="text-muted tabular-nums flex-shrink-0">#{selectedPr.number}</span>
            <span className="truncate">{selectedPr.title}</span>
          </div>
        ) : (
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') onCancel()
            }}
            placeholder="What are you working on?"
            disabled={busy}
            className="flex-1 min-w-0 text-[14px] bg-transparent outline-none text-primary placeholder:text-muted"
          />
        )}
        <button
          onClick={submit}
          disabled={!canSubmit || busy}
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-muted hover:text-primary hover:bg-hover disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          title={selectedPr ? 'Check out pull request' : 'Start'}
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
          {selectedPr ? 'reviewing' : 'based on'}
          <span className="text-secondary ml-0.5 truncate max-w-[160px] inline-block align-bottom">
            {selectedPr ? `#${selectedPr.number} ${selectedPr.headRefName}` : displayBase}
          </span>
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
                placeholder="Filter branches & PRs…"
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
                      onClick={() => { setBaseRef(b.name); setSelectedPr(null); setPickerOpen(false) }}
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
                      onClick={() => { setBaseRef(b.name); setSelectedPr(null); setPickerOpen(false) }}
                      className={`w-full text-left px-2 py-1 text-[12px] truncate hover:bg-hover transition-colors opacity-70 ${
                        b.name === (baseRef || defaultBaseBranch) ? 'text-primary bg-hover' : 'text-secondary'
                      }`}
                    >
                      {b.name}
                    </button>
                  ))}
                </div>
              )}
              {filteredPrs.length > 0 && (
                <div>
                  <button
                    onClick={() => setPrsExpanded((v) => !v)}
                    className={`w-full flex items-center gap-1 px-2 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-muted select-none hover:text-secondary transition-colors ${localBranches.length > 0 || remoteBranches.length > 0 ? 'border-t border-subtle mt-1' : ''}`}
                  >
                    <CaretRight size={8} className={`flex-shrink-0 transition-transform ${prsExpanded ? 'rotate-90' : ''}`} />
                    Pull requests
                    <span className="text-muted/60 normal-case tracking-normal">({filteredPrs.length})</span>
                  </button>
                  {prsExpanded && filteredPrs.map((p) => (
                    <button
                      key={p.number}
                      onClick={() => { setSelectedPr(p); setPickerOpen(false) }}
                      title={p.isFork ? `${p.headRefName}, fork by ${p.author}` : p.headRefName}
                      className={`w-full flex items-center gap-1.5 px-2 py-1 text-[12px] hover:bg-hover transition-colors ${
                        selectedPr?.number === p.number ? 'bg-hover' : ''
                      }`}
                    >
                      <GitPullRequest size={11} weight="bold" className="flex-shrink-0 opacity-50" />
                      <span className="text-muted tabular-nums flex-shrink-0">#{p.number}</span>
                      <span className="truncate flex-1 text-left text-secondary">{p.title}</span>
                      {p.isFork && (
                        <span className="flex-shrink-0 text-[9px] text-muted truncate max-w-[80px]">{p.author}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {localBranches.length === 0 && remoteBranches.length === 0 && filteredPrs.length === 0 && (
                <div className="px-2 py-2 text-[11px] text-muted text-center">No matches</div>
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
// Spawn action — a compact row icon. Click to open here, or drag onto the
// canvas to drop a terminal/agent exactly where you want it.
// ---------------------------------------------------------------------------

const SpawnAction: React.FC<{
  icon: React.ReactNode
  title: string
  panelType: 'terminal' | 'agent'
  cwd: string
  worktreeId: string
  onLaunch: () => void
}> = ({ icon, title, panelType, cwd, worktreeId, onLaunch }) => (
  <div
    role="button"
    draggable
    onDragStart={(e) => {
      e.dataTransfer.effectAllowed = 'copy'
      e.dataTransfer.setData(
        'application/cate-spawn',
        JSON.stringify({ panelType, cwd, worktreeId }),
      )
    }}
    onClick={(e) => { e.stopPropagation(); onLaunch() }}
    title={`${title}. Click to open here, or drag onto the canvas.`}
    className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-muted hover:text-primary hover:bg-surface-4 cursor-grab active:cursor-grabbing transition-colors"
  >
    {icon}
  </div>
)

// ---------------------------------------------------------------------------
// Worktree card
// ---------------------------------------------------------------------------

interface CardCallbacks {
  onLaunch: (type: 'terminal' | 'agent') => void
  onPublish: () => void
  onCreatePR: () => void
  onUpdateFromMain: () => void
  onMerge: () => void
  onDelete: () => void
  onReveal: () => void
  onRename: (label: string | undefined) => void
  onRecolor: (color: string) => void
  onOpenPr: (url: string) => void
}

const WorktreeCard: React.FC<{
  worktree: JoinedWorktree
  status?: WorktreeStatus
  pr?: PrStatus
  primaryLabel: string
  cb: CardCallbacks
}> = ({ worktree, status, pr, primaryLabel, cb }) => {
  const isPrimary = !!worktree.isPrimary
  const label = worktree.label || worktree.branch || (isPrimary ? 'main' : '(detached)')
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(label)
  const [recoloring, setRecoloring] = useState(false)
  const st = humanStatus(status, primaryLabel)

  // Worktree focus lens: hover highlights this branch's nodes on the canvas;
  // clicking the row locks the lens (and frames the camera). Clicking again
  // (or empty canvas) clears it.
  const setHoveredWorktree = useUIStore((s) => s.setHoveredWorktree)
  const focusWorktree = useUIStore((s) => s.focusWorktree)
  const focusedWorktreeId = useUIStore((s) => s.focusedWorktreeId)
  const isLensFocused = focusedWorktreeId === worktree.id
  useEffect(() => () => setHoveredWorktree(null), [setHoveredWorktree])

  const handleRowClick = useCallback(
    (e: React.MouseEvent) => {
      // Ignore clicks on the inline buttons / rename input.
      if ((e.target as HTMLElement).closest('button, input')) return
      focusWorktree(isLensFocused ? null : worktree.id)
    },
    [focusWorktree, isLensFocused, worktree.id],
  )

  const commitRename = useCallback(() => {
    setRenaming(false)
    const next = renameValue.trim()
    if (next !== label) cb.onRename(next || undefined)
  }, [renameValue, label, cb])

  const handleMenu = useCallback(async () => {
    const items: NativeContextMenuItem[] = [
      { id: 'publish', label: 'Publish branch' },
      { id: 'pr', label: pr ? 'Open pull request' : 'Create pull request' },
    ]
    if (!isPrimary) {
      items.push({ id: 'update', label: `Update from ${primaryLabel}` })
      items.push({ id: 'merge', label: `Merge into ${primaryLabel}` })
    }
    items.push({ type: 'separator' })
    items.push({ id: 'rename', label: 'Rename…' })
    items.push({ id: 'color', label: 'Change color…' })
    items.push({ id: 'reveal', label: 'Reveal in Finder' })
    if (!isPrimary) {
      items.push({ type: 'separator' })
      items.push({ id: 'delete', label: 'Discard this work…' })
    }
    const choice = await window.electronAPI.showContextMenu(items)
    switch (choice) {
      case 'publish': cb.onPublish(); break
      case 'pr': if (pr) cb.onOpenPr(pr.url); else cb.onCreatePR(); break
      case 'update': cb.onUpdateFromMain(); break
      case 'merge': cb.onMerge(); break
      case 'reveal': cb.onReveal(); break
      case 'rename': setRenameValue(label); setRenaming(true); break
      case 'color': setRecoloring((v) => !v); break
      case 'delete': cb.onDelete(); break
    }
  }, [pr, isPrimary, primaryLabel, label, cb])

  return (
    <div
      className="group/row"
      title={worktree.path}
      onMouseEnter={() => setHoveredWorktree(worktree.id)}
      onMouseLeave={() => setHoveredWorktree(null)}
    >
      <div
        className="flex items-center gap-1.5 h-8 px-2 hover:bg-hover transition-colors cursor-pointer"
        style={isLensFocused ? { backgroundColor: `color-mix(in srgb, ${worktree.color} 14%, transparent)` } : undefined}
        onClick={handleRowClick}
        onContextMenu={(e) => { e.preventDefault(); void handleMenu() }}
      >
        <button
          onClick={() => setRecoloring((v) => !v)}
          title="Change color"
          className="flex-shrink-0 w-4 h-4 flex items-center justify-center rounded-full hover:bg-surface-4"
        >
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: worktree.color }} />
        </button>

        {renaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setRenaming(false)
            }}
            onBlur={commitRename}
            className="flex-1 min-w-0 text-sm bg-surface-5 rounded px-1 border border-blue-500/50 outline-none text-primary"
          />
        ) : (
          <span
            className="flex-1 min-w-0 text-sm leading-none truncate text-secondary"
            onDoubleClick={() => { setRenameValue(label); setRenaming(true) }}
          >
            {label}
          </span>
        )}

        {isPrimary && (
          <span className="flex-shrink-0 text-[9px] leading-none uppercase tracking-wide text-muted">base</span>
        )}

        {/* Status / PR — yields to the action icons on hover. */}
        {!renaming && (pr || st) && (
          <span className="flex-shrink-0 flex items-center group-hover/row:hidden">
            {pr ? (
              <PrPill pr={pr} onClick={() => cb.onOpenPr(pr.url)} />
            ) : st ? (
              <span className={`text-[10px] leading-none ${st.tone}`}>{st.text}</span>
            ) : null}
          </span>
        )}

        {/* Inline actions — revealed on hover, like the file explorer. */}
        {!renaming && (
          <div className="hidden group-hover/row:flex items-center gap-0.5 flex-shrink-0">
            <SpawnAction
              icon={<TerminalIcon size={14} weight="bold" />}
              title="Terminal"
              panelType="terminal"
              cwd={worktree.path}
              worktreeId={worktree.id}
              onLaunch={() => cb.onLaunch('terminal')}
            />
            <SpawnAction
              icon={<CateLogo size={14} />}
              title="Agent"
              panelType="agent"
              cwd={worktree.path}
              worktreeId={worktree.id}
              onLaunch={() => cb.onLaunch('agent')}
            />
            <button
              onClick={handleMenu}
              title="More actions"
              className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-muted hover:text-primary hover:bg-surface-4 transition-colors"
            >
              <DotsThree size={16} weight="bold" />
            </button>
          </div>
        )}
      </div>

      {recoloring && (
        <div className="flex items-center gap-1.5 flex-wrap pl-8 pr-2 pb-1.5 pt-0.5">
          {WORKTREE_COLOR_PALETTE.map((c) => (
            <button
              key={c}
              onClick={() => { cb.onRecolor(c); setRecoloring(false) }}
              className="w-4 h-4 rounded-full transition-transform hover:scale-110"
              style={{
                backgroundColor: c,
                outline: c === worktree.color ? '2px solid var(--text-primary)' : 'none',
                outlineOffset: 1,
              }}
              title={c}
            />
          ))}
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
  const ensurePrimaryWorktree = useAppStore((s) => s.ensurePrimaryWorktree)
  const upsertWorktree = useAppStore((s) => s.upsertWorktree)
  const removeWorktree = useAppStore((s) => s.removeWorktree)
  const setWorktreeColor = useAppStore((s) => s.setWorktreeColor)
  const setWorktreeLabel = useAppStore((s) => s.setWorktreeLabel)
  const createTerminal = useAppStore((s) => s.createTerminal)
  const createAgent = useAppStore((s) => s.createAgent)
  const addAdditionalRoot = useAppStore((s) => s.addAdditionalRoot)

  const [statusByPath, setStatusByPath] = useState<Record<string, WorktreeStatus>>({})
  const [prByPath, setPrByPath] = useState<Record<string, PrStatus>>({})
  const [prNonce, setPrNonce] = useState(0)
  const [creating, setCreating] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // The live worktree list, repo flag and per-worktree status now come from the
  // single per-workspace gitStatusStore (one fsWatch + focus + branch-update
  // loop) instead of this tab's own gitWorktreeList fetch + focus/branch loops.
  const snapshot = useGitStatusSnapshot(rootPath)
  const isRepo: boolean | null = rootPath ? snapshot.isRepo : null
  const primaryBranch = useMemo(
    () => snapshot.worktrees.find((w) => w.isCurrent)?.branch ?? '',
    [snapshot.worktrees],
  )

  // ---------------------------------------------------------------------------
  // Load + sync. `reconcile` now just re-arms the shared git store; the metadata
  // sync + per-worktree status fetch run reactively off the snapshot below.
  // ---------------------------------------------------------------------------

  const reconcile = useCallback(async () => {
    if (!rootPath || !selectedWorkspaceId) return
    setError(null)
    gitStatusStore.refresh(rootPath)
  }, [rootPath, selectedWorkspaceId])

  // Reconcile persisted worktree metadata against the live git list (the single
  // source for path/branch/isPrimary) and fetch each worktree's status. Runs
  // whenever the shared snapshot changes.
  useEffect(() => {
    if (!rootPath || !selectedWorkspaceId || !snapshot.isRepo) return
    const list = snapshot.worktrees
    let cancelled = false
    setRefreshing(true)

    ensurePrimaryWorktree(selectedWorkspaceId)
    const ws = useAppStore.getState().workspaces.find((w) => w.id === selectedWorkspaceId)
    if (ws) {
      const existing = ws.worktrees ?? []
      // Persist only UI metadata (id/color) for any git worktree we haven't seen
      // before; branch/isPrimary/isCurrent come from live git via useWorktrees.
      for (const g of list) {
        if (existing.some((w) => w.path === g.path)) continue
        upsertWorktree(selectedWorkspaceId, {
          id: `wt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          path: g.path,
          color: pickWorktreeColor(existing),
        })
      }
    }

    void (async () => {
      try {
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
        if (cancelled) return
        const next: Record<string, WorktreeStatus> = {}
        for (const e of statusEntries) if (e) next[e[0]] = e[1]
        setStatusByPath(next)
      } catch (err: any) {
        if (!cancelled) {
          log.warn('[parallel-work] status fetch failed', err)
          setError(errorMessage(err, 'Failed to load parallel branches'))
        }
      } finally {
        if (!cancelled) setRefreshing(false)
      }
    })()

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, selectedWorkspaceId, snapshot.revision, snapshot.isRepo, ensurePrimaryWorktree, upsertWorktree])

  // ---------------------------------------------------------------------------
  // Derived view state
  // ---------------------------------------------------------------------------

  // One joined view: live git facts (path/branch/isPrimary/isCurrent) from the
  // shared gitStatusStore joined with the persisted UI metadata (id/color/label).
  // `live` are present in git; `orphans` are persisted metadata git no longer lists.
  const joined = useWorktrees(rootPath, selectedWorkspaceId)
  const live = useMemo(() => joined.filter((w) => !w.isOrphan), [joined])
  const orphans = useMemo(() => joined.filter((w) => w.isOrphan), [joined])

  const primaryLabel = useMemo(() => {
    const primary = joined.find((w) => w.isPrimary)
    return primaryBranch || primary?.branch || 'main'
  }, [joined, primaryBranch])

  // PR status — fetched only when the branch set changes (or after a PR action),
  // not on every window focus, since each lookup shells out to `gh`.
  const prKey = useMemo(
    () => live.filter((w) => !w.isPrimary && w.branch).map((w) => `${w.path}:${w.branch}`).join('|'),
    [live],
  )
  useEffect(() => {
    let cancelled = false
    const targets = live.filter((w) => !w.isPrimary && w.branch)
    if (targets.length === 0) { setPrByPath({}); return }
    void (async () => {
      const entries = await Promise.all(
        targets.map(async (w) => {
          try {
            const pr = await window.electronAPI.gitPrStatus(w.path, w.branch)
            return pr ? ([w.path, pr] as const) : null
          } catch {
            return null
          }
        }),
      )
      if (cancelled) return
      const next: Record<string, PrStatus> = {}
      for (const e of entries) if (e) next[e[0]] = e[1]
      setPrByPath(next)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prKey, prNonce])

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const handleCreate = useCallback(
    async (rawName: string, baseRef?: string) => {
      if (!rootPath || !selectedWorkspaceId) return
      const branch = toBranchName(rawName)
      if (!branch) throw new Error('Please enter a name')
      const targetPath = worktreePathFor(rootPath, branch)
      await window.electronAPI.gitWorktreeAdd(rootPath, branch, targetPath, {
        createBranch: true,
        baseRef,
      })

      const ws = useAppStore.getState().workspaces.find((w) => w.id === selectedWorkspaceId)
      const meta: WorktreeMeta = {
        id: `wt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        path: targetPath,
        // Keep the friendly name when it differs from the slugged branch.
        label: rawName.trim() !== branch ? rawName.trim() : undefined,
        color: pickWorktreeColor(ws?.worktrees ?? []),
      }
      upsertWorktree(selectedWorkspaceId, meta)
      addAdditionalRoot(selectedWorkspaceId, targetPath)

      setCreating(false)
      void reconcile()
    },
    [rootPath, selectedWorkspaceId, upsertWorktree, addAdditionalRoot, reconcile],
  )

  const handleCheckoutPr = useCallback(
    async (pr: PrListItem) => {
      if (!rootPath || !selectedWorkspaceId) return
      // Slug includes the PR number so contributors' identically-named branches
      // never collide on disk.
      const targetPath = worktreePathFor(rootPath, `pr-${pr.number}-${pr.headRefName}`)
      const res = await window.electronAPI.gitWorktreeAddFromPr(rootPath, pr.number, targetPath)

      const ws = useAppStore.getState().workspaces.find((w) => w.id === selectedWorkspaceId)
      const meta: WorktreeMeta = {
        id: `wt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        path: res.path,
        label: `#${pr.number} ${pr.headRefName}`,
        color: pickWorktreeColor(ws?.worktrees ?? []),
      }
      upsertWorktree(selectedWorkspaceId, meta)
      addAdditionalRoot(selectedWorkspaceId, res.path)

      setCreating(false)
      void reconcile()
    },
    [rootPath, selectedWorkspaceId, upsertWorktree, addAdditionalRoot, reconcile],
  )

  const handleLaunch = useCallback(
    (wt: JoinedWorktree, type: 'terminal' | 'agent') => {
      if (!selectedWorkspaceId) return
      const panelId =
        type === 'terminal'
          ? createTerminal(selectedWorkspaceId, undefined, undefined, undefined, wt.path)
          : createAgent(selectedWorkspaceId)
      if (panelId) useAppStore.getState().setPanelWorktreeId(selectedWorkspaceId, panelId, wt.id)
    },
    [selectedWorkspaceId, createTerminal, createAgent],
  )

  const handleDelete = useCallback(
    async (wt: JoinedWorktree) => {
      if (!rootPath || !selectedWorkspaceId || wt.isPrimary) return
      const label = wt.label || wt.branch || wt.path
      const status = statusByPath[wt.path]
      const dirty = !!status?.dirty
      const branchAhead = (status?.ahead ?? 0) > 0
      const ok = window.confirm(
        `Discard “${label}”?\n\n` +
          `This deletes the parallel branch and everything in it.\n` +
          (dirty ? '\nWARNING: unsaved changes here will be lost.' : '') +
          (branchAhead ? `\nWARNING: ${status?.ahead} unpublished commit(s) will be lost.` : ''),
      )
      if (!ok) return
      try {
        await window.electronAPI.gitWorktreeRemove(rootPath, wt.path, { force: dirty })
        if (wt.branch) {
          try {
            await window.electronAPI.gitBranchDelete(rootPath, wt.branch, true)
          } catch (err: any) {
            setError(`Removed, but branch ${wt.branch} could not be deleted: ${errorMessage(err)}`)
          }
        }
        removeWorktree(selectedWorkspaceId, wt.id)
        void reconcile()
      } catch (err: any) {
        setError(errorMessage(err, 'Discard failed'))
      }
    },
    [rootPath, selectedWorkspaceId, removeWorktree, reconcile, statusByPath],
  )

  const handleMerge = useCallback(
    async (wt: JoinedWorktree) => {
      if (!rootPath || wt.isPrimary) return
      const target = primaryLabel
      if (!wt.branch || !target) {
        setError('Could not resolve the base branch. Open Source Control once to refresh.')
        return
      }
      const ok = window.confirm(`Merge ${wt.branch} into ${target}?`)
      if (!ok) return
      try {
        const result = await window.electronAPI.gitWorktreeMergeTo(rootPath, wt.branch, target)
        if (!result.ok) {
          setError(`Merge ${wt.branch} → ${target}: ${errorMessage(result.message)}`)
        } else {
          setError(null)
          setNotice(`Merged ${wt.branch} into ${target}`)
          void reconcile()
        }
      } catch (err: any) {
        setError(errorMessage(err, 'Merge failed'))
      }
    },
    [rootPath, primaryLabel, reconcile],
  )

  const handleUpdateFromMain = useCallback(
    async (wt: JoinedWorktree) => {
      if (wt.isPrimary || !wt.branch) return
      const target = primaryLabel
      try {
        const result = await window.electronAPI.gitWorktreeUpdateFrom(wt.path, target)
        if (!result.ok) {
          setError(
            result.conflict
              ? `Conflicts updating from ${target}. Open a terminal here to resolve them.`
              : `Update from ${target}: ${errorMessage(result.message)}`,
          )
        } else {
          setError(null)
          setNotice(`Updated ${wt.branch} from ${target}`)
          void reconcile()
        }
      } catch (err: any) {
        setError(errorMessage(err, 'Update failed'))
      }
    },
    [primaryLabel, reconcile],
  )

  const handlePublish = useCallback(async (wt: JoinedWorktree) => {
    if (!wt.branch) return
    setError(null)
    setNotice(`Publishing ${wt.branch}…`)
    try {
      await window.electronAPI.gitPush(wt.path, 'origin', wt.branch)
      setNotice(`Published ${wt.branch}`)
      void reconcile()
    } catch (err: any) {
      setNotice(null)
      setError(`Publish failed: ${errorMessage(err)}`)
    }
  }, [reconcile])

  const handleCreatePR = useCallback(async (wt: JoinedWorktree) => {
    if (!wt.branch) return
    setError(null)
    setNotice(`Opening a pull request for ${wt.branch}…`)
    try {
      const res = await window.electronAPI.gitCreatePR(wt.path, wt.branch)
      if (res.ok) {
        window.electronAPI.openExternalUrl(res.url)
        setNotice(
          res.created
            ? `Opened a pull request for ${wt.branch}`
            : res.fallback
              ? 'Opened GitHub to finish the pull request'
              : `Pull request for ${wt.branch} already exists`,
        )
        setPrNonce((n) => n + 1)
      } else {
        setNotice(null)
        setError(errorMessage(res.message))
      }
    } catch (err: any) {
      setNotice(null)
      setError(`Could not create pull request: ${errorMessage(err)}`)
    }
  }, [])

  const handleInit = useCallback(async () => {
    if (!rootPath) return
    setError(null)
    try {
      await window.electronAPI.gitInit(rootPath)
      await reconcile()
    } catch (err: any) {
      setError(`Could not initialize git: ${errorMessage(err)}`)
    }
  }, [rootPath, reconcile])

  const handlePrune = useCallback(async () => {
    if (!rootPath || !selectedWorkspaceId) return
    try {
      await window.electronAPI.gitWorktreePrune(rootPath)
      // `git worktree prune` only cleans entries git still tracks. The orphans
      // shown here are store metadata for worktrees git no longer lists, so
      // prune is a no-op for them — drop those stale entries from the store
      // explicitly, otherwise "Clean up" appears to do nothing.
      const list = await window.electronAPI.gitWorktreeList(rootPath)
      const livePaths = new Set(list.map((g) => g.path))
      const ws = useAppStore.getState().workspaces.find((w) => w.id === selectedWorkspaceId)
      for (const w of ws?.worktrees ?? []) {
        // Never prune the primary record (keyed by the workspace rootPath).
        if (w.path !== rootPath && !livePaths.has(w.path)) removeWorktree(selectedWorkspaceId, w.id)
      }
      void reconcile()
    } catch (err: any) {
      setError(errorMessage(err, 'Cleanup failed'))
    }
  }, [rootPath, selectedWorkspaceId, removeWorktree, reconcile])

  const makeCallbacks = useCallback(
    (wt: JoinedWorktree): CardCallbacks => ({
      onLaunch: (type) => handleLaunch(wt, type),
      onPublish: () => handlePublish(wt),
      onCreatePR: () => handleCreatePR(wt),
      onUpdateFromMain: () => handleUpdateFromMain(wt),
      onMerge: () => handleMerge(wt),
      onDelete: () => handleDelete(wt),
      onReveal: () => window.electronAPI.shellShowInFolder(wt.path),
      onRename: (label) => selectedWorkspaceId && setWorktreeLabel(selectedWorkspaceId, wt.id, label),
      onRecolor: (color) => selectedWorkspaceId && setWorktreeColor(selectedWorkspaceId, wt.id, color),
      onOpenPr: (url) => window.electronAPI.openExternalUrl(url),
    }),
    [
      handleLaunch, handlePublish, handleCreatePR, handleUpdateFromMain, handleMerge,
      handleDelete, selectedWorkspaceId, setWorktreeLabel, setWorktreeColor,
    ],
  )

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!rootPath) {
    return (
      <div className="flex flex-col h-full">
        <SidebarSectionHeader title="Parallel Work" />
        <div className="flex flex-col items-center justify-center flex-1 text-muted text-xs gap-2 p-4">
          <ArrowsSplit size={20} className="opacity-40" />
          <span>Open a folder to work in parallel.</span>
        </div>
      </div>
    )
  }

  if (isRepo === false) {
    return (
      <div className="flex flex-col h-full">
        <SidebarSectionHeader title="Parallel Work" />
        <div className="flex flex-col items-center justify-center flex-1 text-muted text-[11px] gap-3 p-6 text-center">
          <ArrowsSplit size={20} className="opacity-40" />
          <span className="opacity-80">
            Parallel branches need a git repository.
            <br />
            This folder isn’t one yet.
          </span>
          <button
            onClick={handleInit}
            className="px-3 py-1.5 rounded-md bg-surface-3 hover:bg-surface-4 text-secondary hover:text-primary text-[12px] transition-colors"
          >
            Initialize git repository
          </button>
          {error && <span className="text-red-400/80 px-2">{error}</span>}
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
              title="Start something new"
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
          onCheckoutPr={handleCheckoutPr}
          onCancel={() => setCreating(false)}
        />
      )}

      {error && (
        <div className="px-3 py-1.5 text-[10px] text-red-400/80 bg-red-500/[0.08] border-b border-subtle flex items-start gap-1.5">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="opacity-60 hover:opacity-100"><X size={11} /></button>
        </div>
      )}
      {notice && !error && (
        <div className="px-3 py-1.5 text-[10px] text-green-400/80 bg-green-500/[0.07] border-b border-subtle flex items-start gap-1.5">
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="opacity-60 hover:opacity-100"><X size={11} /></button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-1 flex flex-col">
        {live.length === 0 && !creating && (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-muted text-[11px] gap-2 text-center">
            <ArrowsSplit size={20} className="opacity-40" />
            <span>No parallel branches yet.</span>
            <span className="opacity-60">
              Start something new to work on a separate branch without losing your current state.
            </span>
          </div>
        )}

        {live.map((wt) => (
          <WorktreeCard
            key={wt.id}
            worktree={wt}
            status={statusByPath[wt.path]}
            pr={prByPath[wt.path]}
            primaryLabel={primaryLabel}
            cb={makeCallbacks(wt)}
          />
        ))}

        {orphans.length > 0 && (
          <div className="mt-2 pt-2 border-t border-subtle flex flex-col gap-1">
            <div className="flex items-center gap-1.5 px-2 text-[10px] text-muted">
              <Warning size={11} />
              <span className="flex-1">Couldn’t find {orphans.length} {orphans.length === 1 ? 'branch' : 'branches'}</span>
              <button
                onClick={handlePrune}
                className="px-1.5 py-0.5 rounded hover:bg-hover text-secondary hover:text-primary"
                title="Remove the missing entries"
              >
                Clean up
              </button>
            </div>
            {orphans.map((wt) => (
              <div key={wt.id} className="flex items-center gap-1.5 h-7 px-2 text-secondary opacity-60">
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: wt.color }} />
                <span className="flex-1 min-w-0 text-[13px] truncate">{wt.label || wt.branch}</span>
                <button
                  onClick={() => selectedWorkspaceId && removeWorktree(selectedWorkspaceId, wt.id)}
                  className="text-[11px] text-muted hover:text-red-400"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
