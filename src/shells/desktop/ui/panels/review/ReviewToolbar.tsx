import React from 'react'
import { Spinner } from '../../kernel/interaction'
import { boundWorktreeId, samePath } from '@workspace/repository/contract'
import { WorktreeSelector, useRepositoryUi, useWorktrees } from '../../workspace/repository'
import type { ReviewCheckoutState, ReviewComparisonKind } from '@panels/review/contract'
import type { ReviewSend } from './useReview'

const MODES: ReadonlyArray<{ value: ReviewComparisonKind; label: string }> = [
  { value: 'uncommitted', label: 'All Changes' },
  { value: 'unstaged', label: 'Changes' },
  { value: 'staged', label: 'Staged Changes' },
  { value: 'commit', label: 'Commit' },
  { value: 'branch', label: 'Branch' },
  { value: 'agent', label: 'Agent changes' },
]

export function ReviewToolbar({ review, busy, send, children }: {
  review: ReviewCheckoutState
  busy: boolean
  send: ReviewSend
  children?: React.ReactNode
}) {
  const worktrees = useWorktrees()
  const { root } = useRepositoryUi()
  const current = worktrees.find((tree) => !tree.isOrphan && samePath(tree.path, review.repoPath))
  return (
    <div className="review-toolbar-container w-full min-w-0 shrink-0" data-worktree-room style={{ containerType: 'inline-size', containerName: 'review-toolbar' }}>
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
        {current && (
          <div className="shrink-0 flex">
            <WorktreeSelector
              worktrees={worktrees}
              value={current.id}
              disabled={busy}
              onChange={(id) => void send({ kind: 'switchWorktree', worktreeId: boundWorktreeId(id, root) })}
              title="Diff panel worktree"
            />
          </div>
        )}
        {busy && <Spinner size={14} label="Loading comparison" />}
        {children}
      </div>
    </div>
  )
}
