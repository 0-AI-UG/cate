import { describe, expect, it, vi } from 'vitest'
import { createJsonStateStore } from './jsonStateStore'

interface State {
  count: number
}

const defaults: State = { count: 0 }
const normalize = (value: unknown): State => {
  if (!value || typeof value !== 'object' || typeof (value as State).count !== 'number') {
    throw new Error('invalid state')
  }
  return { count: (value as State).count }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createJsonStateStore', () => {
  it('shares one async initial load and normalizes the stored value', async () => {
    const gate = deferred<string | null>()
    const read = vi.fn(() => gate.promise)
    const store = createJsonStateStore({
      defaults,
      normalize,
      backend: { read, write: vi.fn() },
    })

    const first = store.load()
    const second = store.load()
    gate.resolve('{"count":4}')

    await expect(first).resolves.toEqual({ count: 4 })
    await expect(second).resolves.toEqual({ count: 4 })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('keeps defaults and reports invalid initial JSON', async () => {
    const onInvalid = vi.fn()
    const store = createJsonStateStore({
      defaults,
      normalize,
      backend: { read: async () => '{broken', write: vi.fn() },
      onInvalid,
    })

    await expect(store.load()).resolves.toEqual(defaults)
    expect(onInvalid).toHaveBeenCalledWith('load')
  })

  it('coalesces local updates, notifies subscribers, and flushes the latest value', async () => {
    vi.useFakeTimers()
    try {
      const write = vi.fn(async () => undefined)
      const store = createJsonStateStore({
        defaults,
        normalize,
        debounceMs: 10,
        backend: { read: async () => null, write },
      })
      await store.load()
      const subscriber = vi.fn()
      store.subscribe(subscriber)

      store.set({ count: 1 })
      store.update((current) => ({ count: current.count + 1 }))
      await vi.advanceTimersByTimeAsync(10)

      expect(subscriber).toHaveBeenNthCalledWith(1, { count: 1 }, 'local')
      expect(subscriber).toHaveBeenNthCalledWith(2, { count: 2 }, 'local')
      expect(write).toHaveBeenCalledTimes(1)
      expect(write).toHaveBeenCalledWith({ count: 2 }, '{\n  "count": 2\n}\n')
    } finally {
      vi.useRealTimers()
    }
  })

  it('serializes overlapping flushes so the newest snapshot is written last', async () => {
    vi.useFakeTimers()
    try {
      const firstWrite = deferred<void>()
      const writes: number[] = []
      const write = vi.fn(async (value: State) => {
        writes.push(value.count)
        if (writes.length === 1) await firstWrite.promise
      })
      const store = createJsonStateStore({
        defaults,
        normalize,
        debounceMs: 10,
        backend: { read: async () => null, write },
      })
      await store.load()

      store.set({ count: 1 })
      await vi.advanceTimersByTimeAsync(10)
      store.set({ count: 2 })
      await vi.advanceTimersByTimeAsync(10)

      expect(writes).toEqual([1])
      firstWrite.resolve()
      await store.flush()
      expect(writes).toEqual([1, 2])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reloads external changes, ignores write echoes, and stops watching after unsubscribe', async () => {
    let raw = '{"count":1}'
    let onChange: (() => void) | undefined
    const unwatch = vi.fn()
    const store = createJsonStateStore({
      defaults,
      normalize,
      backend: {
        read: async () => raw,
        write: vi.fn(),
        watch: (cb) => {
          onChange = cb
          return unwatch
        },
      },
    })
    await store.load()
    const subscriber = vi.fn()
    const unsubscribe = store.subscribe(subscriber)

    onChange?.()
    await vi.waitFor(() => expect(subscriber).not.toHaveBeenCalled())

    raw = '{"count":3}'
    onChange?.()
    await vi.waitFor(() => expect(subscriber).toHaveBeenCalledWith({ count: 3 }, 'external'))
    expect(store.get()).toEqual({ count: 3 })

    unsubscribe()
    expect(unwatch).toHaveBeenCalledTimes(1)
  })

  it('disposes an async watcher that finishes arming after its subscriber leaves', async () => {
    const armed = deferred<() => void>()
    const unwatch = vi.fn()
    const store = createJsonStateStore({
      defaults,
      normalize,
      backend: {
        read: async () => null,
        write: vi.fn(),
        watch: () => armed.promise,
      },
    })
    await store.load()
    const unsubscribe = store.subscribe(vi.fn())
    unsubscribe()

    armed.resolve(unwatch)
    await vi.waitFor(() => expect(unwatch).toHaveBeenCalledTimes(1))
  })

  it('flushes pending state synchronously on disposal when the backend supports it', async () => {
    vi.useFakeTimers()
    try {
      const writeSync = vi.fn()
      const store = createJsonStateStore({
        defaults,
        normalize,
        backend: { read: async () => null, write: vi.fn(), writeSync },
      })
      await store.load()
      store.set({ count: 8 })

      store.dispose()

      expect(writeSync).toHaveBeenCalledWith({ count: 8 }, '{\n  "count": 8\n}\n')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('repairs an older async write that completes after a newer synchronous flush', async () => {
    vi.useFakeTimers()
    try {
      const firstWrite = deferred<void>()
      let disk = ''
      let writeCount = 0
      const store = createJsonStateStore({
        defaults,
        normalize,
        debounceMs: 10,
        backend: {
          read: async () => null,
          write: async (_value, content) => {
            writeCount++
            if (writeCount === 1) await firstWrite.promise
            disk = content
          },
          writeSync: (_value, content) => { disk = content },
        },
      })
      await store.load()

      store.set({ count: 1 })
      await vi.advanceTimersByTimeAsync(10)
      store.set({ count: 2 })
      store.flushSync()
      expect(disk).toBe('{\n  "count": 2\n}\n')

      firstWrite.resolve()
      await store.flush()

      expect(writeCount).toBe(2)
      expect(disk).toBe('{\n  "count": 2\n}\n')
    } finally {
      vi.useRealTimers()
    }
  })
})
