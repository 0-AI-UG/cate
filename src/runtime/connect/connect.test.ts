// Cate Connect against the local stand-in: a real daemon registers, a client
// looks it up, trades signaling through the service, opens a WebRTC data
// channel (node-datachannel, host candidates only) and runs Noise inside it.
// The man-in-the-middle stand-in cannot complete a connection, and a runtime
// registers under the network id its key derives.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { framePortOver } from '@kernel/rpc/contract'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { createLogger, installLogSink, nullSink, type LogRecord } from '@kernel/log/contract'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { fingerprint, generateKeyPair, networkIdOf, type KeyPair, type MessagePortLike } from '../security/contract'
import { PinMismatchError } from '../security/client'
import { decodePairingUri, pairingCapability, parsePairingCode } from '../pairing/contract'
import { encodeBase64, openPushMessage, pushCapability } from '../push/contract'
import { KnownRuntimes, PairingError } from '../pairing/client'
import type { IceServer, PeerConnectionFactory } from '../transports/contract'
import { openSecureConnection } from '../transports/client'
import { dialLocal, loadNodePeerConnection, nodeWebSocketFactory } from '../transports/node'
import { runtimeCapability } from '../daemon/contract'
import { serveWorkspace, type Daemon } from '../daemon/entry'
import { CateConnectError, CONNECTION_FAILED } from './contract'
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
    expect(await lookupRuntime({ url: service.url, runtimeId: daemon.networkId, webSocket: nodeWebSocketFactory }))
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

    const again = await openSecureConnection(await dial(service, daemon.networkId), {
      kind: 'connect', deviceKeys: phone.keys, runtimeId: daemon.networkId, pins: phone.pins,
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
    expect(service.pushes[0]).toMatchObject({ runtimeId: daemon.networkId, push: { target: `apns:sandbox:${'ab'.repeat(32)}` } })
    expect(openPushMessage(key, service.pushes[0].push.sealed)).toMatchObject({ runtimeId: daemon.networkId, title: 'Build done', body: 'All green' })
  }, 30_000)

  it('a runtime whose key changed registers again and is reachable', async () => {
    const service = await standIn()
    const first = await daemonOn(service)
    await first.stop({ kind: 'signal' })
    daemons.splice(daemons.indexOf(first), 1)
    // secrets.json lost: the runtime makes a new key.
    fs.rmSync(path.join(first.paths.dir, 'secrets.json'))
    const again = await daemonOn(service)
    expect(again.network.registration()!.state()).toEqual({ kind: 'registered' })
    expect(again.networkId).not.toBe(first.networkId)
    expect(await lookupRuntime({ url: service.url, runtimeId: again.networkId, webSocket: nodeWebSocketFactory }))
      .toEqual({ online: true, iceServers: [] })
  }, 30_000)

  it('hands both sides the ICE servers of the session, and logs its path and bytes', async () => {
    const iceServers: IceServer[] = [{ urls: 'turn:relay.test:3478', username: '1700000000', credential: 'c2VjcmV0' }]
    const service = await standIn({ iceServers })
    const records: LogRecord[] = []
    installLogSink((record) => records.push(record))
    // Each side records what it was given, then connects over host candidates.
    const given: { side: string; iceServers: IceServer[] }[] = []
    const recording = (side: string): PeerConnectionFactory => (config) => {
      given.push({ side, iceServers: config.iceServers })
      return createPeer({ iceServers: [] })
    }
    const echoKeys = generateKeyPair()
    const echo = startConnectRegistration({
      url: service.url,
      runtimeKeys: echoKeys,
      webSocket: nodeWebSocketFactory,
      peerConnection: async () => recording('runtime'),
      onConnection: (port) => { port.onMessage((message) => port.send(message)) },
      log: createLogger('connect'),
    })
    registrations.push(echo)
    await registered(echo)
    const port: MessagePortLike = await dialCateConnect({
      url: service.url, runtimeId: networkIdOf(echoKeys.publicKey), webSocket: nodeWebSocketFactory, createPeer: recording('client'),
    })
    const back = new Promise<Uint8Array>((resolve) => port.onMessage(resolve))
    port.send(new Uint8Array(5))
    expect((await back).byteLength).toBe(5)
    port.close()
    expect(given).toEqual(expect.arrayContaining([{ side: 'runtime', iceServers }, { side: 'client', iceServers }]))
    await expect.poll(() => records.map((r) => r.message), { timeout: 10_000 }).toContain('cate connect session %s ended: %s, %d bytes sent, %d received, %ds')
    const ended = records.find((r) => r.message.includes('ended'))!
    expect(ended.args.slice(1, 4)).toEqual(['direct', 5, 5])
  }, 20_000)

  it('says it could not connect when no data channel opens', async () => {
    const service = await standIn()
    const runtimeKeys = generateKeyPair()
    // Registered, but never answers an offer.
    const silent = startConnectRegistration({
      url: service.url,
      runtimeKeys,
      webSocket: nodeWebSocketFactory,
      peerConnection: () => new Promise(() => {}),
      onConnection: () => {},
    })
    registrations.push(silent)
    await registered(silent)
    const error = await dial(service, networkIdOf(runtimeKeys.publicKey), 1_500).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CateConnectError)
    expect(error).toMatchObject({ code: 'no-path', message: CONNECTION_FAILED })
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
      expect(again.networkId).toBe(daemon.networkId)
      await expect(openSecureConnection(await dial(mitm, daemon.networkId), {
        kind: 'connect', deviceKeys: phone.keys, runtimeId: daemon.networkId, pins: phone.pins,
      })).rejects.toBeInstanceOf(PinMismatchError)
      expect(again.rpc.connections().filter((c) => c.client?.device.name === 'phone')).toEqual([])
    }, 40_000)

    it('a QR payload exposes the substituted key', async () => {
      const { service, daemon } = await mitmSetup()
      const payload = decodePairingUri((await addDevice(daemon)).created.uri)
      const phone = { keys: generateKeyPair(), pins: new KnownRuntimes(createMemoryDeviceStore()) }
      await expect(openSecureConnection(await dial(service, payload.runtimeId), {
        kind: 'pair', deviceKeys: phone.keys, deviceName: 'phone', target: payload, pins: phone.pins,
      })).rejects.toMatchObject({ reason: 'id-mismatch' })
      expect(await phone.pins.get(daemon.networkId)).toBeUndefined()
    }, 30_000)

    it('a typed code exposes the substituted key: the id it carries is the key\'s', async () => {
      const { service, daemon } = await mitmSetup()
      const { pairing, created } = await addDevice(daemon)
      const typed = parsePairingCode(created.code)
      const phone = { keys: generateKeyPair(), pins: new KnownRuntimes(createMemoryDeviceStore()) }
      const error = await openSecureConnection(await dial(service, typed.runtimeId), {
        kind: 'pair', deviceKeys: phone.keys, deviceName: 'phone', target: typed, pins: phone.pins,
      }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(PairingError)
      expect(error).toMatchObject({ reason: 'id-mismatch' })
      expect(await phone.pins.get(daemon.networkId)).toBeUndefined()
      expect(await pairing.list()).toEqual([])
    }, 30_000)
  })
})
