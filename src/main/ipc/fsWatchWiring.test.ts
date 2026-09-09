import path from 'path'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// The daemon runtime owns the OS watcher. Here we mock the Runtime boundary and
// verify the IPC layer adds only per-window routing/debounce and teardown.

interface Captured {
  prefix: string
  onChange: (p: string, t: string) => void
  unsub: ReturnType<typeof vi.fn>
  access?: { ownerWindowId?: number; scopeId?: string }
}

const mockState = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  captured: [] as Captured[],
  connected: [] as ((id: string, runtime: unknown) => void)[],
  disconnected: [] as ((id: string) => void)[],
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mockState.handlers.set(channel, fn)
    },
  },
}))

vi.mock('../runtime/runtimeManager', () => {
  const runtime = {
    file: {
      watch: vi.fn((prefix: string, onChange: (p: string, t: string) => void, access?: Captured['access']) => {
      const unsub = vi.fn()
      mockState.captured.push({ prefix, onChange, unsub, access })
      return unsub
    }),
    },
  }
  return {
    resolveLocator: (locator: string) => ({ runtime, runtimeId: 'local', path: locator }),
    runtimes: { resolve: () => runtime,
      onConnected: (cb: (id: string, runtime: unknown) => void) => { mockState.connected.push(cb); return () => {} },
      onDisconnected: (cb: (id: string) => void) => { mockState.disconnected.push(cb); return () => {} },
    },
  }
})

const sentEvents: unknown[] = []
vi.mock('../windowRegistry', () => ({
  windowFromEvent: () => ({ id: 1 }),
  sendToWindow: (_id: number, _channel: string, event: unknown) => sentEvents.push(event),
}))

vi.mock('../store', () => ({
  getSettingSync: (key: string) => (key === 'fileExclusions' ? [] : undefined),
}))

const { registerHandlers, stopWatchersForWindow } = await import('./filesystem')
const { FS_WATCH_START, FS_WATCH_STOP } = await import('../../shared/ipc-channels')

registerHandlers()
const watchStart = mockState.handlers.get(FS_WATCH_START)!
const watchStop = mockState.handlers.get(FS_WATCH_STOP)!
const fakeEvent = { sender: {} } as unknown
const root = path.resolve('/repo')

describe('filesystem watch wiring', () => {
  beforeEach(async () => {
    stopWatchersForWindow(1)
    mockState.captured.length = 0
    sentEvents.length = 0
  })

  test('FS_WATCH_START subscribes through the runtime; FS_WATCH_STOP unsubscribes it', async () => {
    await watchStart(fakeEvent, root, 'workspace-1')
    expect(mockState.captured).toHaveLength(1)
    expect(mockState.captured[0].prefix).toBe(root)
    expect(mockState.captured[0].access).toEqual({ ownerWindowId: 1, scopeId: 'workspace-1' })

    await watchStop(fakeEvent, root, 'workspace-1')
    expect(mockState.captured[0].unsub).toHaveBeenCalledTimes(1)
  })

  test('stopWatchersForWindow tears down every watch owned by the window', async () => {
    await watchStart(fakeEvent, root)
    const { unsub } = mockState.captured[0]
    stopWatchersForWindow(1)
    expect(unsub).toHaveBeenCalledTimes(1)
  })

  test('runtime events are forwarded to the owning window', async () => {
    await watchStart(fakeEvent, root)
    const file = path.join(root, 'a.ts')
    mockState.captured[0].onChange(file, 'create')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sentEvents).toContainEqual({ path: file, type: 'create' })
  })
})

test('rebinds existing watches to the reconnected runtime with their workspace scope', async () => {
  await watchStart(fakeEvent, root, 'workspace-1')
  const previous = mockState.captured.at(-1)!
  const nextWatch = vi.fn(() => vi.fn())
  mockState.disconnected.forEach(notify => notify('local'))
  mockState.connected.forEach(notify => notify('local', { file: { watch: nextWatch } }))
  expect(previous.unsub).toHaveBeenCalledTimes(1)
  expect(nextWatch).toHaveBeenCalledWith(root, expect.any(Function), { ownerWindowId: 1, scopeId: 'workspace-1' })
  stopWatchersForWindow(1)
})

test('keeps same-root watches from distinct scopes independent during stop', async () => {
  stopWatchersForWindow(1)
  mockState.captured.length = 0
  await watchStart(fakeEvent, root, 'scope-a')
  await watchStart(fakeEvent, root, 'scope-b')
  expect(mockState.captured).toHaveLength(2)
  expect(mockState.captured[0].unsub).not.toHaveBeenCalled()
  await watchStop(fakeEvent, root, 'scope-a')
  expect(mockState.captured[0].unsub).toHaveBeenCalledOnce()
  expect(mockState.captured[1].unsub).not.toHaveBeenCalled()
  stopWatchersForWindow(1)
})
