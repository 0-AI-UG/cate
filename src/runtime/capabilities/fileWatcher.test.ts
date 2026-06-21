// Unit tests for createWatchPool — the single @parcel/watcher-backed pool that
// all workspace-tree watching flows through. parcel's `subscribe` is injected
// (deps.subscribe) so every branch — event mapping, prefix fan-out, covering
// reuse, refcounted teardown, exclusion refresh, and error containment — is
// exercised deterministically on every CI OS without a real OS watcher.

import { describe, it, expect, vi } from 'vitest'
import path from 'path'
import { createWatchPool, buildIgnorePatterns, pathHasPrefix, type WatchPoolDeps } from './fileWatcher'

const ROOT = path.resolve('/work/repo')
const SRC = path.join(ROOT, 'src')
const flush = () => new Promise((r) => setImmediate(r))

interface FakeSub {
  root: string
  cb: (err: Error | null, events: Array<{ path: string; type: 'create' | 'update' | 'delete' }>) => void
  opts: { ignore?: string[] } | undefined
  unsubscribe: ReturnType<typeof vi.fn>
}

/** A fake parcel.subscribe: records each subscription and exposes a handle to
 *  drive events / errors at it. `deferred` keeps the subscribe promise pending
 *  until released, to test teardown that races subscription resolution. */
function fakeParcel(opts: { deferred?: boolean } = {}) {
  const subs: FakeSub[] = []
  const releases: Array<() => void> = []
  const subscribe = vi.fn((root: string, cb: FakeSub['cb'], o: FakeSub['opts']) => {
    const unsubscribe = vi.fn(async () => {})
    subs.push({ root, cb, opts: o, unsubscribe })
    if (!opts.deferred) return Promise.resolve({ unsubscribe })
    return new Promise<{ unsubscribe: typeof unsubscribe }>((resolve) => {
      releases.push(() => resolve({ unsubscribe }))
    })
  }) as unknown as NonNullable<WatchPoolDeps['subscribe']>
  return {
    subscribe,
    subs,
    fire: (i: number, events: Parameters<FakeSub['cb']>[1]) => subs[i].cb(null, events),
    fireError: (i: number, err: Error) => subs[i].cb(err, []),
    release: (i: number) => releases[i]?.(),
  }
}

