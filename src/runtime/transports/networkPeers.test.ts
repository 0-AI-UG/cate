// The network peers' limits on connections that have not proven a paired
// key yet, and closing them (B33).

import { afterEach, beforeEach, expect, it } from 'vitest'
import { RpcServer } from '@kernel/rpc/runtime'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { createMemoryPortPair, generateKeyPair, type MemoryPort } from '../security/contract'
import { createNetworkPeers, type NetworkPeers } from './runtime'

let peers: NetworkPeers
const pending: Promise<void>[] = []

beforeEach(() => {
  peers = createNetworkPeers({
    rpc: new RpcServer({ version: 'test', lifecycle: createLifecycleBus() }),
    runtimeKeys: generateKeyPair(),
    pairing: { isPaired: async () => false, onRevoked: () => () => {} } as never,
    handshakeTimeoutMs: 60_000,
    maxUnproven: 4,
  })
})

afterEach(async () => {
  peers.dispose()
  await Promise.allSettled(pending.splice(0))
})

/** A connection that opens and never starts its handshake. */
function silent(transport: 'sameNetwork' | 'cateConnect', address?: string): MemoryPort {
  const [server] = createMemoryPortPair()
  pending.push(peers.accept(server, { transport, ...(address ? { address } : {}) }))
  return server
}

it('keeps a budget per transport, so unproven Cate Connect peers cannot lock out the LAN', () => {
  const relayed = Array.from({ length: 5 }, () => silent('cateConnect'))
  expect(relayed.filter((port) => port.closed)).toHaveLength(1)
  const local = silent('sameNetwork', '192.168.1.20')
  expect(local.closed).toBe(false)
})

it('closes handshakes in progress with the rest, and one transport alone', () => {
  const relayed = silent('cateConnect')
  const local = silent('sameNetwork', '192.168.1.20')
  peers.close('cateConnect')
  expect(relayed.closed).toBe(true)
  expect(local.closed).toBe(false)
  peers.closeAll()
  expect(local.closed).toBe(true)
})
