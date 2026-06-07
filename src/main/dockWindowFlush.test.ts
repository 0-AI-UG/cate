// =============================================================================
// FIX: Quit-time sync race — a dock-window change immediately before quit can
// persist STALE dock state, because main's cached dockWindowState is only
// refreshed on a 5s tick / focus / beforeunload. flushDockWindowsBeforeQuit
// requests a FINAL sync from every dock window and awaits their ACKs, bounded by
// a timeout so quit can never hang. These tests drive the pure logic with a fake
// clock and a manual ack bus.
// =============================================================================

import { describe, expect, it, vi } from 'vitest'
import { flushDockWindowsBeforeQuit } from './dockWindowFlush'

/** A tiny manual ack bus standing in for the IPC ack subscription. */
function makeAckBus() {
  const handlers = new Set<(id: number) => void>()
  return {
    subscribe: (h: (id: number) => void) => {
      handlers.add(h)
      return () => handlers.delete(h)
    },
    ack: (id: number) => {
      for (const h of handlers) h(id)
    },
    handlerCount: () => handlers.size,
  }
}

describe('flushDockWindowsBeforeQuit', () => {
  it('resolves immediately with no windows', async () => {
    const requestSync = vi.fn()
    const acked = await flushDockWindowsBeforeQuit({
      windowIds: [],
      requestSync,
      subscribeAck: () => () => {},
      timeoutMs: 1000,
    })
    expect(acked.size).toBe(0)
    expect(requestSync).not.toHaveBeenCalled()
  })

  it('requests a sync from every window and resolves once ALL ack', async () => {
    const bus = makeAckBus()
    const requestSync = vi.fn()

    const p = flushDockWindowsBeforeQuit({
      windowIds: [1, 2, 3],
      requestSync,
      subscribeAck: bus.subscribe,
      timeoutMs: 10_000,
    })

    expect(requestSync).toHaveBeenCalledTimes(3)
    expect(requestSync.mock.calls.map((c) => c[0]).sort()).toEqual([1, 2, 3])

    bus.ack(1)
    bus.ack(2)
    bus.ack(3)

    const acked = await p
    expect([...acked].sort()).toEqual([1, 2, 3])
    // Subscription cleaned up after settling.
    expect(bus.handlerCount()).toBe(0)
  })

  it('resolves on timeout with only the windows that acked in time', async () => {
    vi.useFakeTimers()
    try {
      const bus = makeAckBus()
      const p = flushDockWindowsBeforeQuit({
        windowIds: [1, 2],
        requestSync: () => {},
        subscribeAck: bus.subscribe,
        timeoutMs: 500,
      })

      bus.ack(1) // only window 1 responds
      vi.advanceTimersByTime(500)

      const acked = await p
      expect([...acked]).toEqual([1])
      expect(bus.handlerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores acks from unknown / duplicate window ids', async () => {
    const bus = makeAckBus()
    const p = flushDockWindowsBeforeQuit({
      windowIds: [1],
      requestSync: () => {},
      subscribeAck: bus.subscribe,
      timeoutMs: 10_000,
    })

    bus.ack(99) // not in the wait set
    bus.ack(1)
    bus.ack(1) // duplicate — must not double-count or error

    const acked = await p
    expect([...acked]).toEqual([1])
  })

  it('does not let a throwing requestSync prevent resolution', async () => {
    vi.useFakeTimers()
    try {
      const bus = makeAckBus()
      const p = flushDockWindowsBeforeQuit({
        windowIds: [1, 2],
        requestSync: (id) => { if (id === 1) throw new Error('window gone') },
        subscribeAck: bus.subscribe,
        timeoutMs: 300,
      })

      bus.ack(2) // window 2 still acks despite window 1 throwing
      vi.advanceTimersByTime(300)
      const acked = await p
      expect([...acked]).toEqual([2])
    } finally {
      vi.useRealTimers()
    }
  })
})
