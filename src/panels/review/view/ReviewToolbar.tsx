import React from 'react'
import { Spinner } from '@kernel/ui'
import { useDocument } from '@client/document/ui'
import type { WorktreeMeta } from '@workspace/document/contract'
import { worktreeForPath } from '@workspace/repository/contract'
import type { ReviewCheckoutState, ReviewComparisonKind } from '../contract'
import type { ReviewSend } from './useReview'

const MODES: ReadonlyArray<{ value: ReviewComparisonKind; label: string }> = [
  { value: 'uncommitted', label: 'All Changes' },
  { value: 'unstaged', label: 'Changes' },
  { value: 'staged', label: 'Staged Changes' },
  { value: 'commit', label: 'Commit' },
  { value: 'branch', label: 'Branch' },
  { value: 'agent', label: 'Agent changes' },
]

const sameWorktrees = (a: WorktreeMeta[], b: WorktreeMeta[]) => a.length === b.length && a.every((item, index) => item === b[index])

export function ReviewToolbar({ workspaceId, review, busy, send, children }: {
  workspaceId: string
  review: ReviewCheckoutState
  busy: boolean
  send: ReviewSend
  children?: React.ReactNode
}) {
  const worktrees = useDocument(workspaceId, (doc) => Object.values(doc.worktrees), sameWorktrees)
  const current = worktreeForPath(review.repoPath, worktrees)
  return (
    <div className="review-toolbar-container w-full min-w-0 shrink-0" style={{ containerType: 'inline-size', containerName: 'review-toolbar' }}>
      <div className="review-toolbar min-w-0 flex flex-nowrap items-center gap-1.5 px-2 py-1.5 border-b border-subtle bg-surface-1">
        <select
          aria-label="Comparison"
          value={review.agentChanges ? 'agent' : review.spec.kind}
          disabled={busy}
          onChange={(event) => void send({ kind: 'selectComparison', comparison: event.target.value as ReviewComparisonKind })}
          className="review-comparison h-7 min-w-0 rounded-lg bg-surface-2 border border-subtle px-2 text-[12px] focus:outline-none"
        >
          {MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
        </select>
        {worktrees.length > 1 && (
          <select
            aria-label="Diff panel worktree"
            title="Diff panel worktree"
            value={current?.id ?? ''}
            disabled={busy}
            onChange={(event) => void send({ kind: 'switchWorktree', worktreeId: event.target.value || null })}
            className="review-worktree h-7 min-w-0 max-w-40 rounded-lg bg-surface-2 border border-subtle px-2 text-[12px] focus:outline-none"
          >
            {!current && <option value="">{review.repoPath}</option>}
            {worktrees.map((tree) => <option key={tree.id} value={tree.id}>{tree.label ?? tree.path.split(/[/\\]/).pop()}</option>)}
          </select>
        )}
        {busy && <Spinner size={14} label="Loading comparison" />}
        {children}
      </div>
    </div>
  )
}
