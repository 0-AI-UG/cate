import type { PanelState, WorktreeMeta } from '../../shared/types'
import { parseLocator } from '../../shared/runtimeLocator'
import { pathKey } from '../../shared/pathUtils'

export interface WorktreePathLike extends Pick<WorktreeMeta, 'id' | 'path'> {
  isOrphan?: boolean
  isPrimary?: boolean
}

function locatorPathKey(locator: string): { runtimeId: string; path: string } {
  const parsed = parseLocator(locator)
  return { runtimeId: parsed.runtimeId, path: pathKey(parsed.path) }
}

/** Resolve a file/cwd/repository path to the most specific live checkout that
 * contains it. Works for local paths and runtime locators. */
export function worktreeForPath<W extends WorktreePathLike>(
  locator: string | undefined,
  worktrees: readonly W[],
): W | undefined {
  if (!locator) return undefined
  const target = locatorPathKey(locator)
  let best: W | undefined
  let bestLength = -1
  for (const worktree of worktrees) {
    if (worktree.isOrphan) continue
    const root = locatorPathKey(worktree.path)
    if (root.runtimeId !== target.runtimeId) continue
    if (target.path !== root.path && !target.path.startsWith(`${root.path}/`)) continue
    if (root.path.length > bestLength) {
      best = worktree
      bestLength = root.path.length
    }
  }
  return best
}

/** Resolve the checkout affinity already carried by a panel. File-backed
 * panels derive it from their absolute path; review panels derive it from the
 * repository path they operate on. */
export function worktreeForPanel<W extends WorktreePathLike>(
  panel: PanelState | undefined,
  worktrees: readonly W[],
): W | undefined {
  if (!panel) return undefined
  const explicit = worktrees.find((worktree) => worktree.id === panel.worktreeId)
  if (explicit) return explicit
  if (panel.type === 'terminal' || panel.type === 'agent') return worktreeForPath(panel.cwd, worktrees)
  if (panel.type === 'editor' || panel.type === 'document') {
    return worktreeForPath(panel.filePath, worktrees)
  }
  if (panel.type === 'review') return worktreeForPath(panel.reviewState?.repoPath, worktrees)
  return undefined
}

export function selectedWorktree<W extends WorktreePathLike>(
  worktrees: readonly W[],
  selectedId: string | undefined,
): W | undefined {
  return worktrees.find((worktree) => !worktree.isOrphan && worktree.id === selectedId)
    ?? worktrees.find((worktree) => !worktree.isOrphan && worktree.isPrimary)
    ?? worktrees.find((worktree) => !worktree.isOrphan)
}
