import { describe, expect, it, vi } from 'vitest'
import { formatLocator } from './runtime/locator'
import {
  listWorktreeCheckouts,
  resolveWorktreeContext,
  validateWorktreeContext,
} from './worktreeContext'

describe('worktreeContext', () => {
  it('resolves base and checkout paths on the same runtime', () => {
    const base = formatLocator({ runtimeId: 'server-1', path: '/repo' })
    const checkout = formatLocator({ runtimeId: 'server-1', path: '/repo-feature' })

    expect(resolveWorktreeContext(base, checkout)).toEqual({
      runtimeId: 'server-1',
      base: { locator: base, path: '/repo' },
      checkout: { locator: checkout, path: '/repo-feature' },
    })
  })

  it('rejects paths from different runtimes', () => {
    const base = formatLocator({ runtimeId: 'server-1', path: '/repo' })
    const checkout = formatLocator({ runtimeId: 'server-2', path: '/repo-feature' })

    expect(resolveWorktreeContext(base, checkout)).toBeUndefined()
  })

  it('validates base and checkout against one workspace scope', async () => {
    const validatePathStrict = vi.fn(async (path: string) => `/safe${path}`)
    const context = resolveWorktreeContext('/repo', '/repo-feature')!

    const result = await validateWorktreeContext(
      context,
      { validatePathStrict },
      7,
      'workspace-1',
    )

    expect(validatePathStrict).toHaveBeenNthCalledWith(1, '/repo', 7, 'workspace-1')
    expect(validatePathStrict).toHaveBeenNthCalledWith(2, '/repo-feature', 7, 'workspace-1')
    expect(result.base).toEqual({ locator: '/safe/repo', path: '/safe/repo' })
    expect(result.checkout).toEqual({
      locator: '/safe/repo-feature',
      path: '/safe/repo-feature',
    })
  })

  it('lists non-bare checkouts on the base runtime', async () => {
    const worktreeList = vi.fn().mockResolvedValue([
      { path: '/repo', branch: 'main', isBare: false },
      { path: '/repo-feature', branch: 'feature', isBare: false },
      { path: '/repo.git', branch: '(unknown)', isBare: true },
    ])
    const base = formatLocator({ runtimeId: 'server-1', path: '/repo' })

    const result = await listWorktreeCheckouts(
      base,
      { vcs: { worktreeList } as never },
      { ownerWindowId: 7, scopeId: 'workspace-1' },
    )

    expect(worktreeList).toHaveBeenCalledWith('/repo', {
      ownerWindowId: 7,
      scopeId: 'workspace-1',
    })
    expect(result).toEqual([
      formatLocator({ runtimeId: 'server-1', path: '/repo' }),
      formatLocator({ runtimeId: 'server-1', path: '/repo-feature' }),
    ])
  })
})
