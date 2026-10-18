// Same network end to end over real WebSockets: an RpcServer behind the
// network peers and a PairingService, and clients that pair (QR payload or
// typed code), reconnect by key, get refused, or get revoked.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineCapability, method } from '@kernel/rpc/contract'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import { RpcServer } from '@kernel/rpc/runtime'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { createMemoryPortPair, encodePublicKey, fingerprint, generateKeyPair, networkIdOf, type KeyPair, type MemoryPort } from '../security/contract'
import { connectToRuntime } from '../security/client'
import { decodePairingUri, parsePairingCode } from '../pairing/contract'
import { KnownRuntimes, pairWithRuntime } from '../pairing/client'
import { PairingService, type DevicesFile } from '../pairing/runtime'
import { secureFramePort } from './contract'
import { dialSameNetwork, openSecureConnection, SameNetworkUnreachableError } from './client'
import { nodeWebSocketFactory } from './node'
import { createNetworkPeers, serveSameNetwork, type NetworkPeers, type SameNetworkListener } from './runtime'

const RUNTIME_KEYS = generateKeyPair()
const RUNTIME_ID = networkIdOf(RUNTIME_KEYS.publicKey)
const pingCap = defineCapability('ping', { methods: { ping: method<void, string>() } })

let runtimeKeys: KeyPair
let pairing: PairingService
let peers: NetworkPeers
let lan: SameNetworkListener
let rpc: RpcServer
const clients: RpcClient[] = []

beforeEach(async () => {
  runtimeKeys = RUNTIME_KEYS
  let file: DevicesFile = { devices: [] }
  pairing = new PairingService({
    runtimePublicKey: runtimeKeys.publicKey,
    store: { get: () => file, update: (fn) => { file = fn(file) }, subscribe: () => () => {} },
    addresses: () => lan.addresses(),
    openingTimeoutMs: 2_000,
  })
  rpc = new RpcServer({ version: 'test', lifecycle: createLifecycleBus() })
  rpc.register(pingCap, { ping: () => 'pong' })
  peers = createNetworkPeers({ rpc, runtimeKeys, pairing, handshakeTimeoutMs: 2_000 })
  lan = await serveSameNetwork({
    runtimeId: RUNTIME_ID,
    peers,
    host: '127.0.0.1',
    port: 0,
    advertise: false,
    addresses: (port) => [`127.0.0.1:${port}`],
  })
})

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  peers.dispose()
  await lan.close()
})

function device(name = 'phone') {
  const keys = generateKeyPair()
  const pins = new KnownRuntimes(createMemoryDeviceStore())
  return { name, keys, pins }
}
type Device = ReturnType<typeof device>

function rpcClient(dev: Device, publicKey = encodePublicKey(dev.keys.publicKey)) {
  const client = new RpcClient({
    version: 'test',
    identity: { client: { clientId: `c-${dev.name}`, device: { name: dev.name, publicKey }, features: [] } },
    helloTimeoutMs: 2_000,
  })
  clients.push(client)
  return client
}

const dial = (addresses: string[] = lan.addresses()) =>
  dialSameNetwork({ runtimeId: RUNTIME_ID, addresses, webSocket: nodeWebSocketFactory, timeoutMs: 2_000 })

/** Pairs from a new code's QR payload; resolves with the runtime's key. */
async function pairByQr(dev: Device) {
  const payload = decodePairingUri(pairing.createSecret('sameNetwork').uri)
  expect(payload.addresses).toEqual(lan.addresses())
  return pairWithRuntime(await dial(payload.addresses), {
    deviceKeys: dev.keys,
    deviceName: dev.name,
    target: { runtimeId: payload.runtimeId, secretId: payload.secretId, secret: payload.secret, fingerprint: payload.fingerprint },
    pins: dev.pins,
  })
}

async function connectByKey(dev: Device) {
  return openSecureConnection(await dial(), { deviceKeys: dev.keys, runtimeId: RUNTIME_ID, pins: dev.pins })
}

/** Pairs, then connects by key, as the app does. */
async function joinByQr(dev: Device) {
  await pairByQr(dev)
  return connectByKey(dev)
}

