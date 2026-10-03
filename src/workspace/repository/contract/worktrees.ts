// Worktree rules both sides run: where checkouts live, how a new one is named
// and colored, which checkout a panel belongs to, what a new panel inherits,
// and what happens to bound panels when a worktree is removed.

import type {
  DocChange,
  PanelRecord,
  PanelType,
  WorkspaceDocument,
  WorktreeId,
  WorktreeMeta,
} from '@workspace/document/contract'
import type { GitWorktree } from './types'

/** Checkouts live at `<root>/.cate/worktrees/<slug>`. */
export const WORKTREES_DIR = ['.cate', 'worktrees'] as const

/** Comparable form of a path: forward slashes, no trailing slash, and
 *  case-folded for Windows paths. */
export function checkoutPathKey(p: string): string {
  const isWindows = /^[A-Za-z]:/.test(p) || p.includes('\\')
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return isWindows ? norm.toLowerCase() : norm
}

export function samePath(a: string, b: string): boolean {
  return checkoutPathKey(a) === checkoutPathKey(b)
}

/** Free text ("fix the login bug") to a branch name ("fix-the-login-bug"),
 *  leaving deliberate branch paths ("feat/x") alone. */
export function toBranchName(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w./-]+/g, '')
    .replace(/^-+|-+$/g, '')
}

/** One folder name for a branch (or `pr-<n>-<head>`). */
export function worktreeSlug(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'wt'
}

/** Worktree colors are theme palette keys; each client resolves a key to its
 *  theme's color. Green first so the main checkout reads as "ok"; red last. */
export const WORKTREE_COLORS = [
  'green', 'cyan', 'magenta', 'yellow',
  'brightGreen', 'brightCyan', 'brightMagenta', 'brightYellow',
  'blue', 'brightBlue',
  'red', 'brightRed',
] as const

export function pickWorktreeColor(existing: readonly { color: string }[]): string {
  const used = new Set(existing.map((w) => w.color))
  for (const c of WORKTREE_COLORS) if (!used.has(c)) return c
  return WORKTREE_COLORS[existing.length % WORKTREE_COLORS.length]
}

interface WorktreeLike {
  id: string
  path: string
  isOrphan?: boolean
  isPrimary?: boolean
}

/** A panel's `worktreeId` is the record's stable id; a path is never an id. */
export function resolveWorktree<W extends WorktreeLike>(
  worktreeId: string | undefined,
  worktrees: readonly W[] | undefined,
): W | undefined {
  if (!worktreeId || !worktrees) return undefined
  return worktrees.find((w) => w.id === worktreeId)
}

/** The most specific live checkout containing `target`. */
export function worktreeForPath<W extends WorktreeLike>(
  target: string | undefined,
  worktrees: readonly W[],
): W | undefined {
  if (!target) return undefined
  const key = checkoutPathKey(target)
  let best: W | undefined
  let bestLength = -1
  for (const worktree of worktrees) {
    if (worktree.isOrphan) continue
    const root = checkoutPathKey(worktree.path)
    if (key !== root && !key.startsWith(`${root}/`)) continue
    if (root.length > bestLength) {
      best = worktree
      bestLength = root.length
    }
  }
  return best
}

/** The checkout the main root is in, which bound panels fall back to. */
export function mainWorktree<W extends WorktreeLike>(worktrees: readonly W[], root: string): W | undefined {
  return worktrees.find((w) => samePath(w.path, root))
}

/** The record's `worktreeId` for a picked checkout id: null for the
 *  workspace root, whose joined id is its path while it has no metadata. */
export function boundWorktreeId(id: string, root: string): string | null {
  return samePath(id, root) ? null : id
}

export interface PanelCheckoutHooks {
  /** The path a file-backed panel works on (its definition's `checkoutPath`). */
  checkoutPath?: (record: PanelRecord) => string | undefined
  /** Types that run in a checkout (terminal, chat) and pass their directory on. */
  bound?: (type: PanelType) => boolean
  /** The working directory a bound panel runs in, when it has its own. */
  workingDir?: (record: PanelRecord) => string | undefined
}

/** The checkout a panel belongs to: its explicit binding, else the one its
 *  operative path is in. */
export function worktreeForPanel<W extends WorktreeLike>(
  record: PanelRecord | undefined,
  worktrees: readonly W[],
  hooks: PanelCheckoutHooks = {},
): W | undefined {
  if (!record) return undefined
  const explicit = resolveWorktree(record.worktreeId, worktrees)
  if (explicit) return explicit
  return worktreeForPath(hooks.checkoutPath?.(record), worktrees)
}

