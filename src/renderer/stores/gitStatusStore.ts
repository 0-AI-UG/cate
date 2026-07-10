// =============================================================================
// gitStatusStore — ONE per-workspace owner of git/status state, keyed by
// rootPath.
//
// Before this store, the same git porcelain was fetched independently into
// FileExplorer, useGitTree, SourceControlView and ParallelWorkTab — each with
// its own fsWatch + debounce + refresh-on-focus loop (with subtly different
// debounce values and trigger matrices), so the Explorer tint, the Search tint
// and the Source Control list could legitimately show three different snapshots
// of the same repo at the same instant.
//
// This store collapses that to a single source per root:
//   - ONE refcounted fsWatch (via fsWatchManager.watchFsRoot) + ONE debounce.
//   - ONE window-focus refresh.
//   - ONE GIT_BRANCH_UPDATE invalidation subscription.
// Each consumer subscribes (via the hooks below) and derives its view through
// selectors. A `revision` counter bumps on every applied snapshot so memoized
// derivations (e.g. the GitTree) can recompute exactly once per refresh.
//
// `gitInfo` was already deleted from statusStore in a prior commit; this store
// is the replacement owner for branch / ahead / behind, and GIT_BRANCH_UPDATE
// is treated here as a pure invalidation event.
// =============================================================================

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  buildGitTreeDecorations,
  toPosixPath,
  type GitStatusFileEntry,
  type GitTree,
} from '../sidebar/gitStatusDecoration'
import { watchFsRoot } from '../lib/fs/fsWatchManager'
import { useAppStore } from './appStore'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** A single live git worktree as reported by `git worktree list`. This is the
 *  single source of truth for path/branch/isPrimary/isCurrent; UI-owned
 *  metadata (color/label/id) lives in appStore.worktrees and is joined at read
 *  time (see useWorktrees). */
export interface GitWorktreeEntry {
  path: string
  branch: string
  isPrimary: boolean
  isCurrent: boolean
}

/** The full git snapshot for one rootPath. */
export interface GitStatusSnapshot {
  /** Whether rootPath is inside a git repo. */
  isRepo: boolean
  /** Absolute (posix) paths of all git-tracked files (for ignored-file tinting). */
  tracked: Set<string>
  /** Porcelain status entries (repo-cwd-relative paths). */
  statusFiles: GitStatusFileEntry[]
  /** Current branch name, or null (detached / not-a-repo). */
  branch: string | null
  /** Commits ahead of upstream. */
  ahead: number
  /** Commits behind upstream. */
  behind: number
  /** Live worktree list (single source for path/branch/isPrimary/isCurrent). */
  worktrees: GitWorktreeEntry[]
  /** Bumped on every applied snapshot so derivations recompute once per refresh. */
  revision: number
}

const EMPTY_SNAPSHOT: GitStatusSnapshot = {
  isRepo: false,
  tracked: new Set(),
  statusFiles: [],
  branch: null,
  ahead: 0,
  behind: 0,
  worktrees: [],
  revision: 0,
}

// -----------------------------------------------------------------------------
// Per-root entry: the snapshot, its subscribers, and its single watch loop.
// -----------------------------------------------------------------------------

type Subscriber = () => void

interface RootEntry {
  rootPath: string
  snapshot: GitStatusSnapshot
  subscribers: Set<Subscriber>
  /** refcount of consumers (hook mounts) keeping this root's loop armed. */
  refCount: number
  /** Trailing-debounce timer coalescing fs-watch bursts. */
  debounceTimer: ReturnType<typeof setTimeout> | null
  /** Teardown for fsWatch + focus + GIT_BRANCH_UPDATE; null until armed. */
  teardown: (() => void) | null
  /** Generation guard so a stale in-flight refetch can't clobber a newer one. */
  fetchSeq: number
  disposed: boolean
  /** Test-only: when set, the live git fetch is suppressed so an injected
   *  snapshot (gitStatusStore._seedWorktrees) survives focus/fs refreshes. */
  pinned: boolean
}

const roots = new Map<string, RootEntry>()

// Coalesce fs-watch bursts (e.g. a build writing many files). 150ms matches the
// tightest of the old per-panel debounces.
const REFRESH_DEBOUNCE_MS = 150

function getRoot(rootPath: string): RootEntry {
  let entry = roots.get(rootPath)
  if (!entry) {
    entry = {
      rootPath,
      snapshot: EMPTY_SNAPSHOT,
      subscribers: new Set(),
      refCount: 0,
      debounceTimer: null,
      teardown: null,
      fetchSeq: 0,
      disposed: false,
      pinned: false,
    }
    roots.set(rootPath, entry)
  }
  return entry
}

