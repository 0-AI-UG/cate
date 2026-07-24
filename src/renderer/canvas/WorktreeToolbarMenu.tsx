// =============================================================================
// WorktreeToolbarMenu — the canvas toolbar's "parallel worktrees" drop-up, and
// (since the sidebar tab was retired) the single home for worktree tooling.
//
// Per worktree you can: focus its spatial lens (click the row), see its git
// status + PR state + what's already open on the canvas, open a terminal or
// Agent bound to it (click = here, drag = drop anywhere on the canvas),
// recolor / rename inline, reach the full publish / PR / update / merge /
// discard menu via ⋯, start a new worktree, and clean up orphans. Plus a
// git-init path when the folder isn't a repo yet.
//
// All verbs come from the shared useParallelWork hook; the display-only git
// status / PR facts come from useWorktreeStatuses. The heavy subscriptions live
// in the popover body, mounted only while the menu is open.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowsSplit,
  Terminal as TerminalIcon,
  Plus,
  Check,
  DotsThree,
  Warning,
  X,
  GitPullRequest,
  ChatCircle,
  CircleNotch,
} from '@phosphor-icons/react'
import { Tooltip } from '../ui/Tooltip'
import { CreateWorktreeForm } from '../sidebar/CreateWorktreeForm'
import { errorMessage } from '../lib/errorMessage'
import { useWorktrees, type JoinedWorktree } from '../stores/useWorktrees'
import { useGitStatusSnapshot, gitStatusStore } from '../stores/gitStatusStore'
import { useUIStore } from '../stores/uiStore'
import { useAppStore, getWorktreeColorPalette } from '../stores/appStore'
import { useParallelWork, runWorktreeContextMenu, type CardCallbacks } from '../stores/useParallelWork'
import { useWorktreeStatuses, humanStatus, type PrStatus } from '../stores/useWorktreeStatuses'
import type { WorktreePanelType } from '../../shared/panels'

interface WorktreeToolbarMenuProps {
  canvasPanelId: string
  workspaceId: string
  rootPath: string
  tooltipPlacement?: 'top' | 'right'
  menuSide?: 'up' | 'right'
  onOpenChange?: (open: boolean) => void
}

interface PopoverPos {
  left: number
  bottom: number
}

const WorktreeToolbarMenu: React.FC<WorktreeToolbarMenuProps> = ({
  canvasPanelId,
  workspaceId,
  rootPath,
  tooltipPlacement = 'top',
  menuSide = 'up',
  onOpenChange,
}) => {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<PopoverPos | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const focusedWorktreeId = useUIStore((s) => s.focusedWorktreeId)
  const active = open || !!focusedWorktreeId

  // Notify the parent card on real open/close transitions only (not on every
  // render), so an open fly-out keeps the collapsing toolbar expanded.
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  useEffect(() => {
    onOpenChangeRef.current?.(open)
  }, [open])

  const close = useCallback(() => setOpen(false), [])

  const toggle = useCallback(() => {
    if (open) {
      setOpen(false)
      return
    }
    // Anchor to the toolbar card: drop up from it in the horizontal bar, or fly
    // out to its right in the compact vertical bar (growing upward either way).
    const cardEl = btnRef.current?.closest('[data-toolbar-card]') as HTMLElement | null
    const r = (cardEl ?? btnRef.current)?.getBoundingClientRect()
    if (r) {
      setPos(
        menuSide === 'right'
          ? { left: r.right + 8, bottom: window.innerHeight - r.bottom }
          : { left: r.left, bottom: window.innerHeight - r.top + 10 },
      )
    }
    setOpen(true)
  }, [open, menuSide])

  return (
    <>
      <Tooltip label="Parallel worktrees" placement={tooltipPlacement}>
        <button
          ref={btnRef}
          type="button"
          onClick={toggle}
          aria-label="Parallel worktrees"
          style={{ WebkitTapHighlightColor: 'transparent' }}
          className={`w-9 h-9 ${active ? 'bg-hover-strong' : 'bg-transparent'} flex items-center justify-center rounded-full ${active ? 'text-primary' : 'text-secondary'} hover:text-primary hover:bg-hover-strong active:bg-hover-strong active:scale-[0.92] focus:outline-none focus-visible:outline-none transition-all duration-100`}
        >
          <ArrowsSplit size={18} />
        </button>
      </Tooltip>
      {open && pos &&
        createPortal(
          <WorktreeMenuPopover
            pos={pos}
            triggerRef={btnRef}
            canvasPanelId={canvasPanelId}
            workspaceId={workspaceId}
            rootPath={rootPath}
            onClose={close}
          />,
          document.body,
        )}
    </>
  )
}

