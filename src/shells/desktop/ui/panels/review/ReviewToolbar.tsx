import React from 'react'
import { Spinner } from '../../kernel/interaction'
import { boundWorktreeId, samePath } from '@workspace/repository/contract'
import { WorktreeSelector, useRepositoryUi, useWorktrees } from '../../workspace/repository'
import type { ReviewCheckoutState } from '@panels/review/contract'
import type { ReviewSend } from './useReview'

export function ReviewToolbar({ panelId, review, busy, send, children }: {
  panelId: string
  review: ReviewCheckoutState
  busy: boolean
  send: ReviewSend
  children?: React.ReactNode
}) {
  const worktrees = useWorktrees()
  const { root, previewPanelWorktree } = useRepositoryUi()
  const current = worktrees.find((tree) => !tree.isOrphan && samePath(tree.path, review.repoPath))
  return (
    <div className="review-toolbar-container w-full min-w-0 shrink-0" data-worktree-room style={{ containerType: 'inline-size', containerName: 'review-toolbar' }}>
      <div role="toolbar" aria-label="Review actions" className="review-toolbar min-w-0 h-[var(--bar-h)] flex flex-nowrap items-center gap-1 overflow-hidden px-[var(--bar-pad)] border-b border-subtle"
        style={{ backgroundColor: 'var(--node-chrome-bg, var(--surface-1))' }}>
        {current && (
          <div className="shrink-0 flex">
            <WorktreeSelector
              worktrees={worktrees}
              value={current.id}
              disabled={busy}
              onChange={(id) => void send({ kind: 'switchWorktree', worktreeId: boundWorktreeId(id, root) })}
              title="Review worktree"
              onPreview={(id) => previewPanelWorktree(panelId, id)}
            />
          </div>
        )}
        {busy && <Spinner size={14} label="Loading changes" />}
        {children}
      </div>
    </div>
  )
}
