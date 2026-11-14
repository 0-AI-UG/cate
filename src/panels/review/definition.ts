// The review panel type: recorded agent edits. Pure.

import { channel } from '@kernel/rpc/contract'
import { definePanel } from '@panels/framework/contract'
import type { JsonObject } from '@workspace/document/contract'
import {
  reviewRepoPath,
  type ReviewCreateOptions,
  type ReviewFields,
  type ReviewOp,
  type ReviewOpenRequest,
  type ReviewSnapshot,
} from './contract/types'

function fields(repoPath: string, request: ReviewOpenRequest | undefined): JsonObject {
  const value: ReviewFields = request ? { repoPath, request } : { repoPath }
  return value as unknown as JsonObject
}

export default definePanel({
  type: 'review',
  label: 'Agent Review',
  icon: 'git-compare',
  defaultSize: { width: 640, height: 500 },
  minimumSize: { width: 320, height: 220 },
  dropSize: { width: 540, height: 420 },
  canLiveOnCanvas: true,
  navigable: true,
  creation: { order: 8, toolbar: true, inWorktree: true },
  defaultTitle: 'Agent Review',
  channel: channel<ReviewSnapshot, Partial<ReviewSnapshot>, ReviewOp>(),
  fields: (options: ReviewCreateOptions) => fields(options.repoPath ?? '', options.request),
  create: (options: ReviewCreateOptions, kit) => {
    const bound = options.worktreeId ? kit.document().worktrees[options.worktreeId]?.path : undefined
    const repoPath = options.repoPath ?? bound ?? ''
    const record = kit.record('review', {
      id: kit.newId(),
      title: options.title,
      worktreeId: options.worktreeId ?? kit.worktreeIdForPath(repoPath || undefined),
      fields: fields(repoPath, options.request),
    })
    return kit.add(record, options)
  },
  checkoutPath: (record) => reviewRepoPath(record.fields) || undefined,
  describe: (record) => reviewRepoPath(record.fields) || undefined,
  commands: [
    { id: 'review.refresh', title: 'Refresh Review', op: { kind: 'refresh' } },
  ],
  chrome: { worktreeChip: true },
  relation: {
    produces: 'changes',
    targetOptions: {
      execution: [['verify', 'Review in'], ['use', 'Use changes in'], ['context', 'Reference']],
      changes: [['verify', 'Review in'], ['context', 'Reference'], ['use', 'Use changes in']],
      findings: [['verify', 'Review in'], ['context', 'Reference'], ['use', 'Use changes in']],
      notes: [['context', 'Compare with'], ['verify', 'Review in'], ['use', 'Use changes in']],
    },
    instruction: () => 'Review the recorded agent edits. Report findings in your response; do not edit files unless asked.',
  },
})