interface PopoverProps extends WorktreeToolbarMenuProps {
  pos: PopoverPos
  triggerRef: React.RefObject<HTMLButtonElement>
  onClose: () => void
}

const WorktreeMenuPopover: React.FC<PopoverProps> = ({
  pos,
  triggerRef,
  canvasPanelId,
  workspaceId,
  rootPath,
  onClose,
}) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Worktree id with a slow git op (publish / PR / update / merge / discard) in
  // flight — drives that row's inline spinner so the work is visible.
  const [busyId, setBusyId] = useState<string | null>(null)

  const snapshot = useGitStatusSnapshot(rootPath)
  const isRepo = rootPath ? snapshot.isRepo : false
  const joined = useWorktrees(rootPath, workspaceId)
  const live = useMemo(() => joined.filter((w) => !w.isOrphan), [joined])
  const orphans = useMemo(() => joined.filter((w) => w.isOrphan), [joined])
  const primaryBranch = useMemo(
    () => snapshot.worktrees.find((w) => w.isCurrent)?.branch ?? '',
    [snapshot.worktrees],
  )
  const primaryLabel = useMemo(() => {
    const primary = joined.find((w) => w.isPrimary)
    return primaryBranch || primary?.branch || 'main'
  }, [joined, primaryBranch])

  const focusWorktree = useUIStore((s) => s.focusWorktree)
  const focusedWorktreeId = useUIStore((s) => s.focusedWorktreeId)
  const setHoveredWorktree = useUIStore((s) => s.setHoveredWorktree)
  const removeWorktree = useAppStore((s) => s.removeWorktree)

  // What's already open on the canvas, per worktree.
  const panels = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.panels)
  const panelCounts = useMemo(() => {
    const counts: Record<string, { terminals: number; agents: number }> = {}
    for (const p of Object.values(panels ?? {})) {
      if (!p.worktreeId) continue
      const c = counts[p.worktreeId] ?? (counts[p.worktreeId] = { terminals: 0, agents: 0 })
      if (p.type === 'terminal') c.terminals += 1
      else if (p.type === 'agent') c.agents += 1
    }
    return counts
  }, [panels])

  const { statusByPath, prByPath, refreshPr } = useWorktreeStatuses(rootPath, live)
  const { createWorktree, checkoutPr, launchInWorktree, handlePrune, makeCallbacks } = useParallelWork(
    rootPath,
    workspaceId,
    primaryLabel,
    { setError, onPrCreated: refreshPr, setBusy: setBusyId },
  )

  // Close on outside click or Escape. Clicks on the trigger button are ignored
  // so its own onClick can toggle the menu cleanly.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (rootRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, triggerRef])

  // Never leave a worktree highlighted on the canvas once the menu is gone.
  useEffect(() => () => setHoveredWorktree(null), [setHoveredWorktree])

  const launch = useCallback(
    (wt: JoinedWorktree, type: WorktreePanelType) => {
      launchInWorktree(wt, type, { target: 'canvas', canvasPanelId })
      onClose()
    },
    [launchInWorktree, canvasPanelId, onClose],
  )

  const handleInit = useCallback(async () => {
    if (!rootPath) return
    setError(null)
    try {
      await window.electronAPI.gitInit(rootPath, workspaceId)
      gitStatusStore.refresh(rootPath)
    } catch (err: unknown) {
      setError(`Couldn’t initialize git: ${errorMessage(err, 'The operation failed.')}`)
    }
  }, [rootPath, workspaceId])

  return (
    <div
      ref={rootRef}
      className="fixed z-[1000] w-[256px] rounded-2xl border border-subtle shadow-xl py-1.5 text-xs"
      style={{
        left: pos.left,
        bottom: pos.bottom,
        background: 'color-mix(in srgb, var(--surface-0) 80%, transparent)',
        backdropFilter: 'blur(24px) saturate(1.5)',
        WebkitBackdropFilter: 'blur(24px) saturate(1.5)',
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {error && (
        <div className="mx-2.5 mb-1 flex items-start gap-1.5 text-[11px] text-red-400/90">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="opacity-60 hover:opacity-100">
            <X size={11} />
          </button>
        </div>
      )}

      {!isRepo ? (
        <div className="flex flex-col items-center gap-2.5 px-3 py-4 text-center">
          <ArrowsSplit size={18} className="text-muted opacity-50" />
          <span className="text-[11px] text-muted leading-relaxed">
            Parallel branches need a git repository.
            <br />
            This folder isn’t one yet.
          </span>
          <button
            onClick={() => void handleInit()}
            className="px-3 py-1.5 rounded-lg bg-surface-3 hover:bg-surface-4 text-secondary hover:text-primary text-[12px] transition-colors"
          >
            Initialize git repository
          </button>
        </div>
      ) : creating ? (
        <div className="cate-fade-in">
          <CreateWorktreeForm
            defaultBaseBranch={primaryBranch}
            rootPath={rootPath}
            inlinePicker
            flat
            onSubmit={async (name, baseRef) => { await createWorktree(name, baseRef); setCreating(false) }}
            onCheckoutPr={async (pr) => { await checkoutPr(pr); setCreating(false) }}
            onCancel={() => setCreating(false)}
          />
        </div>
      ) : (
        <>
          <div className="px-2.5 pt-0.5 pb-1 text-[11px] font-medium text-muted select-none">
            Parallel work
          </div>
          {live.map((wt) => (
            <WorktreeRow
              key={wt.id}
              wt={wt}
              primaryLabel={primaryLabel}
              focused={focusedWorktreeId === wt.id}
              status={humanStatus(statusByPath[wt.path], primaryLabel)}
              pr={prByPath[wt.path]}
              panels={panelCounts[wt.id]}
              busy={busyId === wt.id}
              cb={makeCallbacks(wt)}
              onFocus={() => focusWorktree(focusedWorktreeId === wt.id ? null : wt.id)}
              onHover={(on) => setHoveredWorktree(on ? wt.id : null)}
              onLaunch={(type) => launch(wt, type)}
            />
          ))}
          <div className="my-1 h-px bg-surface-5 mx-2.5" />
          <button
            onClick={() => setCreating(true)}
            className="mx-1 w-[calc(100%-0.5rem)] flex items-center gap-2 h-[26px] px-1.5 rounded-lg text-[12px] text-secondary hover:text-primary hover:bg-surface-4 transition-colors"
          >
            <Plus size={13} className="flex-shrink-0" />
            <span>Create new worktree…</span>
          </button>

          {orphans.length > 0 && (
            <div className="mt-1 pt-1 border-t border-subtle">
              <div className="flex items-center gap-1.5 px-2.5 py-0.5 text-[10px] text-muted">
                <Warning size={11} className="flex-shrink-0" />
                <span className="flex-1">
                  Couldn’t find {orphans.length} {orphans.length === 1 ? 'branch' : 'branches'}
                </span>
                <button
                  onClick={() => void handlePrune()}
                  className="px-1.5 py-0.5 rounded-lg hover:bg-surface-4 text-secondary hover:text-primary"
                  title="Remove the missing entries"
                >
                  Clean up
                </button>
              </div>
              {orphans.map((wt) => (
                <div
                  key={wt.id}
                  className="mx-1 flex items-center gap-2 h-[24px] px-1.5 rounded-lg text-secondary opacity-60"
                >
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: wt.color || 'var(--text-muted)' }}
                  />
                  <span className="flex-1 min-w-0 text-[12px] truncate">{wt.label || wt.branch}</span>
                  <button
                    onClick={() => removeWorktree(workspaceId, wt.id)}
                    className="text-[11px] text-muted hover:text-red-400"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// PR chip
// ---------------------------------------------------------------------------

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
      <GitPullRequest size={10} />
      <span className="tabular-nums">#{pr.number}</span>
      <span>{label}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// A draggable spawn button: click opens on this canvas, drag drops anywhere.
// ---------------------------------------------------------------------------

const SpawnButton: React.FC<{
  icon: React.ReactNode
  title: string
  panelType: WorktreePanelType
  cwd: string
  worktreeId: string
  onClick: () => void
}> = ({ icon, title, panelType, cwd, worktreeId, onClick }) => (
  <Tooltip label={`${title} — click to open here, or drag onto the canvas`}>
    <div
      role="button"
      aria-label={title}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'copy'
        e.dataTransfer.setData('application/cate-spawn', JSON.stringify({ panelType, cwd, worktreeId }))
      }}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className="w-5 h-5 flex items-center justify-center rounded-lg text-muted hover:text-primary hover:bg-surface-5 cursor-grab active:cursor-grabbing transition-colors"
    >
      {icon}
    </div>
  </Tooltip>
)

// ---------------------------------------------------------------------------
// A single worktree row: two lines — name + actions, then status + PR + what's
// open on the canvas. Click focuses the lens; inline rename + recolor.
// ---------------------------------------------------------------------------

const WorktreeRow: React.FC<{
  wt: JoinedWorktree
  primaryLabel: string
  focused: boolean
  status: { text: string; tone: string } | null
  pr?: PrStatus
  panels?: { terminals: number; agents: number }
  busy?: boolean
  cb: CardCallbacks
  onFocus: () => void
  onHover: (on: boolean) => void
  onLaunch: (type: WorktreePanelType) => void
}> = ({ wt, primaryLabel, focused, status, pr, panels, busy, cb, onFocus, onHover, onLaunch }) => {
  const isPrimary = !!wt.isPrimary
  const label = wt.label || wt.branch || (isPrimary ? 'main' : '(detached)')
  const color = wt.color || 'var(--text-muted)'
  const openTerminals = panels?.terminals ?? 0
  const openAgents = panels?.agents ?? 0
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(label)
  const [recoloring, setRecoloring] = useState(false)

  const commitRename = useCallback(() => {
    setRenaming(false)
    const next = renameValue.trim()
    if (next !== label) cb.onRename(next || undefined)
  }, [renameValue, label, cb])

  const openMenu = useCallback(
    () =>
      runWorktreeContextMenu({
        isPrimary,
        hasPr: !!pr || !!wt.prNumber,
        prUrl: pr?.url,
        primaryLabel,
        cb,
        beginRename: () => { setRenameValue(label); setRenaming(true) },
        beginRecolor: () => setRecoloring((v) => !v),
      }),
    [isPrimary, pr, primaryLabel, cb, label, wt.prNumber],
  )

  return (
    <div
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onClick={(e) => {
        if (busy) return
        if ((e.target as HTMLElement).closest('button, input, [role="button"]')) return
        onFocus()
      }}
      onContextMenu={(e) => { e.preventDefault(); if (!busy) void openMenu() }}
      title={busy ? 'Discarding…' : wt.path}
      aria-busy={busy || undefined}
      className={`mx-1 px-1.5 py-1 rounded-lg transition-colors ${
        busy ? 'opacity-60 cursor-wait' : 'cursor-pointer hover:bg-surface-4'
      }`}
      style={focused ? { backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)` } : undefined}
    >
      {/* Line 1 — name + actions */}
      <div className="flex items-center gap-1.5">
        <Tooltip label="Change color">
          <button
            onClick={(e) => { e.stopPropagation(); setRecoloring((v) => !v) }}
            aria-label="Change color"
            className="flex-shrink-0 w-3.5 h-3.5 flex items-center justify-center rounded-full hover:scale-110 transition-transform"
          >
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
          </button>
        </Tooltip>

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
            className="flex-1 min-w-0 text-[12px] bg-surface-5 rounded px-1 border border-focus outline-none text-primary"
          />
        ) : (
          <span
            className="flex-1 min-w-0 truncate text-[12px] text-secondary"
            onDoubleClick={() => { setRenameValue(label); setRenaming(true) }}
          >
            {label}
          </span>
        )}

        {isPrimary && !renaming && (
          <span className="flex-shrink-0 text-[10px] leading-none text-muted">base</span>
        )}
        {focused && !renaming && (
          <Check size={11} className="flex-shrink-0 text-primary" />
        )}

        {busy && (
          <CircleNotch size={13} className="flex-shrink-0 text-muted animate-spin" />
        )}

        {!renaming && !busy && (
          <div className="flex items-center gap-0.5 flex-shrink-0">
            <SpawnButton
              icon={<TerminalIcon size={12} />}
              title="Terminal"
              panelType="terminal"
              cwd={wt.path}
              worktreeId={wt.id}
              onClick={() => onLaunch('terminal')}
            />
            <SpawnButton
              icon={<ChatCircle size={12} />}
              title="Agent"
              panelType="agent"
              cwd={wt.path}
              worktreeId={wt.id}
              onClick={() => onLaunch('agent')}
            />
            <Tooltip label="More actions">
              <button
                onClick={(e) => { e.stopPropagation(); void openMenu() }}
                aria-label="More actions"
                className="w-5 h-5 flex items-center justify-center rounded-lg text-muted hover:text-primary hover:bg-surface-5 transition-colors"
              >
                <DotsThree size={14} />
              </button>
            </Tooltip>
          </div>
        )}
      </div>

      {/* Line 2 — status · PR · what's open */}
      {!renaming && (status || pr || openTerminals + openAgents > 0) && (
        <div className="flex items-center gap-2 mt-0.5 pl-5 text-[10px] leading-none">
          {status && <span className={status.tone}>{status.text}</span>}
          {pr && <PrPill pr={pr} onClick={() => cb.onOpenPr(pr.url)} />}
          <div className="flex-1" />
          {openTerminals + openAgents > 0 && (
            <span className="flex items-center gap-2 text-muted" title="Open on this canvas">
              {openTerminals > 0 && (
                <span className="flex items-center gap-0.5">
                  <TerminalIcon size={10} />
                  {openTerminals}
                </span>
              )}
              {openAgents > 0 && (
                <span className="flex items-center gap-0.5">
                  <ChatCircle size={10} />
                  {openAgents}
                </span>
              )}
            </span>
          )}
        </div>
      )}

      {recoloring && (
        <div className="flex items-center gap-1.5 flex-wrap mt-1 pl-5 pr-1">
          {getWorktreeColorPalette().map((c) => (
            <button
              key={c}
              onClick={(e) => { e.stopPropagation(); cb.onRecolor(c); setRecoloring(false) }}
              className="w-3.5 h-3.5 rounded-full transition-transform hover:scale-110"
              style={{
                backgroundColor: c,
                outline: c === wt.color ? '2px solid var(--text-primary)' : 'none',
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

export default WorktreeToolbarMenu
