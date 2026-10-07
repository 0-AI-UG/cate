// Same network serves private addresses only: the address rule, the
// addresses handed out, and the listener closing anyone else before a
// handshake.

import type os from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { RpcServer } from '@kernel/rpc/runtime'
import { generateKeyPair } from '../security/contract'
import { PairingService, type PairingsFile } from '../pairing/runtime'
import { isPrivateAddress, sameNetworkUrl } from './contract'
import { lanAddresses } from './node'
import { createNetworkPeers, serveSameNetwork, type SameNetworkListener } from './runtime'

const RUNTIME_ID = 'abcdefghijklmnop'

describe('isPrivateAddress', () => {
  it.each([
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.15.255.255', false],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.20', true],
    ['192.169.0.1', false],
    ['100.63.255.255', false],
    ['100.64.0.1', true],
    ['100.101.102.103', true],
    ['100.127.255.255', true],
    ['100.128.0.1', false],
    ['169.254.10.10', true],
    ['127.0.0.1', true],
    ['::1', true],
    ['fe80::1', true],
    ['fe80::1%en0', true],
    ['febf::1', true],
    ['fec0::1', false],
    ['fc00::1', true],
    ['fd7a:115c:a1e0::1', true],
    ['::ffff:192.168.1.20', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:8.8.8.8', false],
    ['8.8.8.8', false],
    ['2a01:4f8::1', false],
    ['2001:db8::1', false],
    ['', false],
    ['not an address', false],
  ])('%s is %s', (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected)
  })
})

describe('lanAddresses', () => {
  const entry = (address: string, family: 'IPv4' | 'IPv6', internal = false) =>
    ({ address, family, internal, netmask: '', mac: '', cidr: null }) as os.NetworkInterfaceInfo

  it('keeps private addresses and drops public ones', () => {
    expect(lanAddresses(5000, {
      eth0: [entry('203.0.113.7', 'IPv4'), entry('2a01:4f8::1', 'IPv6'), entry('192.168.1.20', 'IPv4')],
      tailscale0: [entry('100.101.102.103', 'IPv4'), entry('fd7a:115c:a1e0::1', 'IPv6')],
      lo0: [entry('127.0.0.1', 'IPv4', true)],
    })).toEqual(['192.168.1.20:5000', '100.101.102.103:5000'])
  })

  it('falls back to private IPv6, never link-local', () => {
    expect(lanAddresses(5000, {
      eth0: [entry('2a01:4f8::1', 'IPv6'), entry('fe80::1', 'IPv6'), entry('fd00::5', 'IPv6')],
    })).toEqual(['[fd00::5]:5000'])
  })

  it('has none on a machine with only public addresses', () => {
    expect(lanAddresses(5000, {
      eth0: [entry('203.0.113.7', 'IPv4'), entry('2a01:4f8::1', 'IPv6'), entry('fe80::1', 'IPv6')],
    })).toEqual([])
  })
})

describe('same-network listener', () => {
  let lan: SameNetworkListener | null = null

  afterEach(async () => {
    await lan?.close()
    lan = null
  })

  async function serve(isAllowed?: (remoteAddress: string) => boolean) {
    const runtimeKeys = generateKeyPair()
    let file: PairingsFile = { devices: [] }
    const pairing = new PairingService({
      runtimeId: RUNTIME_ID,
      runtimePublicKey: runtimeKeys.publicKey,
      store: { get: () => file, update: (fn) => { file = fn(file) } },
    })
    const rpc = new RpcServer({ version: 'test', lifecycle: createLifecycleBus() })
    const peers = createNetworkPeers({ rpc, runtimeKeys, pairing, handshakeTimeoutMs: 2_000 })
    lan = await serveSameNetwork({ runtimeId: RUNTIME_ID, peers, host: '127.0.0.1', port: 0, advertise: false, isAllowed })
    return sameNetworkUrl(`127.0.0.1:${lan.port}`, RUNTIME_ID)!
  }

  function dial(url: string): Promise<'open' | 'closed'> {
    return new Promise((resolve) => {
      const socket = new WebSocket(url)
      socket.on('open', () => { socket.terminate(); resolve('open') })
      socket.on('error', () => resolve('closed'))
    })
  }

  it('closes a peer it does not allow before the handshake', async () => {
    expect(await dial(await serve(() => false))).toBe('closed')
  })

  it('serves a private address by default', async () => {
    expect(await dial(await serve())).toBe('open')
  })
})
