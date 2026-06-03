import { describe, expect, test, vi } from 'vitest'
import { DeferredCompanion } from './DeferredCompanion'
import type { Companion } from './types'

// A minimal real-companion stand-in: only the methods a test exercises are real;
// the rest are present (cast) so the object satisfies the Companion contract.
function makeReal(overrides: Partial<Companion> = {}): Companion {
  return {
    id: 'srv_real',
    process: {} as Companion['process'],
    agent: {} as Companion['agent'],
    file: {} as Companion['file'],
    vcs: {} as Companion['vcs'],
    validatePath: (p) => p,
    validateCwd: (c) => c,
    validatePathStrict: async (p) => p,
    validatePathForCreation: async (p) => p,
    addAllowedRoot: async () => {},
    removeAllowedRoot: async () => {},
    setExclusions: async () => {},
    setIdleSuspend: async () => {},
    grantFileAccess: async () => {},
    registerScopedWriteAllowance: async () => {},
    clearFileGrantsForWindow: async () => {},
    clearScopedWriteAllowancesForWindow: async () => {},
    ...overrides,
  }
}

describe('DeferredCompanion', () => {
  test('validatePath / validateCwd are synchronous pass-throughs (never block)', () => {
    // The promise never resolves: a sync method must still return immediately.
    const deferred = new DeferredCompanion('local', new Promise<Companion>(() => {}))
    expect(deferred.validatePath('/some/path')).toBe('/some/path')
    expect(deferred.validateCwd('/some/dir')).toBe('/some/dir')
  })

  test('an async method called BEFORE ready resolves to the delegated result once ready', async () => {
    let resolveReady!: (c: Companion) => void
    const ready = new Promise<Companion>((res) => { resolveReady = res })
    const real = makeReal({
      file: { readFile: vi.fn(async (p: string) => `contents:${p}`) } as unknown as Companion['file'],
    })
    const deferred = new DeferredCompanion('local', ready)

    // Call before resolution: the promise is pending, not rejected/resolved yet.
    const pending = deferred.file.readFile('/a.txt')

    resolveReady(real)
    await expect(pending).resolves.toBe('contents:/a.txt')
    expect(real.file.readFile).toHaveBeenCalledWith('/a.txt')
  })

  test('async methods reject with the connect error if ready rejects', async () => {
    const ready = Promise.reject<Companion>(new Error('daemon failed to start'))
    ready.catch(() => {}) // suppress unhandled-rejection noise
    const deferred = new DeferredCompanion('local', ready)
    await expect(deferred.validatePathStrict('/x')).rejects.toThrow('daemon failed to start')
  })

  test('file.watch cancelled BEFORE ready never starts the real watch', async () => {
    let resolveReady!: (c: Companion) => void
    const ready = new Promise<Companion>((res) => { resolveReady = res })
    const realWatch = vi.fn(() => () => {})
    const real = makeReal({ file: { watch: realWatch } as unknown as Companion['file'] })
    const deferred = new DeferredCompanion('local', ready)

    const unsub = deferred.file.watch('/root', () => {})
    unsub() // unsubscribe before the daemon is ready

    resolveReady(real)
    await ready
    await Promise.resolve() // let the ready.then microtask run
    expect(realWatch).not.toHaveBeenCalled()
  })

  test('file.watch started after ready delegates and forwards unsub', async () => {
    let resolveReady!: (c: Companion) => void
    const ready = new Promise<Companion>((res) => { resolveReady = res })
    const realUnsub = vi.fn()
    const realWatch = vi.fn(() => realUnsub)
    const real = makeReal({ file: { watch: realWatch } as unknown as Companion['file'] })
    const deferred = new DeferredCompanion('local', ready)

    const cb = () => {}
    const unsub = deferred.file.watch('/root', cb)
    resolveReady(real)
    await ready
    await Promise.resolve()
    expect(realWatch).toHaveBeenCalledWith('/root', cb)

    unsub()
    expect(realUnsub).toHaveBeenCalledTimes(1)
  })

  test('file.searchContent cancelled BEFORE ready never starts the real search', async () => {
    let resolveReady!: (c: Companion) => void
    const ready = new Promise<Companion>((res) => { resolveReady = res })
    const realSearch = vi.fn(() => ({ cancel: () => {} }))
    const real = makeReal({ file: { searchContent: realSearch } as unknown as Companion['file'] })
    const deferred = new DeferredCompanion('local', ready)

    const handle = deferred.file.searchContent('/root', {} as never, { onBatch: () => {}, onDone: () => {} })
    handle.cancel() // cancel before ready

    resolveReady(real)
    await ready
    await Promise.resolve()
    expect(realSearch).not.toHaveBeenCalled()
  })

  test('file.searchContent surfaces a terminal onDone if ready rejects', async () => {
    const ready = Promise.reject<Companion>(new Error('boom'))
    ready.catch(() => {})
    const deferred = new DeferredCompanion('local', ready)
    const onDone = vi.fn()
    deferred.file.searchContent('/root', {} as never, { onBatch: () => {}, onDone })
    // Wait for the rejected-ready microtask chain.
    await ready.catch(() => {})
    await Promise.resolve()
    await Promise.resolve()
    expect(onDone).toHaveBeenCalledWith({ matches: 0, files: 0, truncated: false }, 'boom')
  })
})
