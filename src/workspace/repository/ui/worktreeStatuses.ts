// The display-only per-worktree facts: dirty status (one `git status` per
// checkout) and PR state (one `gh` lookup per branch). Fetched only while a
// view that shows them is mounted.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRuntime } from '@kernel/rpc/ui'
import type { JoinedWorktree, PrStatusResult, WorktreeStatusResult } from '../contract'
import { fetchWorktreePrs, fetchWorktreeStatuses } from '../client'

/** A raw worktree status as a short plain-language line and a tone class. */
export function humanStatus(
  status: WorktreeStatusResult | undefined,
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
  if (status.ahead > 0) return { text: `${status.ahead} to publish`, tone: 'text-green-400/70' }
  if (status.behind > 0) return { text: `${status.behind} behind ${primaryLabel}`, tone: 'text-blue-400/70' }
  return { text: 'in sync', tone: 'text-muted' }
}

export interface WorktreeStatuses {
  statusByPath: Record<string, WorktreeStatusResult>
  prByPath: Record<string, PrStatusResult>
  /** Re-fetch PR state (after creating one). */
  refreshPr: () => void
}

export function useWorktreeStatuses(workspaceId: string, live: JoinedWorktree[]): WorktreeStatuses {
  const runtime = useRuntime(workspaceId)
  const [statusByPath, setStatusByPath] = useState<Record<string, WorktreeStatusResult>>({})
  const [prByPath, setPrByPath] = useState<Record<string, PrStatusResult>>({})
  const [prNonce, setPrNonce] = useState(0)
  const refreshPr = useCallback(() => setPrNonce((n) => n + 1), [])

  const statusKey = useMemo(() => live.map((w) => w.path).join('|'), [live])
  useEffect(() => {
    if (!runtime || live.length === 0) { setStatusByPath({}); return }
    let cancelled = false
    void fetchWorktreeStatuses(runtime.vcs, live).then((next) => { if (!cancelled) setStatusByPath(next) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, statusKey])

  const prKey = useMemo(
    () => live.filter((w) => !w.isPrimary && w.branch).map((w) => `${w.path}:${w.prNumber ?? w.branch}`).join('|'),
    [live],
  )
  useEffect(() => {
    if (!runtime || !prKey) { setPrByPath({}); return }
    let cancelled = false
    void fetchWorktreePrs(runtime.vcs, live).then((next) => { if (!cancelled) setPrByPath(next) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, prKey, prNonce])

  return { statusByPath, prByPath, refreshPr }
}