function notify(entry: RootEntry): void {
  for (const sub of entry.subscribers) sub()
}

/** Resolve the workspace that owns `rootPath` — an exact root match first
 *  (workspace roots are unique, see remoteSlice's duplicate-root guard), then
 *  the workspace whose root is an ancestor (sub-repos discovered inside a
 *  multi-repo workspace). Every git IPC call must name its workspace so main
 *  validates the cwd against that workspace's scope; an unknown root yields ''
 *  and is denied. Exported for call sites holding a rootPath but no id. */
export function workspaceIdForRoot(rootPath: string): string {
  const norm = (p: string) => toPosixPath(p)
  const target = norm(rootPath)
  const workspaces = useAppStore.getState().workspaces
  const exact = workspaces.find((w) => norm(w.rootPath) === target)
  if (exact) return exact.id
  return workspaces.find((w) => w.rootPath && target.startsWith(`${norm(w.rootPath)}/`))?.id ?? ''
}

/** Fetch the full git snapshot for `rootPath` from the git IPC. */
async function fetchSnapshot(rootPath: string): Promise<GitStatusSnapshot | null> {
  const api = window.electronAPI
  if (!api || !rootPath) return null
  const workspaceId = workspaceIdForRoot(rootPath)

  const isRepo = await api.gitIsRepo(rootPath, workspaceId).catch(() => false)
  if (!isRepo) {
    return { ...EMPTY_SNAPSHOT, isRepo: false, tracked: new Set(), worktrees: [] }
  }

  const [trackedFiles, status, worktreeList] = await Promise.all([
    api.gitLsFiles(rootPath, workspaceId).catch(() => [] as string[]),
    api.gitStatus(rootPath, workspaceId),
    api.gitWorktreeList(rootPath, workspaceId).catch(() => [] as Array<{ path: string; branch: string; isBare: boolean; isCurrent: boolean }>),
  ])

  // gitLsFiles returns repo-cwd-relative paths; convert to absolute (posix) so
  // lookups match the absolute node/search paths consumers carry.
  const root = toPosixPath(rootPath)
  const tracked = new Set(trackedFiles.map((p) => `${root}/${p}`))

  const worktrees: GitWorktreeEntry[] = worktreeList.map((w) => ({
    path: w.path,
    branch: w.branch,
    isPrimary: w.path === rootPath,
    isCurrent: w.isCurrent,
  }))

  return {
    isRepo: true,
    tracked,
    statusFiles: status.files,
    branch: status.current,
    ahead: status.ahead,
    behind: status.behind,
    worktrees,
    revision: 0, // assigned at apply time
  }
}

/** Refetch and apply a fresh snapshot for this root, guarding against stale
 *  in-flight responses landing after a newer refresh. */
function refresh(entry: RootEntry): void {
  if (entry.pinned) return // test-only injected snapshot owns this root
  const seq = ++entry.fetchSeq
  void fetchSnapshot(entry.rootPath)
    .then((snap) => {
      if (entry.disposed || entry.pinned || seq !== entry.fetchSeq || !snap) return
      entry.snapshot = { ...snap, revision: entry.snapshot.revision + 1 }
      notify(entry)
    })
    .catch(() => {
      if (entry.disposed || seq !== entry.fetchSeq) return
      entry.snapshot = { ...EMPTY_SNAPSHOT, revision: entry.snapshot.revision + 1 }
      notify(entry)
    })
}

function scheduleRefresh(entry: RootEntry): void {
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = null
    refresh(entry)
  }, REFRESH_DEBOUNCE_MS)
}

/** Arm the single watch loop on the 0->1 refcount transition. */
function arm(entry: RootEntry, workspaceId?: string): void {
  if (entry.teardown) return

  const onFocus = (): void => scheduleRefresh(entry)
  window.addEventListener('focus', onFocus)

  const releaseWatch = watchFsRoot(entry.rootPath, () => scheduleRefresh(entry), workspaceId)

  // GIT_BRANCH_UPDATE is a pure invalidation event (branch checkout, commit,
  // etc. detected by main's git monitor); fold it into the single refresh path.
  const offBranch = window.electronAPI?.onGitBranchUpdate?.(() => scheduleRefresh(entry))

  entry.teardown = () => {
    window.removeEventListener('focus', onFocus)
    releaseWatch()
    offBranch?.()
  }

  // Initial load.
  refresh(entry)
}

