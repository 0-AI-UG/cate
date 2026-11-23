import React from 'react'
import { Spinner } from '../../kernel/interaction'
import { boundWorktreeId, samePath } from '@workspace/repository/contract'
import { WorktreeSelector, useRepositoryUi, useWorktrees } from '../../workspace/repository'
import type { ReviewCheckoutState } from '@panels/review/contract'
import type { ReviewSend } from './useReview'

export function ReviewToolbar({ review, busy, send, scope, center, actions }: {
  review: ReviewCheckoutState
  busy: boolean
  send: ReviewSend
  scope: React.ReactNode
  center: React.ReactNode
  actions: React.ReactNode
}) {
  const worktrees = useWorktrees()
  const { root } = useRepositoryUi()
  const current = worktrees.find((tree) => !tree.isOrphan && samePath(tree.path, review.repoPath))
  return (
    <div className="w-full min-w-0 shrink-0" data-worktree-room style={{ containerType: 'inline-size', containerName: 'review-toolbar' }}>
      <div role="toolbar" aria-label="Review actions" className="review-toolbar grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(5.75rem,1fr)] items-center gap-1.5 border-b border-subtle bg-surface-1 px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-1">
          {current && (
            <WorktreeSelector
              worktrees={worktrees}
              value={current.id}
              disabled={busy}
              onChange={(id) => void send({ kind: 'switchWorktree', worktreeId: boundWorktreeId(id, root) })}
              title="Review worktree"
            />
          )}
          {scope}
        </div>
        <div className="flex min-w-0 items-center justify-center">
          {busy && !center ? <Spinner size={14} label="Loading changes" /> : center}
        </div>
        <div className="review-toolbar-actions flex items-center justify-end gap-1">{actions}</div>
      </div>
    </div>
  )
}
