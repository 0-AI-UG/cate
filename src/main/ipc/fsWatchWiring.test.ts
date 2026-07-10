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
    runtimes: { resolve: () => runtime },
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
    await Promise.resolve(watchStop(fakeEvent, root)).catch(() => {})
    mockState.captured.length = 0
    sentEvents.length = 0
  })

  test('FS_WATCH_START subscribes through the runtime; FS_WATCH_STOP unsubscribes it', async () => {
    await watchStart(fakeEvent, root, 'workspace-1')
    expect(mockState.captured).toHaveLength(1)
    expect(mockState.captured[0].prefix).toBe(root)
    expect(mockState.captured[0].access).toEqual({ ownerWindowId: 1, scopeId: 'workspace-1' })

    await watchStop(fakeEvent, root)
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
