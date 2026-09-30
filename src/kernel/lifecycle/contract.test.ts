import { describe, expect, it, vi } from 'vitest'
import { createLifecycleBus, type ClientConnection } from './contract'

const client: ClientConnection = { connectionId: 1, clientId: 'c', device: { name: 'd', keyFingerprint: 'f' }, features: [] }

describe('lifecycle bus', () => {
  it('delivers events and isolates failing listeners', async () => {
    const errors: unknown[] = []
    const bus = createLifecycleBus((err) => errors.push(err))
    const seen: string[] = []
    bus.onClientConnected(() => { throw new Error('boom') })
    const off = bus.onClientConnected((c) => seen.push(`up:${c.clientId}`))
    bus.onClientGone((c) => seen.push(`down:${c.clientId}`))
    bus.emitClientConnected(client)
    off()
    bus.emitClientConnected(client)
    bus.emitClientGone(client)
    expect(seen).toEqual(['up:c', 'down:c'])
    expect(errors).toHaveLength(2)
  })

  it('waits for every shutdown listener', async () => {
    const bus = createLifecycleBus(() => {})
    const order: string[] = []
    bus.onShutdown(async () => { await new Promise((r) => setTimeout(r, 5)); order.push('slow') })
    bus.onShutdown(() => { throw new Error('fails') })
    const fast = vi.fn()
    bus.onShutdown(fast)
    await bus.emitShutdown('quit')
    expect(order).toEqual(['slow'])
    expect(fast).toHaveBeenCalledWith('quit')
  })
})
