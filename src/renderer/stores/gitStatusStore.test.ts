// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

// Capture the fsWatch listeners so a test can fire a synthetic fs event and
// assert exactly one shared watcher per root.
const watchCalls: Array<{ rootPath: string; listener: () => void }> = []
let releaseCount = 0
vi.mock('../lib/fs/fsWatchManager', () => ({
  watchFsRoot: (rootPath: string, listener: () => void) => {
    watchCalls.push({ rootPath, listener })
    return () => { releaseCount += 1 }
  },
}))

import { gitStatusStore } from './gitStatusStore'

const ROOT = '/repo'

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    gitIsRepo: vi.fn(async () => true),
    gitLsFiles: vi.fn(async () => ['a.ts', 'b.ts']),
    gitStatus: vi.fn(async () => ({
      files: [{ path: 'a.ts', index: ' ', working_dir: 'M' }],
      current: 'main',
      tracking: 'origin/main',
      ahead: 1,
      behind: 2,
    })),
    gitWorktreeList: vi.fn(async () => [
      { path: '/repo', branch: 'main', isBare: false, isCurrent: true },
      { path: '/repo/.cate/worktrees/feature', branch: 'feature', isBare: false, isCurrent: false },
    ]),
    onGitBranchUpdate: vi.fn(() => () => {}),
    ...overrides,
  }
}

/** Flush microtasks + a macrotask so an in-flight async fetch settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

describe('gitStatusStore', () => {
  beforeEach(() => {
    gitStatusStore._reset()
    watchCalls.length = 0
    releaseCount = 0
    ;(globalThis as any).window = globalThis as any
    ;(globalThis as any).electronAPI = makeApi()
    ;(window as any).electronAPI = (globalThis as any).electronAPI
  })

  afterEach(() => {
    gitStatusStore._reset()
    vi.restoreAllMocks()
  })

  it('fetches one snapshot and exposes branch/ahead/behind/worktrees', async () => {
    const unsub = gitStatusStore.subscribe(ROOT, () => {})
    await flush()

    const snap = gitStatusStore.getSnapshot(ROOT)
    expect(snap.isRepo).toBe(true)
    expect(snap.branch).toBe('main')
    expect(snap.ahead).toBe(1)
    expect(snap.behind).toBe(2)
    expect(snap.statusFiles).toHaveLength(1)
    // tracked paths are absolute (posix).
    expect(snap.tracked.has('/repo/a.ts')).toBe(true)
    expect(snap.worktrees).toHaveLength(2)
    expect(snap.worktrees[0]).toMatchObject({ path: '/repo', branch: 'main', isPrimary: true, isCurrent: true })
    expect(snap.worktrees[1]).toMatchObject({ isPrimary: false, isCurrent: false })
    unsub()
  })

  it('arms exactly one shared watcher per root regardless of subscriber count', async () => {
    const unsubA = gitStatusStore.subscribe(ROOT, () => {})
    const unsubB = gitStatusStore.subscribe(ROOT, () => {})
    await flush()
    expect(watchCalls.filter((c) => c.rootPath === ROOT)).toHaveLength(1)
    expect(releaseCount).toBe(0)
    unsubA()
    expect(releaseCount).toBe(0) // still one subscriber
    unsubB()
    expect(releaseCount).toBe(1) // 1->0 transition releases the shared watcher
  })

  it('bumps revision and notifies subscribers on refresh', async () => {
    const listener = vi.fn()
    const unsub = gitStatusStore.subscribe(ROOT, listener)
    await flush()
    const rev1 = gitStatusStore.getSnapshot(ROOT).revision
    listener.mockClear()

    gitStatusStore.refresh(ROOT)
    await flush()
    expect(listener).toHaveBeenCalled()
    expect(gitStatusStore.getSnapshot(ROOT).revision).toBeGreaterThan(rev1)
    unsub()
  })

  it('an fs-watch event triggers a debounced refresh', async () => {
    vi.useFakeTimers()
    const unsub = gitStatusStore.subscribe(ROOT, () => {})
    // initial refresh is async — let it settle under fake timers
    await vi.runOnlyPendingTimersAsync()
    const api = (window as any).electronAPI
    const callsBefore = api.gitStatus.mock.calls.length

    const watch = watchCalls.find((c) => c.rootPath === ROOT)!
    watch.listener()
    watch.listener() // burst — should coalesce
    await vi.advanceTimersByTimeAsync(200)
    expect(api.gitStatus.mock.calls.length).toBe(callsBefore + 1)
    unsub()
    vi.useRealTimers()
  })

  it('reports not-a-repo cleanly', async () => {
    ;(window as any).electronAPI = makeApi({ gitIsRepo: vi.fn(async () => false) })
    const unsub = gitStatusStore.subscribe(ROOT, () => {})
    await flush()
    const snap = gitStatusStore.getSnapshot(ROOT)
    expect(snap.isRepo).toBe(false)
    expect(snap.worktrees).toHaveLength(0)
    unsub()
  })

  it('a stale in-flight fetch cannot clobber a newer snapshot', async () => {
    // First refresh resolves slowly; a second refresh resolves first with newer
    // data. The slow (stale) one must be dropped.
    let resolveSlow!: (v: any) => void
    const slow = new Promise((r) => { resolveSlow = r })
    const api = makeApi({
      gitStatus: vi
        .fn()
        .mockImplementationOnce(() => slow)
        .mockImplementation(async () => ({
          files: [], current: 'newer', tracking: null, ahead: 0, behind: 0,
        })),
    })
    ;(window as any).electronAPI = api

    const unsub = gitStatusStore.subscribe(ROOT, () => {}) // fetch #1 (slow)
    gitStatusStore.refresh(ROOT) // fetch #2 (fast)
    await flush()
    expect(gitStatusStore.getSnapshot(ROOT).branch).toBe('newer')

    resolveSlow({ files: [], current: 'stale', tracking: null, ahead: 9, behind: 9 })
    await flush()
    // stale resolution dropped — still the newer snapshot
    expect(gitStatusStore.getSnapshot(ROOT).branch).toBe('newer')
    unsub()
  })
})
