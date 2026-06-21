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

  it('matches by path when the tag is a raw path (useWorktrees id fallback)', () => {
    // A panel tagged before metadata existed stores the path as its worktreeId.
    expect(resolveWorktree(WT.path, [WT])?.id).toBe('wt-x')
  })

  it('matches a path tag across separator/case differences (Windows)', () => {
    const win: WorktreeMeta = { id: 'wt-y', path: 'C:/repo/wt', color: '#000' }
    expect(resolveWorktree('C:\\repo\\wt', [win])?.id).toBe('wt-y')
  })

  it('returns undefined for an unknown tag (orphan → caller falls back to root)', () => {
    expect(resolveWorktree('wt-gone', [WT])).toBeUndefined()
  })

  it('returns undefined when nothing is tagged', () => {
    expect(resolveWorktree(undefined, [WT])).toBeUndefined()
  })
})
