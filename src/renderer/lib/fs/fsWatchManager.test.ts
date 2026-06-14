// =============================================================================
// Tests for fsWatchManager — verifies that the watcher start is deferred until
// workspace registration (awaitWorkspaceSync) has completed, closing the
// startup race where a watch beats allowed-root registration and is denied with
// "outside allowed directories" for the whole session.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsWatchEvent } from './fsWatchManager'

// A controllable awaitWorkspaceSync: a fresh pending promise per test that the
// test resolves to simulate workspace registration completing.
const sync = vi.hoisted(() => {
  const state = { resolve: () => {}, promise: Promise.resolve() as Promise<void> }
  const reset = () => {
    state.promise = new Promise<void>((r) => { state.resolve = r })
  }
  return { state, reset }
})

vi.mock('../../stores/appStore/helpers', () => ({
  awaitWorkspaceSync: () => sync.state.promise,
}))

const ROOT = '/proj'
const WS = 'w1'

let api: {
  fsWatchStart: ReturnType<typeof vi.fn>
  fsWatchStop: ReturnType<typeof vi.fn>
  onFsWatchEvent: ReturnType<typeof vi.fn>
}
let eventCb: ((e: FsWatchEvent) => void) | null = null
let watchFsRoot: typeof import('./fsWatchManager').watchFsRoot

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(async () => {
  sync.reset()
  eventCb = null
  api = {
    fsWatchStart: vi.fn().mockResolvedValue(undefined),
    fsWatchStop: vi.fn().mockResolvedValue(undefined),
    onFsWatchEvent: vi.fn((cb: (e: FsWatchEvent) => void) => {
      eventCb = cb
      return () => { eventCb = null }
    }),
  }
  ;(globalThis as unknown as { window: unknown }).window = { electronAPI: api }
  // Fresh module state (the entries Map) for each test.
  vi.resetModules()
  ;({ watchFsRoot } = await import('./fsWatchManager'))
})

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('fsWatchManager — start ordering', () => {
  it('does not start the watcher until workspace sync resolves', async () => {
    const stop = watchFsRoot(ROOT, vi.fn(), WS)

    // Event subscription is wired synchronously, but the start is deferred.
    expect(api.onFsWatchEvent).toHaveBeenCalledTimes(1)
    expect(api.fsWatchStart).not.toHaveBeenCalled()

    sync.state.resolve()
    await flush()

    expect(api.fsWatchStart).toHaveBeenCalledTimes(1)
    expect(api.fsWatchStart).toHaveBeenCalledWith(ROOT, WS)
    stop()
  })

  it('never starts (or stops) the watcher if unsubscribed before sync resolves', async () => {
    const stop = watchFsRoot(ROOT, vi.fn(), WS)
    stop() // torn down while sync still pending

    sync.state.resolve()
    await flush()

    expect(api.fsWatchStart).not.toHaveBeenCalled()
    // No spurious stop for a watcher that never started (no "outside allowed
    // directories" noise from a quick subscribe/unsubscribe during the race).
    expect(api.fsWatchStop).not.toHaveBeenCalled()
  })

  it('forwards events to the listener once started', async () => {
    const listener = vi.fn()
    const stop = watchFsRoot(ROOT, listener, WS)
    sync.state.resolve()
    await flush()

    eventCb!({ type: 'update', path: '/proj/file.txt' })
    expect(listener).toHaveBeenCalledWith({ type: 'update', path: '/proj/file.txt' })

    // Events outside the root are filtered out.
    eventCb!({ type: 'update', path: '/other/file.txt' })
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
  })
})

describe('fsWatchManager — refcounting', () => {
  it('starts once for multiple subscribers and stops on the last unsubscribe', async () => {
    const a = watchFsRoot(ROOT, vi.fn(), WS)
    const b = watchFsRoot(ROOT, vi.fn(), WS)
    sync.state.resolve()
    await flush()

    // One shared watcher despite two subscribers.
    expect(api.onFsWatchEvent).toHaveBeenCalledTimes(1)
    expect(api.fsWatchStart).toHaveBeenCalledTimes(1)

    a()
    expect(api.fsWatchStop).not.toHaveBeenCalled()
    b()
    expect(api.fsWatchStop).toHaveBeenCalledTimes(1)
    expect(api.fsWatchStop).toHaveBeenCalledWith(ROOT, WS)
  })
})