export interface InheritedWorktree {
  /** The selected bound panel's own directory, or the checkout root. */
  cwd?: string
  worktreeId?: WorktreeId
}

/** What a new terminal or chat created from a generic action inherits from the
 *  panel the user has selected. Empty when that panel is in no checkout. */
export function inheritWorktree<W extends WorktreeLike>(
  record: PanelRecord | undefined,
  worktrees: readonly W[],
  hooks: PanelCheckoutHooks = {},
): InheritedWorktree {
  if (!record) return {}
  const worktree = worktreeForPanel(record, worktrees, hooks)
  if (hooks.bound?.(record.type)) {
    return { cwd: hooks.workingDir?.(record) ?? worktree?.path, worktreeId: record.worktreeId ?? worktree?.id }
  }
  return worktree ? { cwd: worktree.path, worktreeId: worktree.id } : {}
}

/** A saved selection, else the primary, else any live checkout. */
export function selectedWorktree<W extends WorktreeLike>(
  worktrees: readonly W[],
  selectedId: string | undefined,
): W | undefined {
  return worktrees.find((worktree) => !worktree.isOrphan && worktree.id === selectedId)
    ?? worktrees.find((worktree) => !worktree.isOrphan && worktree.isPrimary)
    ?? worktrees.find((worktree) => !worktree.isOrphan)
}

export function panelsBoundTo(doc: Pick<WorkspaceDocument, 'panels'>, worktreeId: WorktreeId): PanelRecord[] {
  return Object.values(doc.panels).filter((panel) => panel.worktreeId === worktreeId)
}

/** The document changes that drop a worktree: its bound panels are closed, or
 *  moved to the main checkout (unbound when there is none), then the metadata
 *  goes. */
export function worktreeRemovalChanges(
  doc: Pick<WorkspaceDocument, 'panels' | 'worktrees'>,
  worktreeId: WorktreeId,
  opts: { closePanels: boolean; root: string },
): DocChange[] {
  const bound = panelsBoundTo(doc, worktreeId)
  const changes: DocChange[] = []
  if (opts.closePanels) {
    if (bound.length > 0) changes.push({ kind: 'removePanels', ids: bound.map((p) => p.id) })
  } else {
    const main = mainWorktree(Object.values(doc.worktrees).filter((w) => w.id !== worktreeId), opts.root)
    for (const panel of bound) {
      changes.push({ kind: 'updatePanel', id: panel.id, patch: { worktreeId: main?.id ?? null } })
    }
  }
  if (doc.worktrees[worktreeId]) changes.push({ kind: 'removeWorktree', id: worktreeId })
  return changes
}

/** A worktree as views show it: live git facts joined with the metadata. */
export interface JoinedWorktree {
  /** Metadata id, or the path for a checkout Cate has no metadata for yet. */
  id: string
  path: string
  branch: string
  isPrimary: boolean
  isCurrent: boolean
  color?: string
  label?: string
  prNumber?: number
  status?: WorktreeMeta['status']
  /** Metadata whose checkout git no longer lists. */
  isOrphan: boolean
}

/** One entry per live checkout plus orphaned metadata. Metadata still being
 *  created shows even before git lists it. */
export function joinWorktrees(
  root: string,
  meta: readonly WorktreeMeta[],
  live: readonly GitWorktree[],
): JoinedWorktree[] {
  const metaByPath = new Map<string, WorktreeMeta>()
  for (const m of meta) metaByPath.set(checkoutPathKey(m.path), m)
  const rootKey = checkoutPathKey(root)
  const seen = new Set<string>()
  const joined: JoinedWorktree[] = []
  for (const g of live) {
    if (g.isBare) continue
    const key = checkoutPathKey(g.path)
    seen.add(key)
    const m = metaByPath.get(key)
    joined.push({
      id: m?.id ?? g.path,
      path: g.path,
      branch: g.branch || '',
      isPrimary: key === rootKey,
      isCurrent: g.isCurrent,
      color: m?.color,
      label: m?.label,
      prNumber: m?.prNumber,
      status: m?.status,
      isOrphan: false,
    })
  }
  for (const m of meta) {
    const key = checkoutPathKey(m.path)
    if (seen.has(key) || key === rootKey) continue
    joined.push({
      id: m.id,
      path: m.path,
      branch: '',
      isPrimary: false,
      isCurrent: false,
      color: m.color,
      label: m.label,
      prNumber: m.prNumber,
      status: m.status,
      isOrphan: m.status === 'ready',
    })
  }
  return joined
}
