import path from 'path'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// The shared watch pool (runtime/capabilities/fileWatcher.ts) owns the OS
// watcher, covering-root sharing, refcounted teardown and error containment —
// all unit-tested there. Here we mock that boundary and verify the local IPC
// layer DELEGATES correctly: watch start/stop subscribe and unsubscribe the
// validated path, per-window close tears every watch down, an in-process
// subscription flows through, and an exclusion edit rebuilds via refresh().

interface Captured {
  prefix: string
  onChange: (p: string, t: string) => void
  unsub: ReturnType<typeof vi.fn>
}

const mockState = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  captured: [] as Captured[],
  refresh: vi.fn(async () => {}),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mockState.handlers.set(channel, fn)
    },
  },
}))

vi.mock('../../runtime/capabilities/fileWatcher', () => ({
  createWatchPool: () => ({
    subscribe: vi.fn((prefix: string, onChange: (p: string, t: string) => void) => {
      const unsub = vi.fn()
      mockState.captured.push({ prefix, onChange, unsub })
      return unsub
    }),
    refresh: mockState.refresh,
    closeAll: vi.fn(async () => {}),
  }),
}))

const sentEvents: unknown[] = []
vi.mock('../windowRegistry', () => ({
  windowFromEvent: () => ({ id: 1 }),
  sendToWindow: (_id: number, _channel: string, event: unknown) => sentEvents.push(event),
}))

vi.mock('../store', () => ({
  getSettingSync: (key: string) => (key === 'fileExclusions' ? [] : undefined),
}))

const { registerHandlers, stopWatchersForWindow, subscribeFsChanges, refreshWatcherIgnores } = await import('./filesystem')
const { addAllowedRoot, removeAllowedRoot } = await import('./pathValidation')
const { FS_WATCH_START, FS_WATCH_STOP } = await import('../../shared/ipc-channels')

registerHandlers()
const watchStart = mockState.handlers.get(FS_WATCH_START)!
const watchStop = mockState.handlers.get(FS_WATCH_STOP)!
const fakeEvent = { sender: {} } as unknown
// Resolve so the path matches what validatePathStrict produces on every OS
// (a bare '/repo' becomes a drive-prefixed 'D:\repo' on Windows).
const root = path.resolve('/repo')

describe('filesystem watch wiring', () => {
  beforeEach(async () => {
    await Promise.resolve(watchStop(fakeEvent, root)).catch(() => {})
    removeAllowedRoot(root)
    mockState.captured.length = 0
    mockState.refresh.mockClear()
    sentEvents.length = 0
    addAllowedRoot(root)
  })

  test('FS_WATCH_START subscribes the validated path; FS_WATCH_STOP unsubscribes it', async () => {
    await watchStart(fakeEvent, root)
    expect(mockState.captured).toHaveLength(1)
    expect(mockState.captured[0].prefix).toBe(root)

    await watchStop(fakeEvent, root)
    expect(mockState.captured[0].unsub).toHaveBeenCalledTimes(1)
  })

  test('stopWatchersForWindow tears down every watch owned by the window', async () => {
    await watchStart(fakeEvent, root)
    const { unsub } = mockState.captured[0]
    stopWatchersForWindow(1)
    expect(unsub).toHaveBeenCalledTimes(1)
  })

  test('subscribeFsChanges delegates straight to the pool', () => {
    const listener = vi.fn()
    const unsub = subscribeFsChanges(root, listener)
    expect(mockState.captured).toHaveLength(1)
    expect(mockState.captured[0].prefix).toBe(root)

    const file = path.join(root, 'a.ts')
    mockState.captured[0].onChange(file, 'create')
    expect(listener).toHaveBeenCalledWith(file, 'create')

    unsub()
    expect(mockState.captured[0].unsub).toHaveBeenCalledTimes(1)
  })

  test('refreshWatcherIgnores rebuilds via the pool', () => {
    refreshWatcherIgnores()
    expect(mockState.refresh).toHaveBeenCalledTimes(1)
  })
})
