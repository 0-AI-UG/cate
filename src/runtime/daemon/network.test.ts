// A real daemon with network access: pairing over the LAN WebSocket from the
// QR payload and from a typed code, runtime.json endpoints, and the
// `runtimeNetwork` setting turning the listener on and off.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { framePortOver } from '@kernel/rpc/contract'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import { createLifecycleBus } from '@kernel/lifecycle/contract'
import { createLogger, installLogSink, nullSink } from '@kernel/log/contract'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { settingsCapability } from '@kernel/settings/contract'
import { fingerprint, generateKeyPair } from '@runtime/security/contract'
import { decodePairingUri, pairingCapability, parsePairingCode } from '@runtime/pairing/contract'
import { KnownRuntimes } from '@runtime/pairing/client'
import { readRuntimeInfo } from '@runtime/data/runtime'
import { dialSameNetwork, openSecureConnection } from '@runtime/transports/client'
import { dialLocal, nodeWebSocketFactory } from '@runtime/transports/node'
import { runtimeCapability } from './contract'
import { serveWorkspace, type Daemon } from './entry'

let tmp: string
let home: string
let root: string
const daemons: Daemon[] = []
const clients: RpcClient[] = []

beforeEach(() => {
  installLogSink(nullSink)
  tmp = fs.mkdtempSync('/tmp/cate-n-')
  home = path.join(tmp, 'h')
  root = path.join(tmp, 'w')
  fs.mkdirSync(home)
  fs.mkdirSync(root)
})

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  for (const d of daemons.splice(0)) await d.stop({ kind: 'signal' })
  installLogSink(null)
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function start(network?: 'sameNetwork') {
  const result = await serveWorkspace({
    root,
    home,
    network,
    lifecycle: createLifecycleBus(),
    log: createLogger('test'),
    lan: { host: '127.0.0.1', port: 0, advertise: false, addresses: (port) => [`127.0.0.1:${port}`] },
  })
  if (result.kind !== 'serving') throw new Error('expected to serve')
  daemons.push(result.daemon)
  return result.daemon
}

function client(identity: ConstructorParameters<typeof RpcClient>[0]['identity']) {
  const c = new RpcClient({ version: 'test', identity, helloTimeoutMs: 3_000 })
  clients.push(c)
  return c
}

async function local(daemon: Daemon) {
  const c = client({ client: { clientId: 'desk', device: { name: 'desk', keyFingerprint: '' }, features: [] } })
  await c.attach(framePortOver(await dialLocal(daemon.endpoint), 'stream'))
  return c
}

function device(name: string) {
  const keys = generateKeyPair()
  return {
    keys,
    name,
    pins: new KnownRuntimes(createMemoryDeviceStore()),
    rpc: () => client({ client: { clientId: name, device: { name, keyFingerprint: fingerprint(keys.publicKey) }, features: [] } }),
  }
}

