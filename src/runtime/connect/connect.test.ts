// Cate Connect against the local stand-in: a real daemon registers, a client
// looks it up, trades signaling through the service, opens a WebRTC data
// channel (node-datachannel, host candidates only) and runs Noise inside it.
// The man-in-the-middle stand-in cannot complete a connection, and the
// service refuses a second key for a registered runtimeId.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { framePortOver } from '@kernel/rpc/contract'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { createLogger, installLogSink, nullSink } from '@kernel/log/contract'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { fingerprint, generateKeyPair, type KeyPair } from '../security/contract'
import { PinMismatchError } from '../security/client'
import { decodePairingUri, pairingCapability, parsePairingCode } from '../pairing/contract'
import { encodeBase64, openPushMessage, pushCapability } from '../push/contract'
import { KnownRuntimes, PairingError } from '../pairing/client'
import type { PeerConnectionFactory } from '../transports/contract'
import { openSecureConnection } from '../transports/client'
import { dialLocal, loadNodePeerConnection, nodeWebSocketFactory } from '../transports/node'
import { runtimeCapability } from '../daemon/contract'
import { serveWorkspace, type Daemon } from '../daemon/entry'
import { CateConnectError, DIRECT_CONNECTION_FAILED } from './contract'
import { dialCateConnect, lookupRuntime } from './client'
import { startConnectRegistration, type ConnectRegistration, type RegistrationState } from './runtime'
import { startConnectStandIn, type ConnectStandIn } from './testing/standIn'

let createPeer: PeerConnectionFactory
let tmp: string
const daemons: Daemon[] = []
const services: ConnectStandIn[] = []
const clients: RpcClient[] = []
const registrations: ConnectRegistration[] = []

beforeAll(async () => {
  createPeer = await loadNodePeerConnection()
})

beforeEach(() => {
  installLogSink(nullSink)
  tmp = fs.mkdtempSync('/tmp/cate-c-')
})

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  for (const registration of registrations.splice(0)) registration.close()
  for (const daemon of daemons.splice(0)) await daemon.stop({ kind: 'signal' })
  for (const service of services.splice(0)) await service.close()
  installLogSink(null)
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function standIn(options?: Parameters<typeof startConnectStandIn>[0]) {
  const service = await startConnectStandIn(options)
  services.push(service)
  return service
}

async function daemonOn(service: ConnectStandIn, name = 'w') {
  const root = path.join(tmp, name)
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(path.join(tmp, 'h'), { recursive: true })
  const result = await serveWorkspace({
    root,
    home: path.join(tmp, 'h'),
    network: 'cateConnect',
    lifecycle: createLifecycleBus(),
    log: createLogger('test'),
    lan: { host: '127.0.0.1', port: 0, advertise: false, addresses: () => [] },
    connect: { url: service.url },
  })
  if (result.kind !== 'serving') throw new Error('expected to serve')
  daemons.push(result.daemon)
  await registered(result.daemon.network.registration()!)
  return result.daemon
}

function registered(registration: ConnectRegistration): Promise<RegistrationState> {
  return new Promise((resolve) => {
    const check = (state: RegistrationState) => { if (state.kind === 'registered' || state.kind === 'refused') resolve(state) }
    registration.onState(check)
    check(registration.state())
  })
}

function rpcClient(name: string, keys: KeyPair) {
  const client = new RpcClient({
    version: 'test',
    identity: { client: { clientId: name, device: { name, keyFingerprint: fingerprint(keys.publicKey) }, features: [] } },
    helloTimeoutMs: 3_000,
  })
  clients.push(client)
  return client
}

/** A local client asks for a pairing secret, as "Add device" does. */
async function addDevice(daemon: Daemon) {
  const desk = new RpcClient({ version: 'test', identity: { client: { clientId: 'desk', device: { name: 'desk', keyFingerprint: '' }, features: [] } } })
  clients.push(desk)
  await desk.attach(framePortOver(await dialLocal(daemon.endpoint), 'stream'))
  const pairing = createCapabilityProxy(desk, pairingCapability)
  return { pairing, created: await pairing.createSecret({ mode: 'cateConnect' }) }
}

