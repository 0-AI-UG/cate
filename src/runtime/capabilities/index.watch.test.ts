import path from 'path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { addAllowedRoot, removeAllowedRoot } from '../../main/ipc/pathValidation'

// The dedup / refcount / rebuild / error-containment logic lives in the shared
// watch pool (fileWatcher.ts) and is unit-tested there. Here we mock that
// boundary and verify only that buildDaemonRuntime DELEGATES to it correctly:
// the watch root is authoritative-validated, events flow through, and a live
// exclusion change rebuilds via the pool.

const ROOT = path.resolve('/repo')
const SRC = path.join(ROOT, 'src')

interface FakePool {
  getExclusions: () => Iterable<string>
  subscribe: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
  closeAll: ReturnType<typeof vi.fn>
  captured: Array<{ prefix: string; onChange: (p: string, t: string) => void; unsub: ReturnType<typeof vi.fn> }>
}

const mockState = vi.hoisted(() => ({ pools: [] as unknown[] }))

vi.mock('./fileWatcher', () => ({
  createWatchPool: (getExclusions: () => Iterable<string>) => {
    const captured: FakePool['captured'] = []
    const pool: FakePool = {
      getExclusions,
      captured,
      subscribe: vi.fn((prefix: string, onChange: (p: string, t: string) => void) => {
        const unsub = vi.fn()
        captured.push({ prefix, onChange, unsub })
        return unsub
      }),
      refresh: vi.fn(async () => {}),
      closeAll: vi.fn(async () => {}),
    }
    mockState.pools.push(pool)
    return pool
  },
}))

const { buildDaemonRuntime } = await import('./index')

function lastPool(): FakePool {
  return mockState.pools[mockState.pools.length - 1] as FakePool
}

describe('daemon runtime watch delegation', () => {
  beforeEach(() => {
    mockState.pools.length = 0
    addAllowedRoot(ROOT)
  })
  afterEach(() => {
    removeAllowedRoot(ROOT)
  })

  test('file.watch subscribes the validated root and forwards events verbatim', () => {
    const runtime = buildDaemonRuntime({ id: 'srv_test', rgPath: '/rg' }).runtime
    const events: Array<[string, string]> = []
    const unsub = runtime.file.watch(SRC, (p, t) => events.push([p, t]))

    const pool = lastPool()
    expect(pool.subscribe).toHaveBeenCalledTimes(1)
    // The prefix handed to the pool is the authoritative-validated path.
    expect(pool.captured[0].prefix).toBe(SRC)

    const file = path.join(SRC, 'a.ts')
    pool.captured[0].onChange(file, 'create')
    expect(events).toEqual([[file, 'create']])

    expect(typeof unsub).toBe('function')
  })

  test('setExclusions mutates the live set the pool reads, then rebuilds via refresh', async () => {
    const runtime = buildDaemonRuntime({ id: 'srv_test', rgPath: '/rg', exclusions: ['node_modules'] }).runtime
    const pool = lastPool()

    expect([...pool.getExclusions()]).toEqual(['node_modules'])

    await runtime.setExclusions(['node_modules', '.git'])

    expect([...pool.getExclusions()]).toEqual(['node_modules', '.git'])
    expect(pool.refresh).toHaveBeenCalledTimes(1)
  })
})
