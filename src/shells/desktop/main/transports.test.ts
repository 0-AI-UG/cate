// The shell's network transport end to end over real WebSockets: pair from a
// link or a typed code, then dial by key and get a message pipe that is
// already inside the security layer (what the renderer's connection frames).

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { createCapabilityProxy, RpcClient } from '@kernel/rpc/client'
import { defineCapability, framePortOver, method } from '@kernel/rpc/contract'
import { RpcServer } from '@kernel/rpc/runtime'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { KnownRuntimes } from '@runtime/pairing/client'
import { PairingService, type PairingsFile } from '@runtime/pairing/runtime'
import { fingerprint, generateKeyPair, type KeyPair } from '@runtime/security/contract'
import { dialSameNetwork } from '@runtime/transports/client'
import { createNetworkPeers, serveSameNetwork, type NetworkPeers, type SameNetworkListener } from '@runtime/transports/runtime'
import { createShellTransportHost, dialLoopbackTcp } from './transports'

const RUNTIME_ID = 'abcdefghijklmnop'
const pingCap = defineCapability('ping', { methods: { ping: method<void, string>() } })

let runtimeKeys: KeyPair
let pairing: PairingService
let peers: NetworkPeers
let lan: SameNetworkListener
const clients: RpcClient[] = []

beforeEach(async () => {
  runtimeKeys = generateKeyPair()
  let file: PairingsFile = { devices: [] }
  pairing = new PairingService({
    runtimeId: RUNTIME_ID,
    runtimePublicKey: runtimeKeys.publicKey,
    store: { get: () => file, update: (fn) => { file = fn(file) } },
    addresses: () => lan.addresses(),
    pairTimeoutMs: 2_000,
  })
  const rpc = new RpcServer({ version: 'test', lifecycle: createLifecycleBus() })
  rpc.register(pingCap, { ping: () => 'pong' })
  peers = createNetworkPeers({ rpc, runtimeKeys, pairing, handshakeTimeoutMs: 2_000 })
  lan = await serveSameNetwork({ runtimeId: RUNTIME_ID, peers, host: '127.0.0.1', port: 0, advertise: false, addresses: (port) => [`127.0.0.1:${port}`] })
})

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  peers.dispose()
  await lan.close()
})

function shell() {
  const deviceKeys = generateKeyPair()
  const pins = new KnownRuntimes(createMemoryDeviceStore())
  const host = createShellTransportHost({
    startLocal: () => Promise.reject(new Error('no local runtimes here')),
    deviceKeys: () => deviceKeys,
    deviceName: () => 'laptop',
    pins,
    // Discovery stands in for mDNS, which the transports' own test covers.
    sameNetwork: (options) => dialSameNetwork({ ...options, discover: async (id) => (id === RUNTIME_ID ? lan.addresses() : []) }),
    cateConnect: () => Promise.reject(new Error('Cate Connect is not part of this test')),
  })
  return { host, pins, deviceKeys }
}

async function ping(duplex: Awaited<ReturnType<ReturnType<typeof shell>['host']['dialNetwork']>>, keys: KeyPair) {
  const client = new RpcClient({
    version: 'test',
    identity: { client: { clientId: 'c1', device: { name: 'laptop', keyFingerprint: fingerprint(keys.publicKey) }, features: [] } },
  })
  clients.push(client)
  await client.attach(framePortOver(duplex, 'message'))
  return createCapabilityProxy(client, pingCap).ping()
}

describe('shell transports: network', () => {
  it('pairs from a link, pins the runtime key, then dials by key into the security layer', async () => {
    const { host, pins, deviceKeys } = shell()
    const { uri } = pairing.createSecret('sameNetwork')
    const paired = await host.pair({ link: uri })
    expect(paired).toEqual({ runtimeId: RUNTIME_ID, addresses: lan.addresses(), mode: 'sameNetwork', publicKey: runtimeKeys.publicKey })
    expect(await pins.get(RUNTIME_ID)).toEqual(runtimeKeys.publicKey)
    expect(pairing.list()).toMatchObject([{ name: 'laptop' }])

    const [address, port] = lan.addresses()[0].split(':')
    const duplex = await host.dialNetwork({ runtimeId: RUNTIME_ID, endpoints: [{ kind: 'lan', address, port: Number(port) }] })
    expect(await ping(duplex, deviceKeys)).toBe('pong')
  })

  it('pairs from a typed code found by discovery', async () => {
    const { host, pins } = shell()
    const { code } = pairing.createSecret('sameNetwork')
    const paired = await host.pair({ link: code, deviceName: 'work laptop' })
    expect(paired.mode).toBe('sameNetwork')
    expect(await pins.get(RUNTIME_ID)).toEqual(runtimeKeys.publicKey)
    expect(pairing.list()).toMatchObject([{ name: 'work laptop' }])
  })

  it('refuses to dial a runtime it never paired with', async () => {
    const { host } = shell()
    await expect(host.dialNetwork({ runtimeId: RUNTIME_ID, endpoints: [] })).rejects.toThrow()
  })
})

describe('shell transports: loopback TCP', () => {
  it('connects to a port on this machine', async () => {
    const server = http.createServer((_req, res) => res.end('hi'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const duplex = await dialLoopbackTcp((server.address() as AddressInfo).port)
    const text = await new Promise<string>((resolve) => {
      let out = ''
      duplex.onData((bytes) => { out += Buffer.from(bytes).toString() })
      duplex.onClose(() => resolve(out))
      duplex.write(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'))
    })
    expect(text).toMatch(/200 OK[\s\S]*hi$/)
    await new Promise((resolve) => server.close(resolve))
    await expect(dialLoopbackTcp(0)).rejects.toThrow('invalid port')
  })
})
