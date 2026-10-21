// The review panel type: a Git comparison of a checkout, or an agent's
// recorded edits, with notes. Pure.

import { channel } from '@kernel/rpc/contract'
import { definePanel } from '@panels/framework/contract'
import type { JsonObject } from '@workspace/document/contract'
import { reviewApi } from './contract/api'
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
  label: 'Diff Review',
  icon: 'git-compare',
  defaultSize: { width: 1000, height: 700 },
  minimumSize: { width: 320, height: 220 },
  dropSize: { width: 820, height: 560 },
  canLiveOnCanvas: true,
  navigable: true,
  creation: { order: 8, toolbar: true, inWorktree: true },
  defaultTitle: 'Diff Review',
  channel: channel<ReviewSnapshot, Partial<ReviewSnapshot>, ReviewOp>(),
  api: reviewApi,
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
    produces: 'notes',
    targetOptions: {
      execution: [['verify', 'Review in'], ['use', 'Address notes in'], ['context', 'Reference']],
      changes: [['verify', 'Review in'], ['context', 'Reference'], ['use', 'Address notes in']],
      findings: [['verify', 'Review in'], ['context', 'Reference'], ['use', 'Address notes in']],
      notes: [['context', 'Compare with'], ['verify', 'Review in'], ['use', 'Address notes in']],
    },
    instruction: (kind) => `${kind === 'verify'
      ? 'Review its diff and record findings as notes'
      : kind === 'use' ? 'Work through its open notes and resolve them' : 'Read its diff and notes'} through Cate review commands.`,
  },
})
