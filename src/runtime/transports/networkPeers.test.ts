// The network peers' limits on connections that have not proven a paired
// key yet, and closing them (B33).

import { afterEach, beforeEach, expect, it } from 'vitest'
import { RpcServer } from '@kernel/rpc/runtime'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { bytesEqual, createMemoryPortPair, generateKeyPair, openSecureChannel, type MemoryPort } from '../security/contract'
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

it('frees a slot once the handshake proves a paired key, and holds it while an unknown key pairs', async () => {
  const runtimeKeys = generateKeyPair()
  const device = generateKeyPair()
  peers.dispose()
  peers = createNetworkPeers({
    rpc: new RpcServer({ version: 'test', lifecycle: createLifecycleBus() }),
    runtimeKeys,
    pairing: {
      isPaired: async (key: Uint8Array) => bytesEqual(key, device.publicKey),
      pairUnknown: (channel) => new Promise<boolean>((resolve) => channel.onClose(() => resolve(false))),
      onRevoked: () => () => {},
    },
    maxUnproven: 1,
  })
  const handshake = (keys: typeof device) => {
    const [server, client] = createMemoryPortPair()
    pending.push(peers.accept(server, { transport: 'cateConnect' }))
    return { server, channel: openSecureChannel(client, { role: 'initiator', staticKeys: keys }) }
  }

  const paired = handshake(device)
  await paired.channel
  await pending.at(-1)
  expect(paired.server.closed).toBe(false)
  // The paired device is served and no longer counts as unproven.
  const unknown = handshake(generateKeyPair())
  await unknown.channel
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(unknown.server.closed).toBe(false)
  // The unknown key sits in its pairing attempt and keeps its slot.
  expect(silent('cateConnect').closed).toBe(true)
})
