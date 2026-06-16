import { beforeEach, describe, expect, test, vi } from 'vitest'

type Handler = (...args: unknown[]) => void

interface MockWatcher {
  handlers: Map<string, Set<Handler>>
  close: ReturnType<typeof vi.fn>
  on: (event: string, cb: Handler) => MockWatcher
  removeAllListeners: () => MockWatcher
  emit: (event: string, ...args: unknown[]) => void
}

const mockState = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  watchers: [] as MockWatcher[],
  watch: vi.fn(),
}))

function createMockWatcher(): MockWatcher {
  const watcher: MockWatcher = {
    handlers: new Map(),
    close: vi.fn(async () => {}),
    on(event, cb) {
      const set = this.handlers.get(event) ?? new Set<Handler>()
      set.add(cb)
      this.handlers.set(event, set)
      return this
    },
    removeAllListeners() {
      this.handlers.clear()
      return this
    },
    emit(event, ...args) {
      for (const cb of this.handlers.get(event) ?? []) cb(...args)
    },
  }
  mockState.watchers.push(watcher)
  return watcher
}

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mockState.handlers.set(channel, fn)
    },
  },
}))

vi.mock('chokidar', () => ({ watch: mockState.watch }))

vi.mock('../windowRegistry', () => ({
  windowFromEvent: () => ({ id: 1 }),
  sendToWindow: vi.fn(),
}))

vi.mock('../store', () => ({
  getSettingSync: (key: string) => (key === 'fileExclusions' ? [] : undefined),
}))

const { registerHandlers } = await import('./filesystem')
const { addAllowedRoot, removeAllowedRoot } = await import('./pathValidation')
const { FS_WATCH_START, FS_WATCH_STOP } = await import('../../shared/ipc-channels')

registerHandlers()
const watchStart = mockState.handlers.get(FS_WATCH_START)!
const watchStop = mockState.handlers.get(FS_WATCH_STOP)!
const fakeEvent = { sender: {} } as unknown
const root = '/repo'

describe('filesystem watch error handling', () => {
  beforeEach(async () => {
    await Promise.resolve(watchStop(fakeEvent, root)).catch(() => {})
    removeAllowedRoot(root)
    mockState.watchers.length = 0
    mockState.watch.mockReset()
    mockState.watch.mockImplementation(createMockWatcher)
    addAllowedRoot(root)
  })

  test('contains chokidar errors and recreates the watcher on the next start', async () => {
    await watchStart(fakeEvent, root)
    const first = mockState.watchers[0]

    expect(() => first.emit('error', Object.assign(new Error('too many open files'), { code: 'EMFILE' }))).not.toThrow()
    expect(first.close).toHaveBeenCalledTimes(1)

    await watchStart(fakeEvent, root)

    expect(mockState.watch).toHaveBeenCalledTimes(2)
    expect(mockState.watchers[1]).not.toBe(first)
  })
})
