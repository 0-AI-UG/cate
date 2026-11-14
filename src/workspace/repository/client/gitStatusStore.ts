// The client's git status: one `vcs.status` subscription per checkout, shared
// by every view that shows it (file tree tint, source control, worktree
// pills). The runtime polls and pushes; this store only mirrors, and fetches
// the tracked file list when the status moves.

import { errorMessage } from '@kernel/interaction'
import type { CapabilityProxy } from '@kernel/rpc/contract'
import { checkoutPathKey, EMPTY_REPO_STATUS, type RepoStatus, type VcsCapability } from '../contract'

export type GitStatusClient = Pick<CapabilityProxy<VcsCapability>, 'status' | 'lsFiles'>

export interface GitStatusSnapshot extends RepoStatus {
  /** Pending until the runtime sends the first status; false also on failure. */
  loading: boolean
  error: string | null
  /** Absolute forward-slash paths of tracked and untracked-not-ignored files,
   *  for dimming ignored files. */
  tracked: ReadonlySet<string>
  /** Bumped on repository invalidations, not tracked-file decoration loading. */
  revision: number
}

export const EMPTY_GIT_STATUS: GitStatusSnapshot = Object.freeze({
  ...EMPTY_REPO_STATUS,
  loading: true,
  error: null,
  tracked: new Set<string>(),
  revision: 0,
})

export interface GitStatusStore {
  /** EMPTY_GIT_STATUS until the first snapshot arrives. */
  getSnapshot(cwd: string): GitStatusSnapshot
  /** Keeps the checkout's subscription open while anyone listens. */
  subscribe(cwd: string, listener: () => void): () => void
  dispose(): void
}

interface Entry {
  cwd: string
  snapshot: GitStatusSnapshot
  listeners: Set<() => void>
  cancel: () => void
  trackedSeq: number
  trackedKey: string | null
  closed: boolean
}

const posix = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

export function createGitStatusStore(vcs: GitStatusClient): GitStatusStore {
  const entries = new Map<string, Entry>()
  let revision = 0

  const notify = (entry: Entry) => {
    for (const listener of [...entry.listeners]) listener()
  }

  const update = (entry: Entry, patch: Partial<GitStatusSnapshot>, contentChanged = false) => {
    entry.snapshot = { ...entry.snapshot, ...patch, revision: contentChanged ? ++revision : entry.snapshot.revision }
    notify(entry)
  }

  function refreshTracked(entry: Entry, status: RepoStatus): void {
    const key = status.isRepo ? JSON.stringify([status.branch, status.files]) : null
    if (key === entry.trackedKey) return
    entry.trackedKey = key
    const seq = ++entry.trackedSeq
    if (!status.isRepo) {
      if (entry.snapshot.tracked.size > 0) update(entry, { tracked: new Set() })
      return
    }
    vcs.lsFiles({ cwd: entry.cwd }).then(
      (files) => {
        if (entry.closed || seq !== entry.trackedSeq) return
        const root = posix(entry.cwd)
        update(entry, { tracked: new Set(files.map((f) => `${root}/${f}`)) })
      },
      () => { /* keep the previous list; the next status change retries */ },
    )
  }

  function open(cwd: string, previous?: Entry): Entry {
    const entry: Entry = {
      cwd,
      snapshot: previous?.snapshot ?? EMPTY_GIT_STATUS,
      listeners: new Set(),
      cancel: () => {},
      trackedSeq: 0,
      trackedKey: null,
      closed: false,
    }
    const sub = vcs.status({ cwd }, { resume: true })
    sub.onEvent((event) => {
      if (entry.closed) return
      const status = event.kind === 'snapshot' ? event.snapshot : event.change
      update(entry, { ...status, loading: false, error: null }, true)
      refreshTracked(entry, status)
    })
    sub.done.catch((err) => {
      // A failed read is not evidence that this folder is not a repository.
      if (!entry.closed) update(entry, { loading: false, error: errorMessage(err, 'Could not load Git status.') })
    })
    entry.cancel = () => sub.cancel()
    return entry
  }

  function close(key: string, entry: Entry): void {
    if (entry.closed) return
    entry.closed = true
    entry.cancel()
    // Keep the last snapshot for a warm reopen, but release its subscription.
    entries.delete(key)
    entries.set(key, entry)
    for (const [idleKey, idle] of entries) {
      if (entries.size <= 64) break
      if (idle.closed) entries.delete(idleKey)
    }
  }

  return {
    getSnapshot(cwd) {
      return entries.get(checkoutPathKey(cwd))?.snapshot ?? EMPTY_GIT_STATUS
    },
    subscribe(cwd, listener) {
      if (!cwd) return () => {}
      const key = checkoutPathKey(cwd)
      let entry = entries.get(key)
      if (!entry || entry.closed) {
        entry = open(cwd, entry)
        entries.set(key, entry)
      }
      const current = entry
      current.listeners.add(listener)
      return () => {
        if (!current.listeners.delete(listener)) return
        if (current.listeners.size === 0 && entries.get(key) === current) close(key, current)
      }
    },
    dispose() {
      for (const [key, entry] of [...entries]) close(key, entry)
      entries.clear()
    },
  }
}
