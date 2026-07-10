import { describe, it, expect } from 'vitest'
import { resolveWorktree } from './worktrees'
import type { WorktreeMeta } from './types'

const WT: WorktreeMeta = {
  id: 'wt-x',
  path: '/repo/.cate/worktrees/x',
  color: '#11aa55',
}

describe('resolveWorktree', () => {
  it('matches by stable id', () => {
    expect(resolveWorktree('wt-x', [WT])?.path).toBe(WT.path)
  })

  it('does not treat a checkout path as an id', () => {
    expect(resolveWorktree(WT.path, [WT])).toBeUndefined()
  })

  it('returns undefined for an unknown tag (orphan → caller falls back to root)', () => {
    expect(resolveWorktree('wt-gone', [WT])).toBeUndefined()
  })

  it('returns undefined when nothing is tagged', () => {
    expect(resolveWorktree(undefined, [WT])).toBeUndefined()
  })
})