describe.skipIf(process.platform === 'win32')('daemon network access', () => {
  it('pairs a device from the QR payload and serves runtime.info over the network', async () => {
    const daemon = await start('sameNetwork')
    const info = await readRuntimeInfo(daemon.paths.dir)
    expect(info?.endpoints.sameNetwork?.addresses).toHaveLength(1)

    const desk = await local(daemon)
    const created = await createCapabilityProxy(desk, pairingCapability).createSecret({ mode: 'sameNetwork' })
    const payload = decodePairingUri(created.uri)
    expect(payload).toMatchObject({ runtimeId: daemon.runtimeId, mode: 'sameNetwork', addresses: info!.endpoints.sameNetwork!.addresses })

    const phone = device('phone')
    const port = await dialSameNetwork({ runtimeId: payload.runtimeId, addresses: payload.addresses, webSocket: nodeWebSocketFactory })
    const { frames } = await openSecureConnection(port, {
      kind: 'pair', deviceKeys: phone.keys, deviceName: phone.name, target: payload, pins: phone.pins,
    })
    const rpc = phone.rpc()
    await rpc.attach(frames)
    const runtimeInfo = await createCapabilityProxy(rpc, runtimeCapability).info()
    expect(runtimeInfo.runtimeId).toBe(daemon.runtimeId)
    expect(runtimeInfo.clients.map((c) => c.device.name).sort()).toEqual(['desk', 'phone'])
    const paired = await createCapabilityProxy(desk, pairingCapability).list()
    expect(paired).toMatchObject([{ name: 'phone', fingerprint: fingerprint(phone.keys.publicKey) }])
  })

  it('pairs from a typed code, reconnects by key, and a revoke drops it', async () => {
    const daemon = await start('sameNetwork')
    const desk = await local(daemon)
    const pairingApi = createCapabilityProxy(desk, pairingCapability)
    const typed = parsePairingCode((await pairingApi.createSecret({ mode: 'sameNetwork' })).code)
    const discover = async (runtimeId: string) =>
      (await readRuntimeInfo(daemon.paths.dir))?.runtimeId === runtimeId
        ? (await readRuntimeInfo(daemon.paths.dir))!.endpoints.sameNetwork!.addresses
        : []

    const laptop = device('laptop')
    const first = await openSecureConnection(
      await dialSameNetwork({ runtimeId: typed.runtimeId, discover, webSocket: nodeWebSocketFactory }),
      { kind: 'pair', deviceKeys: laptop.keys, deviceName: laptop.name, target: typed, pins: laptop.pins },
    )
    first.channel.close()

    const again = await openSecureConnection(
      await dialSameNetwork({ runtimeId: typed.runtimeId, discover, webSocket: nodeWebSocketFactory }),
      { kind: 'connect', deviceKeys: laptop.keys, runtimeId: typed.runtimeId, pins: laptop.pins },
    )
    const rpc = laptop.rpc()
    await rpc.attach(again.frames)
    expect((await createCapabilityProxy(rpc, runtimeCapability).info()).runtimeId).toBe(daemon.runtimeId)

    const dropped = new Promise<void>((resolve) => rpc.onStateChange((s) => { if (s === 'disconnected') resolve() }))
    const [record] = await pairingApi.list()
    expect(record.lastSeen).toBeGreaterThanOrEqual(record.pairedAt)
    await pairingApi.revoke({ deviceKey: record.publicKey })
    await dropped

    // Coming back with the removed key, the client is told it was refused.
    const removed = await openSecureConnection(
      await dialSameNetwork({ runtimeId: typed.runtimeId, discover, webSocket: nodeWebSocketFactory }),
      { kind: 'connect', deviceKeys: laptop.keys, runtimeId: typed.runtimeId, pins: laptop.pins },
    )
    const refused = laptop.rpc()
    await expect(refused.attach(removed.frames)).rejects.toThrow(/not paired/)
    expect(refused.state).toBe('refused')
  })

  it('follows the runtimeNetwork setting', async () => {
    const daemon = await start()
    expect((await readRuntimeInfo(daemon.paths.dir))?.endpoints.sameNetwork).toBeUndefined()
    const desk = await local(daemon)
    const settings = createCapabilityProxy(desk, settingsCapability)

    await settings.set({ key: 'runtimeNetwork', value: 'sameNetwork' })
    await daemon.network.settled()
    const addresses = daemon.network.addresses()
    expect(addresses).toHaveLength(1)
    await expect.poll(async () => (await readRuntimeInfo(daemon.paths.dir))?.endpoints.sameNetwork?.addresses).toEqual(addresses)

    const phone = device('phone')
    const payload = decodePairingUri((await createCapabilityProxy(desk, pairingCapability).createSecret({ mode: 'sameNetwork' })).uri)
    const { frames } = await openSecureConnection(
      await dialSameNetwork({ runtimeId: daemon.runtimeId, addresses: payload.addresses, webSocket: nodeWebSocketFactory }),
      { kind: 'pair', deviceKeys: phone.keys, deviceName: phone.name, target: payload, pins: phone.pins },
    )
    const rpc = phone.rpc()
    await rpc.attach(frames)
    const dropped = new Promise<void>((resolve) => rpc.onStateChange((s) => { if (s === 'disconnected') resolve() }))

    await settings.set({ key: 'runtimeNetwork', value: 'off' })
    await dropped
    await daemon.network.settled()
    expect(daemon.network.addresses()).toEqual([])
    await expect(dialSameNetwork({ runtimeId: daemon.runtimeId, addresses, webSocket: nodeWebSocketFactory, timeoutMs: 1_000 }))
      .rejects.toThrow()
    await expect.poll(async () => (await readRuntimeInfo(daemon.paths.dir))?.endpoints.sameNetwork).toBeUndefined()
  })
})
