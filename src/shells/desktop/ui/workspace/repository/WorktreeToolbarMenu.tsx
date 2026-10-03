// The canvas toolbar's parallel worktrees menu, the home of worktree tooling.
// Per worktree: focus its canvas lens (click the row), see its git status, PR
// state and open panels, open a terminal or chat bound to it (click = here,
// drag = drop anywhere on the canvas), recolor and rename inline, and reach
// publish / PR / update / merge / discard through the row menu. Plus starting
// a new worktree, cleaning up missing ones, and git init when the folder is
// not a repository. The heavy subscriptions live in the popover body, mounted
// only while the menu is open.

import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Check, X, GitPullRequest } from 'lucide-react'
import { Ellipsis as DotsThree, TriangleAlert as Warning } from 'lucide-react'
import { Split as ArrowsSplit } from 'lucide-react'
import { useRuntime } from '../../kernel/rpc'
import { errorMessage } from '@kernel/interaction'
import { Icon, Spinner, Tooltip, useDismissableLayer } from '../../kernel/interaction'
import type { JoinedWorktree, PrStatusResult } from '@workspace/repository/contract'
import { useRepositoryUi, type WorktreeLaunchType } from './context'
import { CreateWorktreeForm } from './CreateWorktreeForm'
import { useGitStatus } from './gitStatus'
import { useWorktrees } from './worktrees'
import { useParallelWork, runWorktreeContextMenu, type CardCallbacks } from './parallelWork'
import { useWorktreeStatuses, humanStatus } from './worktreeStatuses'
import { useTheme, worktreeColor, worktreePalette } from './colors'

type PrStatus = PrStatusResult

export interface WorktreeMenuTriggerProps {
  ref: RefObject<HTMLButtonElement>
  onClick: () => void
  /** The menu is open or a worktree is focused on the canvas. */
  active: boolean
  icon: ReactNode
}

export interface WorktreeToolbarMenuProps {
  /** The canvas new panels open on. */
  canvasPanelId: string
  menuSide?: 'up' | 'right'
  onOpenChange?: (open: boolean) => void
  /** Draws the toolbar button (client layout owns the toolbar chrome). */
  renderTrigger: (props: WorktreeMenuTriggerProps) => ReactNode
  /** Registers the toggle for the toolbar's keyboard action; may return a
   *  cleanup. */
  bindToggle?: (toggle: () => void) => void | (() => void)
}

interface PopoverPos {
  left: number
  bottom: number
}

export const WorktreeToolbarMenu: React.FC<WorktreeToolbarMenuProps> = ({
  canvasPanelId,
  menuSide = 'up',
  onOpenChange,
  renderTrigger,
  bindToggle,
}) => {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<PopoverPos | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const { focusedWorktreeId } = useRepositoryUi()
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
  useEffect(() => bindToggle?.(toggle) ?? undefined, [bindToggle, toggle])

  return (
    <>
      {renderTrigger({ ref: btnRef, onClick: toggle, active, icon: <ArrowsSplit size={18} /> })}
      {open && pos &&
        createPortal(
          <WorktreeMenuPopover
            pos={pos}
            triggerRef={btnRef}
            canvasPanelId={canvasPanelId}
            onClose={close}
          />,
          document.body,
        )}
    </>
  )
}

export interface WorktreeMenuPopoverProps {
  pos: PopoverPos
  triggerRef: React.RefObject<HTMLButtonElement>
  canvasPanelId: string
  onClose: () => void
}

