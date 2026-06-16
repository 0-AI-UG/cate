import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { buildDaemonRuntime } from './index'
import { addAllowedRoot, removeAllowedRoot } from '../../main/ipc/pathValidation'

type Handler = (...args: unknown[]) => void

interface MockWatcher {
  root: string
  handlers: Map<string, Set<Handler>>
  close: ReturnType<typeof vi.fn>
  on: (event: string, cb: Handler) => MockWatcher
  removeAllListeners: () => MockWatcher
  emit: (event: string, ...args: unknown[]) => void
}

const mockState = vi.hoisted(() => ({
  watchers: [] as MockWatcher[],
  watch: vi.fn(),
}))

function createMockWatcher(root: string): MockWatcher {
  const watcher: MockWatcher = {
    root,
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

vi.mock('chokidar', () => ({ watch: mockState.watch }))

describe('daemon runtime watch pool', () => {
  beforeEach(() => {
    mockState.watchers.length = 0
    mockState.watch.mockReset()
    mockState.watch.mockImplementation(createMockWatcher)
    addAllowedRoot('/repo')
  })

  afterEach(() => {
    removeAllowedRoot('/repo')
  })

  test('shares one recursive watcher for nested file.watch subscribers', () => {
    const runtime = buildDaemonRuntime({ id: 'srv_test', rgPath: '/rg' }).runtime
    const rootEvents: string[] = []
    const nestedEvents: string[] = []

    const stopRoot = runtime.file.watch('/repo', (p) => rootEvents.push(p))
    const stopNested = runtime.file.watch('/repo/src', (p) => nestedEvents.push(p))

    expect(mockState.watch).toHaveBeenCalledTimes(1)
    const watcher = mockState.watchers[0]

    watcher.emit('add', '/repo/src/a.ts')
    watcher.emit('add', '/repo/README.md')

    expect(rootEvents).toEqual(['/repo/src/a.ts', '/repo/README.md'])
    expect(nestedEvents).toEqual(['/repo/src/a.ts'])

    stopNested()
    watcher.emit('change', '/repo/src/b.ts')

    expect(rootEvents).toEqual(['/repo/src/a.ts', '/repo/README.md', '/repo/src/b.ts'])
    expect(nestedEvents).toEqual(['/repo/src/a.ts'])

    stopRoot()
    expect(watcher.close).toHaveBeenCalledTimes(1)
  })

  test('drops a broken watcher on error so the next subscription can recreate it', () => {
    const runtime = buildDaemonRuntime({ id: 'srv_test', rgPath: '/rg' }).runtime

    const stopFirst = runtime.file.watch('/repo', () => {})
    const first = mockState.watchers[0]

    expect(() => first.emit('error', Object.assign(new Error('too many open files'), { code: 'EMFILE' }))).not.toThrow()
    expect(first.close).toHaveBeenCalledTimes(1)

    const stopSecond = runtime.file.watch('/repo', () => {})
    expect(mockState.watch).toHaveBeenCalledTimes(2)
    expect(mockState.watchers[1]).not.toBe(first)

    stopFirst()
    stopSecond()
  })

  test('rebuilds a shared watcher once when exclusions change', async () => {
    const runtime = buildDaemonRuntime({ id: 'srv_test', rgPath: '/rg' }).runtime

    const stopRoot = runtime.file.watch('/repo', () => {})
    const stopNested = runtime.file.watch('/repo/src', () => {})
    const first = mockState.watchers[0]

    await runtime.setExclusions(['node_modules'])

    expect(mockState.watch).toHaveBeenCalledTimes(2)
    expect(first.handlers.size).toBe(0)
    expect(first.close).toHaveBeenCalledTimes(1)

    stopNested()
    stopRoot()
  })
})