const dial = (service: ConnectStandIn, runtimeId: string, timeoutMs = 10_000) =>
  dialCateConnect({ url: service.url, runtimeId, webSocket: nodeWebSocketFactory, createPeer, timeoutMs })

describe.skipIf(process.platform === 'win32')('cate connect', { timeout: 30_000 }, () => {
  it('pairs and calls runtime.info over a WebRTC data channel, then reconnects by key', async () => {
    const service = await standIn()
    const daemon = await daemonOn(service)
    expect(await lookupRuntime({ url: service.url, runtimeId: daemon.runtimeId, webSocket: nodeWebSocketFactory }))
      .toEqual({ online: true, iceServers: [] })

    const { created } = await addDevice(daemon)
    const payload = decodePairingUri(created.uri)
    expect(payload.mode).toBe('cateConnect')
    const phone = { keys: generateKeyPair(), pins: new KnownRuntimes(createMemoryDeviceStore()) }

    const paired = await openSecureConnection(await dial(service, payload.runtimeId), {
      kind: 'pair', deviceKeys: phone.keys, deviceName: 'phone', target: payload, pins: phone.pins,
    })
    const first = rpcClient('phone', phone.keys)
    await first.attach(paired.frames)
    expect((await createCapabilityProxy(first, runtimeCapability).info()).runtimeId).toBe(daemon.runtimeId)
    first.detach()
    paired.channel.close()

    const again = await openSecureConnection(await dial(service, daemon.runtimeId), {
      kind: 'connect', deviceKeys: phone.keys, runtimeId: daemon.runtimeId, pins: phone.pins,
    })
    const second = rpcClient('phone', phone.keys)
    await second.attach(again.frames)
    const info = await createCapabilityProxy(second, runtimeCapability).info()
    expect(info.clients.map((c) => c.device.name)).toContain('phone')
  }, 30_000)

  it('forwards an agent notification to a registered device, sealed for it', async () => {
    const service = await standIn({ push: () => 'sent' })
    const daemon = await daemonOn(service)
    const payload = decodePairingUri((await addDevice(daemon)).created.uri)
    const phone = { keys: generateKeyPair(), pins: new KnownRuntimes(createMemoryDeviceStore()) }
    const paired = await openSecureConnection(await dial(service, payload.runtimeId), {
      kind: 'pair', deviceKeys: phone.keys, deviceName: 'phone', target: payload, pins: phone.pins,
    })
    const client = rpcClient('phone', phone.keys)
    await client.attach(paired.frames)
    const push = createCapabilityProxy(client, pushCapability)
    const key = new Uint8Array(32).fill(3)
    expect(await push.register({ target: `apns:sandbox:${'ab'.repeat(32)}`, key: encodeBase64(key) }))
      .toEqual({ registered: true, blocked: null })

    daemon.workspace.agents.notifications.publish({ kind: 'cate.ui.notify', title: 'Build done', body: 'All green' })
    await expect.poll(() => service.pushes.length).toBe(1)
    expect(service.pushes[0]).toMatchObject({ runtimeId: daemon.runtimeId, push: { target: `apns:sandbox:${'ab'.repeat(32)}` } })
    expect(openPushMessage(key, service.pushes[0].push.sealed)).toMatchObject({ runtimeId: daemon.runtimeId, title: 'Build done', body: 'All green' })
  }, 30_000)

  it('refuses a second registration of the runtimeId with another key', async () => {
    const service = await standIn()
    const daemon = await daemonOn(service)
    const impostor = startConnectRegistration({
      url: service.url,
      runtimeId: daemon.runtimeId,
      runtimeKeys: generateKeyPair(),
      webSocket: nodeWebSocketFactory,
      peerConnection: async () => createPeer,
      onConnection: () => { throw new Error('the impostor must never get a session') },
    })
    registrations.push(impostor)
    expect(await registered(impostor)).toEqual({ kind: 'refused', reason: 'key-mismatch' })
    expect(service.online(daemon.runtimeId)).toBe(true)
    expect(service.bindings().size).toBe(1)
  }, 20_000)

  it('says it could not connect directly when no data channel opens', async () => {
    const service = await standIn()
    const runtimeKeys = generateKeyPair()
    // Registered, but never answers an offer.
    const silent = startConnectRegistration({
      url: service.url,
      runtimeId: 'silentsilentsile',
      runtimeKeys,
      webSocket: nodeWebSocketFactory,
      peerConnection: () => new Promise(() => {}),
      onConnection: () => {},
    })
    registrations.push(silent)
    await registered(silent)
    const error = await dial(service, 'silentsilentsile', 1_500).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CateConnectError)
    expect(error).toMatchObject({ code: 'direct-failed', message: DIRECT_CONNECTION_FAILED })
    await expect(dial(service, 'offlineofflineof')).rejects.toMatchObject({ code: 'offline' })
  }, 20_000)

  describe('through a man in the middle', () => {
    async function mitmSetup() {
      const service = await standIn({ mitm: { keys: generateKeyPair(), createPeer } })
      const daemon = await daemonOn(service)
      return { service, daemon }
    }

    it('a paired device refuses the substituted key', async () => {
      // Pair honestly first, then meet the man in the middle.
      const honest = await standIn()
      const daemon = await daemonOn(honest)
      const payload = decodePairingUri((await addDevice(daemon)).created.uri)
      const phone = { keys: generateKeyPair(), pins: new KnownRuntimes(createMemoryDeviceStore()) }
      const paired = await openSecureConnection(await dial(honest, payload.runtimeId), {
        kind: 'pair', deviceKeys: phone.keys, deviceName: 'phone', target: payload, pins: phone.pins,
      })
      paired.channel.close()
      await daemon.stop({ kind: 'signal' })
      daemons.splice(daemons.indexOf(daemon), 1)

      const mitm = await standIn({ mitm: { keys: generateKeyPair(), createPeer } })
      const again = await daemonOn(mitm)
      expect(again.runtimeId).toBe(daemon.runtimeId)
      await expect(openSecureConnection(await dial(mitm, daemon.runtimeId), {
        kind: 'connect', deviceKeys: phone.keys, runtimeId: daemon.runtimeId, pins: phone.pins,
      })).rejects.toBeInstanceOf(PinMismatchError)
      expect(again.rpc.connections().filter((c) => c.client?.device.name === 'phone')).toEqual([])
    }, 40_000)

    it('a QR payload exposes the substituted key', async () => {
      const { service, daemon } = await mitmSetup()
      const payload = decodePairingUri((await addDevice(daemon)).created.uri)
      const phone = { keys: generateKeyPair(), pins: new KnownRuntimes(createMemoryDeviceStore()) }
      await expect(openSecureConnection(await dial(service, payload.runtimeId), {
        kind: 'pair', deviceKeys: phone.keys, deviceName: 'phone', target: payload, pins: phone.pins,
      })).rejects.toMatchObject({ reason: 'fingerprint-mismatch' })
      expect(await phone.pins.get(daemon.runtimeId)).toBeUndefined()
    }, 30_000)

    it('a typed code cannot be relayed: the proofs bind each handshake', async () => {
      const { service, daemon } = await mitmSetup()
      const { pairing, created } = await addDevice(daemon)
      const typed = parsePairingCode(created.code)
      const phone = { keys: generateKeyPair(), pins: new KnownRuntimes(createMemoryDeviceStore()) }
      const error = await openSecureConnection(await dial(service, typed.runtimeId), {
        kind: 'pair', deviceKeys: phone.keys, deviceName: 'phone', target: typed, pins: phone.pins,
      }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(PairingError)
      expect(error).toMatchObject({ reason: 'invalid-proof' })
      expect(service.mitmEvents).toEqual(expect.arrayContaining([
        { side: 'client', outcome: 'secured' },
        { side: 'runtime', outcome: 'secured' },
      ]))
      expect(await phone.pins.get(daemon.runtimeId)).toBeUndefined()
      expect(await pairing.list()).toEqual([])
    }, 30_000)
  })
})