export const WorktreeMenuPopover: React.FC<WorktreeMenuPopoverProps> = ({
  pos,
  triggerRef,
  canvasPanelId,
  onClose,
}) => {
  const host = useRepositoryUi()
  const { workspaceId, root: rootPath } = host
  const runtime = useRuntime(workspaceId)
  const rootRef = useRef<HTMLDivElement>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Worktree id with a slow git op (publish / PR / update / merge / discard) in
  // flight — drives that row's inline spinner so the work is visible.
  const [busyId, setBusyId] = useState<string | null>(null)

  const snapshot = useGitStatus(workspaceId, rootPath)
  const isRepo = rootPath ? snapshot.isRepo : false
  const joined = useWorktrees()
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

  const { focusWorktree, focusedWorktreeId, setHoveredWorktree, panels } = host
  // What's already open, per worktree and panel type.
  const panelCounts = useMemo(() => {
    const counts: Record<string, Partial<Record<string, number>>> = {}
    for (const p of panels) {
      if (!p.worktreeId) continue
      const c = counts[p.worktreeId] ??= {}
      c[p.type] = (c[p.type] ?? 0) + 1
    }
    return counts
  }, [panels])

  const { statusByPath, prByPath, refreshPr } = useWorktreeStatuses(workspaceId, live)
  const { createWorktree, checkoutPr, launchInWorktree, handlePrune, removeOrphan, makeCallbacks } = useParallelWork(
    primaryLabel,
    { setError, onPrCreated: refreshPr, setBusy: setBusyId },
  )

  useDismissableLayer({ open: true, contentRef: rootRef, triggerRefs: [triggerRef], onDismiss: onClose })

  // Never leave a worktree highlighted on the canvas once the menu is gone.
  useEffect(() => () => setHoveredWorktree(null), [setHoveredWorktree])

  const launch = useCallback(
    (wt: JoinedWorktree, type: string) => {
      void launchInWorktree(wt, type, canvasPanelId)
      onClose()
    },
    [launchInWorktree, canvasPanelId, onClose],
  )

  const handleInit = useCallback(async () => {
    if (!rootPath || !runtime) return
    setError(null)
    try {
      await runtime.vcs.init({ cwd: rootPath })
    } catch (err: unknown) {
      setError(`Couldn’t initialize git: ${errorMessage(err, 'The operation failed.')}`)
    }
  }, [rootPath, runtime])

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
            workspaceId={workspaceId}
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
                workspaceId={workspaceId}
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
              launchTypes={host.launchTypes}
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
                  onClick={() => void handlePrune(orphans)}
                  className="px-1.5 py-0.5 rounded-lg hover:bg-surface-4 text-secondary hover:text-primary"
                  title="Remove missing worktrees"
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
                    style={{ backgroundColor: worktreeColor(wt.color) || 'var(--text-muted)' }}
                  />
                  <span className="flex-1 min-w-0 text-[12px] truncate">{wt.label || wt.branch}</span>
                  <button
                    onClick={() => void removeOrphan(wt.id)}
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
  workspaceId: string
  panelType: string
  cwd: string
  worktreeId: string
  onClick: () => void
}> = ({ icon, title, workspaceId, panelType, cwd, worktreeId, onClick }) => (
  <Tooltip label={title}>
    <div
      role="button"
      aria-label={title}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'copy'
        e.dataTransfer.setData('application/cate-spawn', JSON.stringify({ workspaceId, panelType, cwd, worktreeId }))
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
  workspaceId: string
  wt: JoinedWorktree
  primaryLabel: string
  focused: boolean
  status: { text: string; tone: string } | null
  pr?: PrStatus
  /** Open panels bound to the worktree, by type. */
  panels?: Partial<Record<string, number>>
  busy?: boolean
  cb: CardCallbacks
  onFocus: () => void
  onHover: (on: boolean) => void
  launchTypes: readonly WorktreeLaunchType[]
  onLaunch: (type: string) => void
}> = ({ workspaceId, wt, primaryLabel, focused, status, pr, panels, busy, cb, launchTypes, onFocus, onHover, onLaunch }) => {
  const isPrimary = !!wt.isPrimary
  const label = wt.label || wt.branch || (isPrimary ? 'main' : '(detached)')
  const theme = useTheme()
  const color = worktreeColor(wt.color, theme) || 'var(--text-muted)'
  const open = launchTypes.filter(({ type }) => (panels?.[type] ?? 0) > 0)
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
      title={busy ? 'Discarding' : wt.path}
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
          <Spinner size={13} className="text-muted" />
        )}

        {!renaming && !busy && (
          <div className="flex items-center gap-0.5 flex-shrink-0">
            {launchTypes.map(({ type, label: title, icon }) => (
              <SpawnButton
                key={type}
                icon={<Icon name={icon} size={12} />}
                title={title}
                workspaceId={workspaceId}
                panelType={type}
                cwd={wt.path}
                worktreeId={wt.id}
                onClick={() => onLaunch(type)}
              />
            ))}
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
      {!renaming && (status || pr || open.length > 0) && (
        <div className="flex items-center gap-2 mt-0.5 pl-5 text-[10px] leading-none">
          {status && <span className={status.tone}>{status.text}</span>}
          {pr && <PrPill pr={pr} onClick={() => cb.onOpenPr(pr.url)} />}
          <div className="flex-1" />
          {open.length > 0 && (
            <span className="flex items-center gap-2 text-muted" title="Open on this canvas">
              {open.map(({ type, icon }) => (
                <span key={type} className="flex items-center gap-0.5">
                  <Icon name={icon} size={10} />
                  {panels?.[type]}
                </span>
              ))}
            </span>
          )}
        </div>
      )}

      {recoloring && (
        <div className="flex items-center gap-1.5 flex-wrap mt-1 pl-5 pr-1">
          {worktreePalette(theme).map(({ key, color: c }) => (
            <button
              key={key}
              onClick={(e) => { e.stopPropagation(); cb.onRecolor(key); setRecoloring(false) }}
              className="w-3.5 h-3.5 rounded-full transition-transform hover:scale-110"
              style={{
                backgroundColor: c,
                outline: key === wt.color ? '2px solid var(--text-primary)' : 'none',
                outlineOffset: 1,
              }}
              title={key}
            />
          ))}
        </div>
      )}
    </div>
  )
}

