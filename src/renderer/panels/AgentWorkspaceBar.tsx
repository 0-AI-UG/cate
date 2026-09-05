import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CaretDown,
  ChatsCircle,
  CircleNotch,
  DotsThree,
  GitBranch,
  GitDiff,
  Plus,
  X,
} from '@phosphor-icons/react'
import type { GitComparisonSpec, PanelState, WorktreeMeta } from '../../shared/types'
import type { JoinedWorktree } from '../stores/useWorktrees'
import type { WorktreeStatus } from '../stores/useParallelWork'
import { useAppStore } from '../stores/appStore'
import { useGitStatusSnapshot } from '../stores/gitStatusStore'
import { useWorktrees } from '../stores/useWorktrees'
import { useWorktreeStatuses } from '../stores/useWorktreeStatuses'
import { runWorktreeContextMenu, useParallelWork } from '../stores/useParallelWork'
import { CreateWorktreeForm, type PrListItem } from '../sidebar/CreateWorktreeForm'
import { openReviewPanel } from '../lib/review/openReviewPanel'
import { revealPanel } from '../lib/workspace/panelReveal'
import { errorMessage } from '../lib/errorMessage'
import { Tooltip } from '../ui/Tooltip'
import { pathKey } from '../../shared/pathUtils'

interface AgentWorkspaceBarProps {
  panelId: string
  workspaceId: string
}

interface MenuPosition {
  top: number
  left: number
  width: number
}

type WorktreeTarget = Pick<JoinedWorktree, 'id' | 'path'> | WorktreeMeta

export function resolveAgentWorktree(
  panel: Pick<PanelState, 'worktreeId' | 'cwd'> | undefined,
  worktrees: readonly JoinedWorktree[],
): JoinedWorktree | undefined {
  if (panel?.worktreeId) {
    return worktrees.find((worktree) => worktree.id === panel.worktreeId)
  }
  if (panel?.cwd) {
    return worktrees.find((worktree) => pathKey(worktree.path) === pathKey(panel.cwd!))
  }
  return worktrees.find((worktree) => worktree.isPrimary)
}

export function worktreeChangeCount(status: WorktreeStatus | undefined): number | null {
  if (!status) return null
  return status.staged + status.unstaged + status.untracked
}

export function branchComparisonSpec(
  worktree: Pick<JoinedWorktree, 'branch'>,
  primaryBranch: string,
): GitComparisonSpec | null {
  if (!worktree.branch || !primaryBranch || worktree.branch === primaryBranch) return null
  return { kind: 'branch', base: primaryBranch, target: worktree.branch }
}

/** Reuse the Agent already bound to a checkout. Creating another empty T3
 * draft for the same checkout is unnecessary, and existing threads are never rebound. */
export async function openOrRevealAgentForWorktree(
  workspaceId: string,
  worktree: WorktreeTarget,
): Promise<string> {
  const app = useAppStore.getState()
  const workspace = app.workspaces.find((item) => item.id === workspaceId)
  const targetPath = pathKey(worktree.path)
  const existing = Object.values(workspace?.panels ?? {}).find((candidate) => {
    if (candidate.type !== 'agent') return false
    if (candidate.worktreeId) return candidate.worktreeId === worktree.id
    return pathKey(candidate.cwd ?? workspace?.rootPath ?? '') === targetPath
  })
  if (existing) {
    await revealPanel(workspaceId, existing.id, { retry: true })
    return existing.id
  }
  return app.createAgent(
    workspaceId,
    undefined,
    undefined,
    worktree.path,
    worktree.id,
  )
}

function worktreeLabel(worktree: JoinedWorktree): string {
  return worktree.label || worktree.branch || (worktree.isPrimary ? 'Primary worktree' : '(detached)')
}

