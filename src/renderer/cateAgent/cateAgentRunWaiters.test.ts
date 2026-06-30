import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  awaitRunEnd,
  signalRunEnd,
  incDriverOutstanding,
  decDriverOutstanding,
  driverOutstanding,
  clearDriverOutstanding,
} from './cateAgentRunWaiters'

describe('cateAgentRunWaiters', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('awaitRunEnd resolves on signalRunEnd', async () => {
    const p = awaitRunEnd('panel-1', 10_000)
    let resolved = false
    void p.then(() => {
      resolved = true
    })
    expect(resolved).toBe(false)
    signalRunEnd('panel-1')
    await p
    expect(resolved).toBe(true)
  })

  it('awaitRunEnd resolves on timeout when no signal arrives', async () => {
    const p = awaitRunEnd('panel-2', 5_000)
    vi.advanceTimersByTime(5_000)
    await expect(p).resolves.toBeUndefined()
  })

  it('signalRunEnd for a panel nobody awaits is harmless', () => {
    expect(() => signalRunEnd('nobody')).not.toThrow()
  })

  it('tracks outstanding background sends per driver', () => {
    clearDriverOutstanding('drv')
    expect(driverOutstanding('drv')).toBe(0)
    incDriverOutstanding('drv')
    incDriverOutstanding('drv')
    expect(driverOutstanding('drv')).toBe(2)
    decDriverOutstanding('drv')
    expect(driverOutstanding('drv')).toBe(1)
    decDriverOutstanding('drv')
    expect(driverOutstanding('drv')).toBe(0)
  })

  it('decrement never goes negative and forgets the panel at zero', () => {
    clearDriverOutstanding('drv2')
    decDriverOutstanding('drv2')
    expect(driverOutstanding('drv2')).toBe(0)
  })

  it('settle pattern: a run end with outstanding>0 is not settled; at 0 it is', async () => {
    // Driver submits two background tasks then ends its first run.
    incDriverOutstanding('drv3')
    incDriverOutstanding('drv3')
    const firstRun = awaitRunEnd('drv3', 10_000)
    signalRunEnd('drv3')
    await firstRun
    expect(driverOutstanding('drv3')).toBe(2) // both terminals still working → not settled

    // Each terminal finishing decrements; the final run end at 0 means settled.
    decDriverOutstanding('drv3')
    decDriverOutstanding('drv3')
    const lastRun = awaitRunEnd('drv3', 10_000)
    signalRunEnd('drv3')
    await lastRun
    expect(driverOutstanding('drv3')).toBe(0)
  })
})
