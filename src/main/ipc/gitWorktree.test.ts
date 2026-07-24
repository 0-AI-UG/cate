import { describe, expect, test } from 'vitest'
import { worktreeTargetPath } from './git'
import { formatLocator, LOCAL_RUNTIME_ID } from '../../shared/runtimeLocator'

describe('worktreeTargetPath', () => {
  test('remote target on the same runtime decodes to the bare path', () => {
    const loc = formatLocator({ runtimeId: 'srv_abc', path: '/home/u/proj/.cate/worktrees/wt-1' })
    expect(worktreeTargetPath('srv_abc', loc)).toBe('/home/u/proj/.cate/worktrees/wt-1')
  })

  test('a target on a different runtime than its repo throws', () => {
    const loc = formatLocator({ runtimeId: 'srv_other', path: '/home/u/p/.cate/worktrees/x' })
    expect(() => worktreeTargetPath('srv_abc', loc)).toThrow(/same runtime/)
  })

  test('a local repo with a bare local target returns the path verbatim', () => {
    expect(worktreeTargetPath(LOCAL_RUNTIME_ID, '/Users/me/proj/.cate/worktrees/wt')).toBe(
      '/Users/me/proj/.cate/worktrees/wt',
    )
  })

  test('round-trips a path with spaces and reserved chars without corruption', () => {
    const path = '/home/u/my proj/.cate/worktrees/feature x'
    const loc = formatLocator({ runtimeId: 'srv_abc', path })
    expect(worktreeTargetPath('srv_abc', loc)).toBe(path)
  })
})