export function AgentWorkspaceBar({ panelId, workspaceId }: AgentWorkspaceBarProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const workspace = useAppStore((state) => state.workspaces.find((item) => item.id === workspaceId))
  const panel = workspace?.panels[panelId]
  const rootPath = workspace?.rootPath ?? ''
  const snapshot = useGitStatusSnapshot(rootPath)
  const joined = useWorktrees(rootPath, workspaceId)
  const live = useMemo(() => joined.filter((worktree) => !worktree.isOrphan), [joined])
  const current = resolveAgentWorktree(panel, live)
  const currentSnapshot = useGitStatusSnapshot(current?.path ?? '')
  const primaryBranch = useMemo(
    () => snapshot.worktrees.find((worktree) => worktree.isPrimary)?.branch
      ?? live.find((worktree) => worktree.isPrimary)?.branch
      ?? '',
    [live, snapshot.worktrees],
  )
  const statusTargets = useMemo(
    () => menuPosition ? live : current ? [current] : [],
    [current, live, menuPosition],
  )
  const { statusByPath, prByPath, refreshPr } = useWorktreeStatuses(rootPath, statusTargets)
  const changeCount = current ? currentSnapshot.statusFiles.length : null
  const comparisonSpec = current ? branchComparisonSpec(current, primaryBranch) : null
  const { createWorktree, checkoutPr, makeCallbacks } = useParallelWork(
    rootPath,
    workspaceId,
    primaryBranch,
    { setError, onPrCreated: refreshPr, setBusy: setBusyId },
  )

  const closeMenu = useCallback(() => {
    setMenuPosition(null)
    setCreating(false)
  }, [])

  const toggleMenu = useCallback(() => {
    if (menuPosition) {
      closeMenu()
      return
    }
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.max(280, Math.min(360, rect.width + 120))
    setMenuPosition({
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      width,
    })
  }, [closeMenu, menuPosition])

  useEffect(() => {
    if (!menuPosition) return
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      closeMenu()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeMenu()
    }
    window.addEventListener('resize', closeMenu)
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('resize', closeMenu)
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [closeMenu, menuPosition])

  const openAgent = useCallback(async (worktree: WorktreeTarget) => {
    try {
      await openOrRevealAgentForWorktree(workspaceId, worktree)
      closeMenu()
    } catch (cause: unknown) {
      setError(`Couldn’t open the Agent: ${errorMessage(cause, 'The panel is unavailable.')}`)
    }
  }, [closeMenu, workspaceId])

  const handleCreate = useCallback(async (name: string, baseRef?: string) => {
    const worktree = await createWorktree(name, baseRef)
    if (worktree) await openAgent(worktree)
  }, [createWorktree, openAgent])

  const handleCheckoutPr = useCallback(async (pr: PrListItem) => {
    const worktree = await checkoutPr(pr)
    if (worktree) await openAgent(worktree)
  }, [checkoutPr, openAgent])

  const openUncommittedReview = useCallback(() => {
    if (!current) return
    void openReviewPanel({ workspaceId, repoPath: current.path, spec: { kind: 'uncommitted' } })
  }, [current, workspaceId])

  const openBranchReview = useCallback(() => {
    if (!current || !comparisonSpec) return
    void openReviewPanel({ workspaceId, repoPath: current.path, spec: comparisonSpec })
  }, [comparisonSpec, current, workspaceId])

  const openActions = useCallback(() => {
    if (!current || busyId) return
    const pr = prByPath[current.path]
    void runWorktreeContextMenu({
      isPrimary: current.isPrimary,
      hasPr: !!pr || !!current.prNumber,
      prUrl: pr?.url,
      primaryLabel: primaryBranch,
      cb: makeCallbacks(current),
    })
  }, [busyId, current, makeCallbacks, prByPath, primaryBranch])

  const label = current ? worktreeLabel(current) : 'Worktree unavailable'
  const branch = current?.branch || (current ? 'Detached HEAD' : 'Select another worktree')

  return (
    <>
      <div
        className="flex h-9 shrink-0 items-center gap-1 border-b border-subtle bg-surface-3 px-2"
        data-testid="agent-workspace-bar"
      >
        <button
          ref={buttonRef}
          type="button"
          onClick={toggleMenu}
          disabled={!rootPath}
          className="flex min-w-0 max-w-[52%] items-center gap-1.5 rounded px-1.5 py-1 text-left text-secondary hover:bg-hover hover:text-primary disabled:cursor-default"
          title={current?.path ?? label}
          aria-label="Open Agent in another worktree"
        >
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: current?.color ?? 'rgb(var(--text-muted))' }}
          />
          <span className="min-w-0 truncate text-xs font-medium">{label}</span>
          <CaretDown size={11} className="shrink-0 text-muted" />
        </button>

        <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted" title={branch}>
          <GitBranch size={12} className="shrink-0" />
          <span className="truncate">{branch}</span>
        </span>

        {changeCount !== null && (
          <button
            type="button"
            onClick={openUncommittedReview}
            disabled={changeCount === 0}
            className="ml-1 shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums text-muted hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-60"
            title={changeCount > 0 ? 'Review uncommitted changes' : 'No uncommitted changes'}
          >
            {changeCount} {changeCount === 1 ? 'change' : 'changes'}
          </button>
        )}

        <span className="flex-1" />

        {comparisonSpec && (
          <Tooltip label={`Review branch against ${primaryBranch}`}>
            <button
              type="button"
              onClick={openBranchReview}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-primary"
              aria-label={`Review branch against ${primaryBranch}`}
            >
              <GitDiff size={14} />
            </button>
          </Tooltip>
        )}

        <Tooltip label="Worktree actions">
          <button
            type="button"
            onClick={openActions}
            disabled={!current || !!busyId}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-primary disabled:opacity-50"
            aria-label="Worktree actions"
          >
            {busyId ? <CircleNotch size={14} className="animate-spin" /> : <DotsThree size={15} />}
          </button>
        </Tooltip>
      </div>

      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-red-500/20 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
          <span className="min-w-0 flex-1 truncate" title={error}>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss worktree error">
            <X size={12} />
          </button>
        </div>
      )}

      {menuPosition && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[1000] overflow-hidden rounded-xl border border-subtle bg-surface-2 text-xs shadow-xl"
          style={menuPosition}
          data-testid="agent-worktree-menu"
        >
          {creating ? (
            <div className="p-1">
              <CreateWorktreeForm
                defaultBaseBranch={primaryBranch}
                rootPath={rootPath}
                inlinePicker
                flat
                onSubmit={handleCreate}
                onCheckoutPr={handleCheckoutPr}
                onCancel={() => setCreating(false)}
              />
            </div>
          ) : (
            <>
              <div className="max-h-[280px] overflow-y-auto p-1">
                {live.map((worktree) => {
                  const selected = worktree.id === current?.id
                  const count = worktreeChangeCount(statusByPath[worktree.path])
                  return (
                    <button
                      key={worktree.id}
                      type="button"
                      onClick={() => { void openAgent(worktree) }}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-secondary hover:bg-hover hover:text-primary"
                      title={`Open a new Agent in ${worktree.path}`}
                    >
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: worktree.color ?? 'rgb(var(--text-muted))' }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-medium">{worktreeLabel(worktree)}</span>
                          {selected && <span className="shrink-0 text-[9px] text-muted">current</span>}
                        </span>
                        <span className="mt-0.5 block truncate text-[10px] text-muted">
                          {worktree.branch || 'Detached HEAD'}
                        </span>
                      </span>
                      {count !== null && count > 0 && (
                        <span className="shrink-0 text-[10px] tabular-nums text-yellow-400/80">{count}</span>
                      )}
                      <ChatsCircle size={14} className="shrink-0 text-muted" />
                    </button>
                  )
                })}
              </div>
              <div className="border-t border-subtle p-1">
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-secondary hover:bg-hover hover:text-primary"
                >
                  <Plus size={13} />
                  Create worktree and open Agent
                </button>
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
