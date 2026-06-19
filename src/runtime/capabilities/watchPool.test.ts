import path from 'path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { buildDaemonRuntime } from './index'
import { addAllowedRoot, removeAllowedRoot } from '../../main/ipc/pathValidation'

// Build paths through path.resolve/join so they match what validatePath()
// (= path.resolve) produces on the host OS. A POSIX literal like '/repo' becomes
// a drive-prefixed backslash path on Windows, so hardcoded literals would never
// match the subscriber prefix there.
const ROOT = path.resolve('/repo')
const SRC = path.join(ROOT, 'src')
const FILE_A = path.join(SRC, 'a.ts')
const FILE_B = path.join(SRC, 'b.ts')
const README = path.join(ROOT, 'README.md')

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
    addAllowedRoot(ROOT)
  })

  afterEach(() => {
    removeAllowedRoot(ROOT)
  })

  test('shares one recursive watcher for nested file.watch subscribers', () => {
    const runtime = buildDaemonRuntime({ id: 'srv_test', rgPath: '/rg' }).runtime
    const rootEvents: string[] = []
    const nestedEvents: string[] = []

    const stopRoot = runtime.file.watch(ROOT, (p) => rootEvents.push(p))
    const stopNested = runtime.file.watch(SRC, (p) => nestedEvents.push(p))

    expect(mockState.watch).toHaveBeenCalledTimes(1)
    const watcher = mockState.watchers[0]

    watcher.emit('add', FILE_A)
    watcher.emit('add', README)

    expect(rootEvents).toEqual([FILE_A, README])
    expect(nestedEvents).toEqual([FILE_A])

    stopNested()
    watcher.emit('change', FILE_B)

    expect(rootEvents).toEqual([FILE_A, README, FILE_B])
    expect(nestedEvents).toEqual([FILE_A])

    stopRoot()
    expect(watcher.close).toHaveBeenCalledTimes(1)
  })

  test('drops a broken watcher on error so the next subscription can recreate it', () => {
    const runtime = buildDaemonRuntime({ id: 'srv_test', rgPath: '/rg' }).runtime

    const stopFirst = runtime.file.watch(ROOT, () => {})
    const first = mockState.watchers[0]

    expect(() => first.emit('error', Object.assign(new Error('too many open files'), { code: 'EMFILE' }))).not.toThrow()
    expect(first.close).toHaveBeenCalledTimes(1)

    const stopSecond = runtime.file.watch(ROOT, () => {})
    expect(mockState.watch).toHaveBeenCalledTimes(2)
    expect(mockState.watchers[1]).not.toBe(first)

    stopFirst()
    stopSecond()
  })

  test('rebuilds a shared watcher once when exclusions change', async () => {
    const runtime = buildDaemonRuntime({ id: 'srv_test', rgPath: '/rg' }).runtime

    const stopRoot = runtime.file.watch(ROOT, () => {})
    const stopNested = runtime.file.watch(SRC, () => {})
    const first = mockState.watchers[0]

    await runtime.setExclusions(['node_modules'])

    expect(mockState.watch).toHaveBeenCalledTimes(2)
    expect(first.handlers.size).toBe(0)
    expect(first.close).toHaveBeenCalledTimes(1)

    stopNested()
    stopRoot()
  })
})
