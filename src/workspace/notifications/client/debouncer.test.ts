import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNotificationDebouncer } from './debouncer'

describe('createNotificationDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires the payload after the delay when nothing intervenes', () => {
    const onFire = vi.fn()
    const d = createNotificationDebouncer<string>(3000, onFire)

    d.request('t1', 'hello')
    expect(onFire).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2999)
    expect(onFire).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onFire).toHaveBeenCalledTimes(1)
    expect(onFire).toHaveBeenCalledWith('hello')
  })

  it('cancel() before the delay drops the notification entirely', () => {
    const onFire = vi.fn()
    const d = createNotificationDebouncer<string>(3000, onFire)

    d.request('t1', 'hello')
    vi.advanceTimersByTime(1500)
    d.cancel('t1')
    vi.advanceTimersByTime(10_000)

    expect(onFire).not.toHaveBeenCalled()
  })

  it('drops a request cancelled inside the window (the agent went back to work)', () => {
    const onFire = vi.fn()
    const d = createNotificationDebouncer<string>(3500, onFire)

    d.request('t1', 'needs-input')
    vi.advanceTimersByTime(1500)
    d.cancel('t1')
    vi.advanceTimersByTime(10_000)

    expect(onFire).not.toHaveBeenCalled()
  })

  it('fires once for a request nothing cancels', () => {
    const onFire = vi.fn()
    const d = createNotificationDebouncer<string>(3500, onFire)

    d.request('t1', 'needs-input')
    vi.advanceTimersByTime(5000)

    expect(onFire).toHaveBeenCalledTimes(1)
  })

  it('a new request() before the delay resets the timer and replaces the payload', () => {
    const onFire = vi.fn()
    const d = createNotificationDebouncer<string>(3000, onFire)

    d.request('t1', 'first')
    vi.advanceTimersByTime(2000)
    d.request('t1', 'second')
    vi.advanceTimersByTime(2999)
    expect(onFire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onFire).toHaveBeenCalledTimes(1)
    expect(onFire).toHaveBeenCalledWith('second')
  })

  it('tracks requests independently per key', () => {
    const onFire = vi.fn()
    const d = createNotificationDebouncer<string>(3000, onFire)

    d.request('t1', 'a')
    d.request('t2', 'b')
    expect(d.pendingCount()).toBe(2)

    d.cancel('t1')
    expect(d.pendingCount()).toBe(1)

    vi.advanceTimersByTime(3000)
    expect(onFire).toHaveBeenCalledTimes(1)
    expect(onFire).toHaveBeenCalledWith('b')
  })

  it('dispose() clears all pending timers', () => {
    const onFire = vi.fn()
    const d = createNotificationDebouncer<string>(3000, onFire)

    d.request('t1', 'a')
    d.request('t2', 'b')
    d.dispose()
    expect(d.pendingCount()).toBe(0)

    vi.advanceTimersByTime(10_000)
    expect(onFire).not.toHaveBeenCalled()
  })
})
