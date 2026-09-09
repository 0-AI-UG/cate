import { describe, expect, it, afterEach, vi } from 'vitest'
import { flushDockWindowsBeforeQuit } from './dockWindowFlush'

function makeAckBus() {
  const handlers = new Set<(id: number, error?: string, requestId?: string) => void>()
  return {
    subscribe: (handler: (id: number, error?: string, requestId?: string) => void) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    ack: (id: number, requestId: string) => { for (const handler of handlers) handler(id, undefined, requestId) },
    count: () => handlers.size,
  }
}
const outcome = (p: Promise<Set<number>>) => p.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
afterEach(() => vi.useRealTimers())

describe('detached flush ordering', () => {
  it('overlapping attempts keep separate receipts and both reject a missing owner', async () => {
    vi.useFakeTimers()
    const bus = makeAckBus(), sendA = vi.fn(), sendB = vi.fn((id: number) => { if (id === 2) throw new Error('window gone') })
    const a = outcome(flushDockWindowsBeforeQuit({ windowIds: [1, 2], requestSync: sendA, subscribeAck: bus.subscribe, timeoutMs: 100 }))
    const b = outcome(flushDockWindowsBeforeQuit({ windowIds: [1, 2], requestSync: sendB, subscribeAck: bus.subscribe, timeoutMs: 100 }))
    bus.ack(1, sendA.mock.calls[0][1])
    await vi.advanceTimersByTimeAsync(100)
    expect((await a).error.message).toContain('timed out: 2')
    expect((await b).error.message).toBe('window gone')
    expect(sendA).toHaveBeenCalledTimes(2)
    expect(sendB).toHaveBeenCalledTimes(2)
    expect(bus.count()).toBe(0)
  })
  it('rejects a window that closes after receiving its request', async () => {
    vi.useFakeTimers()
    const bus = makeAckBus(), send = vi.fn()
    const result = outcome(flushDockWindowsBeforeQuit({ windowIds: [7], requestSync: send, subscribeAck: bus.subscribe, timeoutMs: 100 }))
    await vi.advanceTimersByTimeAsync(100)
    expect((await result).error.message).toContain('7')
    expect(send).toHaveBeenCalledOnce()
    expect(bus.count()).toBe(0)
  })
  it('counts acknowledgements delivered synchronously inside requestSync', async () => {
    const bus = makeAckBus()
    const result = await flushDockWindowsBeforeQuit({ windowIds: [1, 2], requestSync: (id, token) => bus.ack(id, token), subscribeAck: bus.subscribe, timeoutMs: 100 })
    expect([...result]).toEqual([1, 2])
    expect(bus.count()).toBe(0)
  })
  it('ignores late responses after rejecting and removes the subscription', async () => {
    vi.useFakeTimers()
    const bus = makeAckBus(), send = vi.fn()
    const result = outcome(flushDockWindowsBeforeQuit({ windowIds: [1], requestSync: send, subscribeAck: bus.subscribe, timeoutMs: 100 }))
    await vi.advanceTimersByTimeAsync(100)
    expect((await result).error).toBeDefined()
    expect(() => bus.ack(1, send.mock.calls[0][1])).not.toThrow()
    expect(bus.count()).toBe(0)
  })
  it('does not let a previous attempt acknowledge a newer attempt', async () => {
    vi.useFakeTimers()
    const bus = makeAckBus(), sendA = vi.fn(), sendB = vi.fn()
    const a = outcome(flushDockWindowsBeforeQuit({ windowIds: [1], requestSync: sendA, subscribeAck: bus.subscribe, timeoutMs: 100 }))
    await vi.advanceTimersByTimeAsync(100)
    expect((await a).error).toBeDefined()
    const b = outcome(flushDockWindowsBeforeQuit({ windowIds: [1], requestSync: sendB, subscribeAck: bus.subscribe, timeoutMs: 100 }))
    bus.ack(1, sendA.mock.calls[0][1])
    expect(bus.count()).toBe(1)
    bus.ack(1, sendB.mock.calls[0][1])
    expect([...(await b).value!]).toEqual([1])
    expect(bus.count()).toBe(0)
  })
})