/** Tear down the watch loop on the 1->0 refcount transition. */
function disarm(entry: RootEntry): void {
  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer)
    entry.debounceTimer = null
  }
  entry.teardown?.()
  entry.teardown = null
  entry.disposed = true
  roots.delete(entry.rootPath)
}

// -----------------------------------------------------------------------------
// Imperative API (also used by tests)
// -----------------------------------------------------------------------------

export const gitStatusStore = {
  /** Current snapshot for a root (EMPTY when unknown / not yet loaded). */
  getSnapshot(rootPath: string): GitStatusSnapshot {
    return roots.get(rootPath)?.snapshot ?? EMPTY_SNAPSHOT
  },

  /** Subscribe to snapshot changes for a root, keeping its single watch loop
   *  armed for the lifetime of the subscription. Returns an unsubscribe fn. */
  subscribe(rootPath: string, listener: Subscriber, workspaceId?: string): () => void {
    if (!rootPath) return () => {}
    const entry = getRoot(rootPath)
    entry.subscribers.add(listener)
    entry.refCount += 1
    if (entry.refCount === 1) arm(entry, workspaceId)
    return () => {
      entry.subscribers.delete(listener)
      entry.refCount -= 1
      if (entry.refCount <= 0) disarm(entry)
    }
  },

  /** Force an immediate (non-debounced) refetch for a root. Used after a git
   *  mutation (stage/commit/push/...) so the UI updates without waiting for the
   *  fs-watch debounce. No-op when the root has no subscribers. */
  refresh(rootPath: string): void {
    const entry = roots.get(rootPath)
    if (entry) refresh(entry)
  },

  /** Test-only: inject a live worktree list for `rootPath` and pin it so the
   *  real git fetch can't overwrite it. Lets the e2e perf harness make the
   *  worktree terrace render without a real on-disk repo. Marks the root as a
   *  repo and notifies subscribers (membership recomputes on the new snapshot). */
  _seedWorktrees(rootPath: string, worktrees: GitWorktreeEntry[]): void {
    if (!rootPath) return
    const entry = getRoot(rootPath)
    entry.pinned = true
    entry.snapshot = {
      isRepo: true,
      tracked: new Set(),
      statusFiles: [],
      branch: worktrees.find((w) => w.isPrimary)?.branch ?? 'main',
      ahead: 0,
      behind: 0,
      worktrees,
      revision: entry.snapshot.revision + 1,
    }
    notify(entry)
  },

  /** Test-only: clear all roots and timers. */
  _reset(): void {
    for (const entry of roots.values()) {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      entry.teardown?.()
      entry.disposed = true
    }
    roots.clear()
  },
}

// -----------------------------------------------------------------------------
// React hooks
// -----------------------------------------------------------------------------

/** Subscribe to a root's full git snapshot. Re-renders on every refresh. */
export function useGitStatusSnapshot(rootPath: string): GitStatusSnapshot {
  // useSyncExternalStore needs a stable subscribe bound to this rootPath.
  const subscribe = useMemo(
    () => (listener: Subscriber) => gitStatusStore.subscribe(rootPath, listener),
    [rootPath],
  )
  return useSyncExternalStore(
    subscribe,
    () => gitStatusStore.getSnapshot(rootPath),
    () => EMPTY_SNAPSHOT,
  )
}

/** Build the file-tree GitTree for a root (or undefined outside a repo),
 *  recomputed once per snapshot revision. Replaces the verbatim GitTree builder
 *  duplicated in FileExplorer and useGitTree. */
export function useGitTreeFor(rootPath: string): GitTree | undefined {
  const snap = useGitStatusSnapshot(rootPath)
  return useMemo(() => {
    if (!snap.isRepo) return undefined
    return {
      tracked: snap.tracked,
      decorations: buildGitTreeDecorations(snap.statusFiles, rootPath),
    }
    // revision changes whenever statusFiles/tracked change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, snap.revision, snap.isRepo])
}

/** Keep a root's git loop armed (and refresh on focus/fs/branch) without
 *  consuming the snapshot reactively — for hooks that read via getSnapshot. */
export function useGitStatusSubscription(rootPath: string, workspaceId?: string): void {
  useEffect(() => {
    if (!rootPath) return
    return gitStatusStore.subscribe(rootPath, () => {}, workspaceId)
  }, [rootPath, workspaceId])
}
