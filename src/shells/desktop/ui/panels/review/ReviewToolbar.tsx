import React from 'react'
import { Spinner } from '../../kernel/interaction'
import { boundWorktreeId, samePath } from '@workspace/repository/contract'
import { WorktreeSelector, useRepositoryUi, useWorktrees } from '../../workspace/repository'
import type { ReviewCheckoutState } from '@panels/review/contract'
import type { ReviewSend } from './useReview'

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
      <div role="toolbar" aria-label="Review actions" className="review-toolbar min-w-0 flex flex-wrap items-center gap-1.5 px-2 py-1.5 border-b border-subtle bg-surface-1">
        {current && (
          <div className="shrink-0 flex">
            <WorktreeSelector
              worktrees={worktrees}
              value={current.id}
              disabled={busy}
              onChange={(id) => void send({ kind: 'switchWorktree', worktreeId: boundWorktreeId(id, root) })}
              title="Review worktree"
            />
          </div>
        )}
        {busy && <Spinner size={14} label="Loading changes" />}
        {children}
      </div>
    </div>
  )
}
