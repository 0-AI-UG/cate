// =============================================================================
// useWorktreeStatuses — the expensive, display-only per-worktree facts: dirty
// status (one `git status` per worktree) and pull-request state (one `gh`
// lookup per branch). Extracted from the old sidebar so the canvas worktree
// drop-up can show the same plain-language status + PR chips. Only fetched while
// something that needs them is mounted (i.e. the drop-up is open).
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JoinedWorktree } from './useWorktrees'
import type { WorktreeStatus } from './useParallelWork'

export interface PrStatus {
  number: number
  state: string
  url: string
  isDraft: boolean
}

/** Turn a raw worktree status into a short, plain-language line + tone class. */
export function humanStatus(
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

export interface UseWorktreeStatuses {
  statusByPath: Record<string, WorktreeStatus>
  prByPath: Record<string, PrStatus>
  /** Re-fetch PR state (e.g. after opening one). */
  refreshPr: () => void
}

export function useWorktreeStatuses(rootPath: string, live: JoinedWorktree[]): UseWorktreeStatuses {
  const [statusByPath, setStatusByPath] = useState<Record<string, WorktreeStatus>>({})
  const [prByPath, setPrByPath] = useState<Record<string, PrStatus>>({})
  const [prNonce, setPrNonce] = useState(0)
  const refreshPr = useCallback(() => setPrNonce((n) => n + 1), [])

  // Per-worktree dirty status — refetched when the set of worktrees changes.
  const statusKey = useMemo(() => live.map((w) => w.path).join('|'), [live])
  useEffect(() => {
    if (!rootPath || live.length === 0) { setStatusByPath({}); return }
    let cancelled = false
    void (async () => {
      const entries = await Promise.all(
        live.map(async (w) => {
          try {
            const s = await window.electronAPI.gitWorktreeStatus(w.path)
            return s ? ([w.path, s] as const) : null
          } catch {
            return null
          }
        }),
      )
      if (cancelled) return
      const next: Record<string, WorktreeStatus> = {}
      for (const e of entries) if (e) next[e[0]] = e[1]
      setStatusByPath(next)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, statusKey])

  // PR status — only for non-primary branches, refetched when the branch set
  // changes or after a PR action (each lookup shells out to `gh`).
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

  return { statusByPath, prByPath, refreshPr }
}