const closed = (client: RpcClient) => new Promise<void>((resolve) => {
  client.onStateChange((state) => { if (state === 'disconnected' || state === 'refused' || state === 'closed') resolve() })
})

describe('same network', () => {
  it('pairs from the QR payload, then connects by key and calls the runtime', async () => {
    const phone = device()
    expect(await pairByQr(phone)).toEqual(runtimeKeys.publicKey)
    expect(await phone.pins.get(RUNTIME_ID)).toEqual(runtimeKeys.publicKey)
    expect(pairing.list()).toMatchObject([{ name: 'phone', fingerprint: fingerprint(phone.keys.publicKey) }])
    // A pairing connection ends once answered.
    expect(peers.connected()).toHaveLength(0)

    const first = await connectByKey(phone)
    const client = rpcClient(phone)
    await client.attach(first.frames)
    expect(await createCapabilityProxy(client, pingCap).ping()).toBe('pong')
    client.detach()
    first.channel.close()

    const again = await connectByKey(phone)
    const second = rpcClient(phone)
    await second.attach(again.frames)
    expect(await createCapabilityProxy(second, pingCap).ping()).toBe('pong')
    expect(peers.connected()).toHaveLength(1)
  })

  it('pairs a device that is already paired again, as after it lost the runtime\'s pin', async () => {
    const phone = device()
    await pairByQr(phone)
    const lost = { ...phone, pins: new KnownRuntimes(createMemoryDeviceStore()) }
    expect(await pairByQr(lost)).toEqual(runtimeKeys.publicKey)
    expect(pairing.list()).toHaveLength(1)
    const { frames } = await connectByKey(lost)
    const client = rpcClient(lost)
    await client.attach(frames)
    expect(await createCapabilityProxy(client, pingCap).ping()).toBe('pong')
  })

  it('pairs from a typed code, finding the runtime by discovery', async () => {
    const { code } = pairing.createSecret('sameNetwork')
    const typed = parsePairingCode(code.toUpperCase().replace(/-/g, ' '))
    const phone = device()
    const port = await dialSameNetwork({
      runtimeId: typed.runtimeId,
      // Stands in for mDNS, which the mdns test covers where multicast works.
      discover: async (runtimeId) => (runtimeId === RUNTIME_ID ? lan.addresses() : []),
      webSocket: nodeWebSocketFactory,
      timeoutMs: 2_000,
    })
    await pairWithRuntime(port, { deviceKeys: phone.keys, deviceName: phone.name, target: typed, pins: phone.pins })
    const { frames } = await connectByKey(phone)
    const client = rpcClient(phone)
    await client.attach(frames)
    expect(await createCapabilityProxy(client, pingCap).ping()).toBe('pong')
  })

  it('refuses a stale address that belongs to another runtime', async () => {
    await expect(dialSameNetwork({
      runtimeId: 'zzzzzzzzzzzzzzzz',
      addresses: lan.addresses(),
      webSocket: nodeWebSocketFactory,
      timeoutMs: 2_000,
    })).rejects.toBeInstanceOf(SameNetworkUnreachableError)
  })

  it('refuses an unknown key that connects, telling it it is not paired', async () => {
    const stranger = device('stranger')
    // It knows the runtime's key, but the runtime does not know its key.
    await stranger.pins.pin(RUNTIME_ID, runtimeKeys.publicKey)
    const { frames } = await connectByKey(stranger)
    const client = rpcClient(stranger)
    const attached = client.attach(frames)
    await expect(attached).rejects.toThrow()
    // The refusal tells an unpaired key nothing about the runtime.
    expect(client.remote?.error).toBeTruthy()
    expect(client.remote?.version).toBe('')
    expect(peers.connected()).toHaveLength(0)
    expect(pairing.list()).toEqual([])
  })

  it('caps connections not yet proven paired, by source and in all', async () => {
    const idle: MemoryPort[] = []
    // A connection that never completes the handshake.
    const stall = (source?: string) => {
      const [a, b] = createMemoryPortPair()
      idle.push(a)
      void peers.accept(b, { transport: 'sameNetwork', ...(source ? { address: source } : {}) })
      return b
    }
    try {
      for (let i = 0; i < 4; i++) stall('10.0.0.9')
      expect(stall('10.0.0.9').closed).toBe(true)
      // Another address, a paired device here, still connects.
      const phone = device()
      await pairByQr(phone)
      const { frames } = await connectByKey(phone)
      const client = rpcClient(phone)
      await client.attach(frames)
      expect(await createCapabilityProxy(client, pingCap).ping()).toBe('pong')

      for (let i = 0; i < 28; i++) expect(stall().closed).toBe(false)
      expect(stall().closed).toBe(true)
    } finally {
      for (const port of idle) port.close()
    }
  })

  it('refuses a wrong proof and ends the connection, and the code still works', async () => {
    const { uri } = pairing.createSecret('sameNetwork')
    const payload = decodePairingUri(uri)
    const guesser = device('guesser')
    const wrong = { runtimeId: RUNTIME_ID, secretId: payload.secretId, secret: new Uint8Array(10).fill(7), fingerprint: payload.fingerprint }
    const port = await dial()
    let portClosed = false
    port.onClose(() => { portClosed = true })
    await expect(pairWithRuntime(port, {
      deviceKeys: guesser.keys, deviceName: 'guesser', target: wrong, pins: guesser.pins,
    })).rejects.toMatchObject({ reason: 'invalid-proof' })
    await new Promise((r) => setTimeout(r, 50))
    expect(portClosed).toBe(true)

    // A wrong attempt does not spoil the real code.
    const phone = device()
    await pairWithRuntime(await dial(), {
      deviceKeys: phone.keys, deviceName: phone.name,
      target: { runtimeId: RUNTIME_ID, secretId: payload.secretId, secret: payload.secret, fingerprint: payload.fingerprint }, pins: phone.pins,
    })
    expect(pairing.list().map((d) => d.name)).toEqual([phone.name])
  })

  it('drops a revoked device and refuses it on reconnect', async () => {
    const phone = device()
    const { frames } = await joinByQr(phone)
    const client = rpcClient(phone)
    await client.attach(frames)
    const gone = closed(client)
    expect(pairing.revoke(pairing.list()[0].publicKey)).toEqual({ removed: true })
    await gone
    expect(peers.connected()).toHaveLength(0)

    const retry = await connectByKey(phone)
    const next = rpcClient(phone)
    await expect(next.attach(retry.frames)).rejects.toThrow()
    expect(pairing.list()).toEqual([])
  })

  it('refuses a hello whose device key is not the connection key', async () => {
    const phone = device()
    const { frames } = await joinByQr(phone)
    const liar = rpcClient(phone, encodePublicKey(generateKeyPair().publicKey))
    await expect(liar.attach(frames)).rejects.toThrow(/device key/)
  })

  it('refuses a caller token on a network connection', async () => {
    const phone = device()
    const { channel } = await joinByQr(phone)
    const caller = new RpcClient({ version: 'test', identity: { caller: { token: 'stolen' } }, helloTimeoutMs: 2_000 })
    clients.push(caller)
    await expect(caller.attach(secureFramePort(channel))).rejects.toThrow(/device key/)
  })

  it('ends a connection whose opening it does not understand', async () => {
    const phone = device()
    await pairByQr(phone)
    const channel = await connectToRuntime(await dial(), { deviceKeys: phone.keys, runtimeId: RUNTIME_ID, pins: phone.pins })
    const ended = new Promise<void>((resolve) => channel.onClose(() => resolve()))
    channel.send(new TextEncoder().encode('{"type":"hello"}'))
    await ended
    expect(peers.connected()).toHaveLength(0)
  })

  it('a device pinned to another key refuses the runtime', async () => {
    const phone = device()
    await phone.pins.pin(RUNTIME_ID, generateKeyPair().publicKey)
    await expect(connectToRuntime(await dial(), { deviceKeys: phone.keys, runtimeId: RUNTIME_ID, pins: phone.pins }))
      .rejects.toThrow(/pinned/)
  })
})
