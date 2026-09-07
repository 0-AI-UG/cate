import { afterEach, expect, it, vi } from 'vitest'
import { createExplorerRefresh } from './explorerRefresh'

afterEach(() => vi.useRealTimers())

it('reads only affected loaded directories and ignores content-only edits', async () => {
  vi.useFakeTimers()
  const read = vi.fn(async () => ['file'])
  const apply = vi.fn()
  const remove = vi.fn()
  const queue = createExplorerRefresh({ root: '/repo', loaded: () => ['/repo/a', '/repo/b'], read, apply, remove })
  queue.event({ type: 'update', path: '/repo/a/file' })
  queue.event({ type: 'create', path: '/repo/a/new' })
  queue.event({ type: 'delete', path: '/repo/a/old' })
  queue.event({ type: 'create', path: '/repository/unrelated' })
  await vi.advanceTimersByTimeAsync(150)
  expect(read.mock.calls).toEqual([['/repo/a']])
  expect(apply).toHaveBeenCalledWith('/repo/a', ['file'])
  expect(remove).toHaveBeenCalledWith('/repo/a/old')
  queue.dispose()
})

it('retains changes during in-flight reads, caps concurrency, and drops disposed results', async () => {
  vi.useFakeTimers()
  const releases: Array<() => void> = []
  const read = vi.fn(() => new Promise<string[]>((resolve) => releases.push(() => resolve(['new']))))
  const apply = vi.fn()
  const queue = createExplorerRefresh({ root: '/repo', loaded: () => [], read, apply, remove: vi.fn() })
  queue.refresh(['/repo/a', '/repo/b', '/repo/c', '/repo/d', '/repo/e'])
  await vi.advanceTimersByTimeAsync(150)
  expect(read).toHaveBeenCalledTimes(4)
  queue.refresh(['/repo/a'])
  releases.splice(0).forEach((release) => release())
  await vi.advanceTimersByTimeAsync(0)
  expect(read).toHaveBeenCalledTimes(6)
  expect(apply.mock.calls.map(([path]) => path)).not.toContain('/repo/a')
  queue.dispose()
  releases.forEach((release) => release())
  await vi.advanceTimersByTimeAsync(0)
  expect(apply).toHaveBeenCalledTimes(3)
})
