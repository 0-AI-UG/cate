import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CompanionRpcClient } from './rpcClient'
import { serializeFrame } from '../../companion/jsonl'

// Exercises the per-call timeout option on CompanionRpcClient.call(). Fake
// timers keep every case deterministic. A fresh client per test avoids the
// constructor's hello timer (default 10s) leaking between cases; `ready` has an
// internal .catch, so its rejection never surfaces as unhandled.
describe('CompanionRpcClient call timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('default timeout rejects after 30s', async () => {
    const c = new CompanionRpcClient(() => {})
    const p = c.call('m')
    const expectation = expect(p).rejects.toThrow(/timed out/)
    vi.advanceTimersByTime(30_000)
    await expectation
  })

  test('custom short timeout rejects sooner', async () => {
    const c = new CompanionRpcClient(() => {})
    const p = c.call('m', [], { timeoutMs: 5000 })
    const expectation = expect(p).rejects.toThrow(/timed out/)
    vi.advanceTimersByTime(5000)
    await expectation
  })

  test('timeoutMs: 0 disables the timeout and stays pending', async () => {
    const c = new CompanionRpcClient(() => {})
    const p = c.call('m', [], { timeoutMs: 0 })

    let settled = false
    p.then(
      () => { settled = true },
      () => { settled = true },
    )

    // Flush microtasks, then advance far past any default deadline.
    await Promise.resolve()
    await Promise.resolve()
    vi.advanceTimersByTime(600_000)
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    // The call is still alive: a late response resolves it.
    c.handleChunk(serializeFrame({ t: 'res', id: 1, ok: true, data: 'ok' }))
    await expect(p).resolves.toBe('ok')
  })

  test('a response before the timeout resolves and clears the timer', async () => {
    const c = new CompanionRpcClient(() => {})
    const p = c.call('m')
    c.handleChunk(serializeFrame({ t: 'res', id: 1, ok: true, data: 42 }))
    await expect(p).resolves.toBe(42)
    // Timer was cleared on resolve, so advancing past the deadline is a no-op
    // and must not produce an unhandled rejection.
    vi.advanceTimersByTime(60_000)
    await Promise.resolve()
  })

  test('constructor requestTimeoutMs default is overridable', async () => {
    const c = new CompanionRpcClient(() => {}, { requestTimeoutMs: 1000 })
    const p = c.call('m')
    const expectation = expect(p).rejects.toThrow(/timed out/)
    vi.advanceTimersByTime(1000)
    await expectation
  })
})