describe('createWatchPool — event delivery', () => {
  it('delivers parcel create/update/delete verbatim with the absolute path', async () => {
    const fake = fakeParcel()
    const pool = createWatchPool(() => [], undefined, { subscribe: fake.subscribe })
    const events: Array<[string, string]> = []
    pool.subscribe(ROOT, (p, t) => events.push([t, p]))

    const a = path.join(ROOT, 'a.ts')
    const b = path.join(ROOT, 'b.ts')
    fake.fire(0, [
      { path: a, type: 'create' },
      { path: a, type: 'update' },
      { path: b, type: 'delete' },
    ])
    await flush()

    expect(events).toEqual([
      ['create', a],
      ['update', a],
      ['delete', b],
    ])
  })

  it('drops an event whose path IS the watch root (no real consumer)', async () => {
    const fake = fakeParcel()
    const pool = createWatchPool(() => [], undefined, { subscribe: fake.subscribe })
    const onChange = vi.fn()
    pool.subscribe(ROOT, onChange)

    fake.fire(0, [{ path: ROOT, type: 'create' }])
    await flush()

    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('createWatchPool — covering-root sharing + prefix fan-out', () => {
  it('shares ONE parcel subscription for nested subscribers and filters by prefix', async () => {
    const fake = fakeParcel()
    const pool = createWatchPool(() => [], undefined, { subscribe: fake.subscribe })
    const rootEvents: string[] = []
    const nestedEvents: string[] = []

    pool.subscribe(ROOT, (p) => rootEvents.push(p))
    pool.subscribe(SRC, (p) => nestedEvents.push(p))

    // Only one OS watcher opened (the nested subscribe reused the root tree).
    expect(fake.subscribe).toHaveBeenCalledTimes(1)

    const inSrc = path.join(SRC, 'a.ts')
    const atRootChild = path.join(ROOT, 'README.md')
    fake.fire(0, [
      { path: inSrc, type: 'update' },
      { path: atRootChild, type: 'update' },
    ])
    await flush()

    expect(rootEvents).toEqual([inSrc, atRootChild])
    expect(nestedEvents).toEqual([inSrc]) // README is outside SRC → filtered
  })

  it('opens a separate watcher when a later subscribe is NOT covered', async () => {
    const fake = fakeParcel()
    const pool = createWatchPool(() => [], undefined, { subscribe: fake.subscribe })
    const other = path.resolve('/work/other')
    pool.subscribe(ROOT, () => {})
    pool.subscribe(other, () => {})
    expect(fake.subscribe).toHaveBeenCalledTimes(2)
  })
})

describe('createWatchPool — refcounted teardown', () => {
  it('keeps the subscription alive until the LAST subscriber leaves', async () => {
    const fake = fakeParcel()
    const pool = createWatchPool(() => [], undefined, { subscribe: fake.subscribe })
    const stopRoot = pool.subscribe(ROOT, () => {})
    const stopNested = pool.subscribe(SRC, () => {})
    await flush() // let subscribe resolve so the handle is held

    stopNested()
    expect(fake.subs[0].unsubscribe).not.toHaveBeenCalled()

    stopRoot()
    expect(fake.subs[0].unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('stops delivering to a subscriber the instant it unsubscribes', async () => {
    const fake = fakeParcel()
    const pool = createWatchPool(() => [], undefined, { subscribe: fake.subscribe })
    const onChange = vi.fn()
    const stop = pool.subscribe(ROOT, onChange)
    stop()
    fake.fire(0, [{ path: path.join(ROOT, 'late.ts'), type: 'update' }])
    await flush()
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('createWatchPool — error containment', () => {
  it('reports a callback error, drops the tree, and lets the next subscribe recreate it', async () => {
    const fake = fakeParcel()
    const onError = vi.fn()
    const pool = createWatchPool(() => [], onError, { subscribe: fake.subscribe })
    pool.subscribe(ROOT, () => {})
    await flush()

    const boom = Object.assign(new Error('too many open files'), { code: 'EMFILE' })
    expect(() => fake.fireError(0, boom)).not.toThrow()
    expect(onError).toHaveBeenCalledWith(ROOT, boom)
    expect(fake.subs[0].unsubscribe).toHaveBeenCalledTimes(1)

    // A fresh subscribe opens a brand-new watcher (the broken one was dropped).
    pool.subscribe(ROOT, () => {})
    expect(fake.subscribe).toHaveBeenCalledTimes(2)
  })

  it('contains a rejected subscribe (e.g. EMFILE at creation) as an onError, not a throw', async () => {
    const onError = vi.fn()
    const err = Object.assign(new Error('EMFILE'), { code: 'EMFILE' })
    const subscribe = vi.fn(() => Promise.reject(err)) as unknown as NonNullable<WatchPoolDeps['subscribe']>
    const pool = createWatchPool(() => [], onError, { subscribe })
    pool.subscribe(ROOT, () => {})
    await flush()
    expect(onError).toHaveBeenCalledWith(ROOT, err)
  })
})

describe('createWatchPool — teardown racing subscription resolution', () => {
  it('unsubscribes the parcel handle even when close beats the subscribe promise', async () => {
    const fake = fakeParcel({ deferred: true })
    const pool = createWatchPool(() => [], undefined, { subscribe: fake.subscribe })
    const stop = pool.subscribe(ROOT, () => {})

    stop() // tear down BEFORE the subscribe promise resolves
    fake.release(0) // now the handle resolves
    await flush()

    // The late-resolved handle must be unsubscribed, not leaked.
    expect(fake.subs[0].unsubscribe).toHaveBeenCalledTimes(1)
  })
})

describe('createWatchPool — closeAll', () => {
  it('unsubscribes every tree and drops any late events', async () => {
    const fake = fakeParcel()
    const pool = createWatchPool(() => [], undefined, { subscribe: fake.subscribe })
    const onRoot = vi.fn()
    pool.subscribe(ROOT, onRoot)
    pool.subscribe(path.resolve('/work/other'), () => {})
    await flush()

    await pool.closeAll()

    expect(fake.subs[0].unsubscribe).toHaveBeenCalledTimes(1)
    expect(fake.subs[1].unsubscribe).toHaveBeenCalledTimes(1)

    // A straggler event from a backend that fires after closeAll is ignored.
    fake.fire(0, [{ path: path.join(ROOT, 'late.ts'), type: 'update' }])
    await flush()
    expect(onRoot).not.toHaveBeenCalled()
  })
})

describe('createWatchPool — refresh (exclusion change)', () => {
  it('re-subscribes each tree with the CURRENT exclusions and unsubscribes the old', async () => {
    const fake = fakeParcel()
    let exclusions: string[] = []
    const pool = createWatchPool(() => exclusions, undefined, { subscribe: fake.subscribe })
    pool.subscribe(ROOT, () => {})
    await flush()
    expect(fake.subs[0].opts?.ignore).not.toContain('**/node_modules')

    exclusions = ['node_modules']
    await pool.refresh()
    await flush()

    expect(fake.subscribe).toHaveBeenCalledTimes(2)
    expect(fake.subs[1].opts?.ignore).toContain('**/node_modules')
    expect(fake.subs[0].unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('ignores events from the superseded (old) subscription after a refresh', async () => {
    const fake = fakeParcel()
    const pool = createWatchPool(() => [], undefined, { subscribe: fake.subscribe })
    const onChange = vi.fn()
    pool.subscribe(ROOT, onChange)
    await flush()

    await pool.refresh()
    await flush()

    // The OLD callback (subs[0]) is now stale; its events must be dropped.
    fake.fire(0, [{ path: path.join(ROOT, 'stale.ts'), type: 'update' }])
    // The NEW callback (subs[1]) is live.
    fake.fire(1, [{ path: path.join(ROOT, 'fresh.ts'), type: 'update' }])
    await flush()

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(path.join(ROOT, 'fresh.ts'), 'update')
  })
})

describe('buildIgnorePatterns', () => {
  it('always prunes hidden-directory CONTENTS while leaving the basis for hidden files', () => {
    expect(buildIgnorePatterns([])).toEqual(['**/.*/**'])
  })

  it('emits both the name and its subtree glob for each exclusion', () => {
    expect(buildIgnorePatterns(['node_modules', '.git'])).toEqual([
      '**/.*/**',
      '**/node_modules',
      '**/node_modules/**',
      '**/.git',
      '**/.git/**',
    ])
  })
})

describe('pathHasPrefix', () => {
  it('matches a path equal to or beneath the prefix, not a sibling sharing a name stem', () => {
    expect(pathHasPrefix('/a/b', '/a/b')).toBe(true)
    expect(pathHasPrefix('/a/b/c', '/a/b')).toBe(true)
    expect(pathHasPrefix('/a/bcd', '/a/b')).toBe(false)
    expect(pathHasPrefix('/a', '/a/b')).toBe(false)
  })
})
