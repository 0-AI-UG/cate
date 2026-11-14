import { expect, it, vi } from 'vitest'
import { createRepositoryReadCache } from './readCache'

const readers = () => ({ compare: vi.fn(), fileDiff: vi.fn(), fileContent: vi.fn(), findRepos: vi.fn(), remotes: vi.fn(), log: vi.fn() })
const args = { cwd: '/repo', spec: { kind: 'uncommitted' as const } }

it('shares pending reads and reuses a result until the content revision changes', async () => {
  const vcs = readers()
  let finish!: (value: unknown) => void
  vcs.compare.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  const cache = createRepositoryReadCache(vcs)
  const first = cache.read('compare', args, '1')
  expect(cache.read('compare', args, '1')).toBe(first)
  const value = { files: ['first'] }
  finish(value)
  await first
  expect(cache.peek('compare', args)).toBe(value)
  await cache.read('compare', args, '1')
  expect(vcs.compare).toHaveBeenCalledOnce()
  const next = cache.read('compare', args, '2')
  expect(cache.peek('compare', args)).toBe(value)
  finish({ files: ['next'] })
  await next
  expect(cache.peek('compare', args)).toEqual({ files: ['next'] })
})

it('does not let an older response overwrite a newer revision', async () => {
  const vcs = readers()
  const finish: Array<(value: unknown) => void> = []
  vcs.compare.mockImplementation(() => new Promise((resolve) => { finish.push(resolve) }))
  const cache = createRepositoryReadCache(vcs)
  const old = cache.read('compare', args, '1')
  const current = cache.read('compare', args, '2')
  finish[1]({ files: ['current'] }); await current
  finish[0]({ files: ['old'] }); await old
  expect(cache.peek('compare', args)).toEqual({ files: ['current'] })
})

it('revalidates unversioned discovery reads without losing the last success on failure', async () => {
  const vcs = readers()
  const cache = createRepositoryReadCache(vcs)
  vcs.findRepos.mockResolvedValueOnce(['/repo']).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(['/repo', '/repo/nested'])
  await cache.read('findRepos', { dir: '/repo' })
  await expect(cache.read('findRepos', { dir: '/repo' })).rejects.toThrow('offline')
  expect(cache.peek('findRepos', { dir: '/repo' })).toEqual(['/repo'])
  await cache.read('findRepos', { dir: '/repo' })
  expect(cache.peek('findRepos', { dir: '/repo' })).toEqual(['/repo', '/repo/nested'])
})

it('evicts old results to stay within its memory budget', async () => {
  const vcs = readers()
  vcs.findRepos.mockResolvedValue(['a'])
  const cache = createRepositoryReadCache(vcs, 40)
  for (let i = 0; i < 5; i++) await cache.read('findRepos', { dir: String(i) })
  expect(cache.peek('findRepos', { dir: '0' })).toBeUndefined()
  expect(cache.peek('findRepos', { dir: '4' })).toEqual(['a'])
})
