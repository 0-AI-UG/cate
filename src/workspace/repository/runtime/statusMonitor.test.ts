import { afterEach, expect, it, vi } from 'vitest'
import { EMPTY_REPO_STATUS, type RepoStatus } from '../contract'
import { createStatusMonitors, POLL_MAX_MS, POLL_MIN_MS } from './statusMonitor'

afterEach(() => { vi.useRealTimers() })

const status = (branch: string, dirty = false): RepoStatus => ({ ...EMPTY_REPO_STATUS, isRepo: true, branch, dirty })

it('shares one monitor per checkout and backs off while nothing changes', async () => {
  vi.useFakeTimers()
  const probe = vi.fn().mockResolvedValue({ branch: 'main', dirty: false, branches: ['main'] })
  const snapshot = vi.fn().mockResolvedValue(status('main'))
  const monitors = createStatusMonitors({ probe, snapshot })
  const a = vi.fn()
  const b = vi.fn()
  const offA = monitors.subscribe('/repo', a)
  const offB = monitors.subscribe('/repo/', b)
  await vi.advanceTimersByTimeAsync(0)
  expect(snapshot).toHaveBeenCalledTimes(1)
  expect(a).toHaveBeenCalledWith(status('main'))
  expect(b).toHaveBeenCalledTimes(1)

  // Unchanged probes: 2 s, then 4 s, 8 s ... never re-reading the snapshot.
  await vi.advanceTimersByTimeAsync(POLL_MIN_MS)
  expect(probe).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(POLL_MIN_MS * 2)
  expect(probe).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(POLL_MAX_MS * 4)
  expect(probe.mock.calls.length).toBeLessThan(9)
  expect(snapshot).toHaveBeenCalledTimes(1)

  // A changed probe reads a snapshot and notifies once.
  probe.mockResolvedValue({ branch: 'next', dirty: true, branches: ['main', 'next'] })
  snapshot.mockResolvedValue(status('next', true))
  await vi.advanceTimersByTimeAsync(POLL_MAX_MS)
  expect(a).toHaveBeenLastCalledWith(status('next', true))
  expect(a).toHaveBeenCalledTimes(2)

  offA()
  offB()
  expect(vi.getTimerCount()).toBe(0)
  monitors.dispose()
})

it('does not resurrect a stopped monitor when its in-flight poll completes', async () => {
  vi.useFakeTimers()
  let finish!: (value: unknown) => void
  const probe = vi.fn(() => new Promise((resolve) => { finish = resolve }))
  const snapshot = vi.fn().mockResolvedValue(status('main'))
  const monitors = createStatusMonitors({ probe: probe as never, snapshot })
  const listener = vi.fn()
  const off = monitors.subscribe('/repo', listener)
  expect(probe).toHaveBeenCalledTimes(1)
  off()
  finish({ branch: 'main', dirty: false, branches: ['main'] })
  await vi.advanceTimersByTimeAsync(120_000)
  expect(probe).toHaveBeenCalledTimes(1)
  expect(listener).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('reads a fresh snapshot on file changes and kicks, and replays the last one to late subscribers', async () => {
  vi.useFakeTimers()
  let onChange!: (changedPath: string) => void
  const unwatch = vi.fn()
  const probe = vi.fn().mockResolvedValue({ branch: 'main', dirty: false, branches: ['main'] })
  const snapshot = vi.fn().mockResolvedValue(status('main'))
  const monitors = createStatusMonitors({ probe, snapshot, watch: (_dir, cb) => { onChange = cb; return unwatch } })
  const off = monitors.subscribe('/repo', vi.fn())
  await vi.advanceTimersByTimeAsync(0)

  snapshot.mockResolvedValue(status('main', true))
  onChange('/repo/a.ts')
  onChange('/repo/a.ts')
  await vi.advanceTimersByTimeAsync(200)
  expect(snapshot).toHaveBeenCalledTimes(2)
  expect(monitors.current('/repo')?.dirty).toBe(true)

  monitors.kick()
  await vi.advanceTimersByTimeAsync(0)
  expect(snapshot).toHaveBeenCalledTimes(3)

  const late = vi.fn()
  const offLate = monitors.subscribe('/repo', late)
  expect(late).toHaveBeenCalledWith(status('main', true))
  offLate()
  off()
  expect(unwatch).toHaveBeenCalledOnce()
})

it('reads no snapshot for file changes git ignores', async () => {
  vi.useFakeTimers()
  const probe = vi.fn().mockResolvedValue({ branch: 'main', dirty: false, branches: ['main'] })
  const snapshot = vi.fn().mockResolvedValue(status('main'))
  let emit!: (changedPath: string) => void
  const allIgnored = vi.fn(async (_cwd: string, paths: string[]) => paths.every((p) => p.startsWith('/repo/dist/')))
  const monitors = createStatusMonitors({ probe, snapshot, allIgnored, watch: (_dir, onChange) => { emit = onChange; return () => {} } })
  const off = monitors.subscribe('/repo', vi.fn())
  await vi.advanceTimersByTimeAsync(0)
  expect(snapshot).toHaveBeenCalledTimes(1)

  emit('/repo/dist/a.js')
  emit('/repo/dist/b.js')
  await vi.advanceTimersByTimeAsync(200)
  expect(allIgnored).toHaveBeenLastCalledWith('/repo', ['/repo/dist/a.js', '/repo/dist/b.js'])
  expect(snapshot).toHaveBeenCalledTimes(1)

  emit('/repo/dist/c.js')
  emit('/repo/src/main.ts')
  await vi.advanceTimersByTimeAsync(200)
  expect(snapshot).toHaveBeenCalledTimes(2)

  off()
  monitors.dispose()
})
