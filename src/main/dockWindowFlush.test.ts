import { describe, expect, it, vi } from 'vitest'
import { flushDockWindowsBeforeQuit } from './dockWindowFlush'

function setup(ids = [1, 2]) {
  let receive!: (id: number, error?: string, requestId?: string) => void
  const requests = vi.fn()
  const unsubscribe = vi.fn()
  const promise = flushDockWindowsBeforeQuit({ windowIds: ids, requestSync: requests,
    subscribeAck: handler => { receive = handler; return unsubscribe }, timeoutMs: 50 })
  const result = promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
  return { result, requests, unsubscribe, ack: (id: number, error?: string, token = requests.mock.calls[0]?.[1]) => receive(id, error, token) }
}

describe('durable detached flush', () => {
  it('does not request absent owners', async () => {
    const h = setup([])
    expect((await h.result).value?.size).toBe(0)
    expect(h.requests).not.toHaveBeenCalled()
  })
  it('waits for all owners and ignores old, duplicate and foreign acknowledgements', async () => {
    const h = setup()
    h.ack(1, undefined, 'old-attempt'); h.ack(9); h.ack(1); h.ack(1)
    expect(h.unsubscribe).not.toHaveBeenCalled()
    h.ack(2)
    expect([...(await h.result).value!]).toEqual([1, 2])
    expect(h.unsubscribe).toHaveBeenCalledOnce()
  })
  it('rejects missing detached owners instead of reporting durability', async () => {
    vi.useFakeTimers()
    try {
      const h = setup()
      h.ack(1)
      await vi.advanceTimersByTimeAsync(50)
      expect((await h.result).error.message).toMatch(/timed out: 2/)
      expect(h.unsubscribe).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  it('rejects publication failures', async () => {
    const h = setup()
    h.ack(1, 'disk full')
    expect((await h.result).error.message).toContain('disk full')
  })
  it('rejects delivery failures', async () => {
    await expect(flushDockWindowsBeforeQuit({ windowIds: [1], requestSync: () => { throw new Error('gone') }, subscribeAck: () => () => {}, timeoutMs: 50 })).rejects.toThrow('gone')
  })
})
