import React from 'react'
import { Spinner } from '../../kernel/interaction'
import { boundWorktreeId, samePath } from '@workspace/repository/contract'
import { WorktreeSelector, useRepositoryUi, useWorktrees } from '../../workspace/repository'
import type { ReviewCheckoutState } from '@panels/review/contract'
import type { ReviewSend } from './useReview'

export function ReviewToolbar({ panelId, review, busy, send, scope, center, actions }: {
  panelId: string
  review: ReviewCheckoutState
  busy: boolean
  send: ReviewSend
  scope: React.ReactNode
  center: React.ReactNode
  actions: React.ReactNode
}) {
  const worktrees = useWorktrees()
  const { root, previewPanelWorktree } = useRepositoryUi()
  const current = worktrees.find((tree) => !tree.isOrphan && samePath(tree.path, review.repoPath))
  return (
    <div className="w-full min-w-0 shrink-0" data-worktree-room style={{ containerType: 'inline-size', containerName: 'review-toolbar' }}>
      <div role="toolbar" aria-label="Review actions" className="review-toolbar grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(5rem,1fr)] h-[var(--bar-h)] items-center gap-1.5 border-b border-subtle px-[var(--bar-pad)]"
        style={{ backgroundColor: 'var(--node-chrome-bg, var(--surface-1))' }}>
        <div className="flex min-w-0 items-center gap-1">
          {current && (
            <WorktreeSelector
              worktrees={worktrees}
              value={current.id}
              disabled={busy}
              onChange={(id) => void send({ kind: 'switchWorktree', worktreeId: boundWorktreeId(id, root) })}
              title="Review worktree"
              onPreview={(id) => previewPanelWorktree(panelId, id)}
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
