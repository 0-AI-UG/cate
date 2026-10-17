import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import {
  bytesToHex,
  bytesEqual,
  createMemoryPortPair,
  fingerprint,
  generateKeyPair,
  networkIdOf,
  openSecureChannel,
  type KeyPair,
} from '../security/contract'
import { acceptPeer, UnpairedPeerError } from '../security/runtime'
import { connectToRuntime } from '../security/client'
import {
  clientProof,
  decodePairingUri,
  encodePairingUri,
  encodePairMessage,
  formatPairingCode,
  PAIRING_SECRET_TTL_MS,
  parsePairingCode,
  runtimeProof,
  verifyClientProof,
  verifyRuntimeProof,
  PairingFormatError,
} from './contract'
import { KnownRuntimes, pairWithRuntime, PairingError } from './client'
import { openDevicesFile, pairingCapabilityImpl, PairingService, type DevicesFile, type DevicesStore } from './runtime'

const RUNTIME_KEYS = generateKeyPair()
const RUNTIME_ID = networkIdOf(RUNTIME_KEYS.publicKey)

/** The devices file in memory; `edit` changes it as a hand edit does. */
function memoryStore(): DevicesStore & { edit(next: DevicesFile): void } {
  let value: DevicesFile = { devices: [] }
  const listeners = new Set<(next: DevicesFile, origin: 'local' | 'external') => void>()
  return {
    get: () => value,
    update: (fn) => { value = fn(value); for (const l of [...listeners]) l(value, 'local') },
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) },
    edit: (next) => { value = next; for (const l of [...listeners]) l(value, 'external') },
  }
}

function setup(options: { now?: () => number } = {}) {
  const runtimeKeys = RUNTIME_KEYS
  const store = memoryStore()
  const service = new PairingService({
    runtimePublicKey: runtimeKeys.publicKey,
    store,
    addresses: () => ['192.168.1.4:4100'],
    now: options.now,
  })
  const deviceStore = createMemoryDeviceStore()
  const pins = new KnownRuntimes(deviceStore)
  return { runtimeKeys, service, deviceStore, pins, store }
}

interface Secret { secretId: string; secret: Uint8Array }

async function attempt(
  ctx: ReturnType<typeof setup>,
  { secretId, secret }: Secret,
  deviceKeys: KeyPair = generateKeyPair(),
  fp?: string,
  runtimeId = RUNTIME_ID,
) {
  const [a, b] = createMemoryPortPair()
  const accepted = acceptPeer(b, { runtimeKeys: ctx.runtimeKeys, policy: ctx.service })
  const paired = pairWithRuntime(a, {
    deviceKeys,
    deviceName: 'Anton’s phone',
    target: { runtimeId, secretId, secret, fingerprint: fp },
    pins: ctx.pins,
  })
  const [client, runtime] = await Promise.allSettled([paired, accepted])
  return { client, runtime, deviceKeys }
}

function secretOf(uri: string): Secret {
  const { secretId, secret } = decodePairingUri(uri)
  return { secretId, secret }
}

describe('pairing payload and code', () => {
  const secret = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

  it('round trips the QR payload', () => {
    const payload = {
      runtimeId: RUNTIME_ID,
      fingerprint: fingerprint(generateKeyPair().publicKey),
      secretId: 'ab2c',
      secret,
      mode: 'cateConnect' as const,
      addresses: ['192.168.1.4:4100', '[fe80::1]:4100'],
    }
    const uri = encodePairingUri(payload)
    expect(uri.startsWith(`cate://pair?r=${RUNTIME_ID}&k=`)).toBe(true)
    expect(decodePairingUri(uri)).toEqual(payload)
    expect(decodePairingUri(encodePairingUri({ ...payload, addresses: [] })).addresses).toEqual([])
  })

  it('rejects malformed payloads', () => {
    expect(() => decodePairingUri('https://x')).toThrow(PairingFormatError)
    expect(() => decodePairingUri('cate://pair?r=short&k=x&s=y&m=sameNetwork')).toThrow(PairingFormatError)
    const uri = encodePairingUri({ runtimeId: RUNTIME_ID, fingerprint: fingerprint(RUNTIME_KEYS.publicKey), secretId: 'ab2c', secret, mode: 'sameNetwork', addresses: [] })
    expect(() => decodePairingUri(uri.replace('&i=ab2c', ''))).toThrow(PairingFormatError)
  })

  it('round trips the 36-character code in groups of four', () => {
    const code = formatPairingCode({ runtimeId: RUNTIME_ID, secretId: 'ab2c', secret })
    expect(code).toMatch(/^([a-z2-7]{4}-){8}[a-z2-7]{4}$/)
    expect(code.replace(/-/g, '')).toHaveLength(36)
    expect(parsePairingCode(code)).toEqual({ runtimeId: RUNTIME_ID, secretId: 'ab2c', secret })
    expect(parsePairingCode(code.toUpperCase().replace(/-/g, ' '))).toEqual({ runtimeId: RUNTIME_ID, secretId: 'ab2c', secret })
    expect(() => parsePairingCode('abcd')).toThrow(PairingFormatError)
  })

  it('proofs verify both ways and are bound to the label and handshake', () => {
    const hash = new Uint8Array(64).fill(5)
    expect(verifyClientProof(secret, hash, clientProof(secret, hash))).toBe(true)
    expect(verifyRuntimeProof(secret, hash, runtimeProof(secret, hash))).toBe(true)
    expect(verifyRuntimeProof(secret, hash, clientProof(secret, hash))).toBe(false)
    expect(verifyClientProof(secret, new Uint8Array(64), clientProof(secret, hash))).toBe(false)
  })
})

describe('a same-network code on a machine devices cannot reach', () => {
  it('says so with a same-network code only', () => {
    const service = new PairingService({ runtimePublicKey: RUNTIME_KEYS.publicKey, store: memoryStore(), sameNetworkProblem: () => 'publicNetwork' })
    expect(service.createSecret('sameNetwork').sameNetworkProblem).toBe('publicNetwork')
    expect(service.createSecret('cateConnect')).not.toHaveProperty('sameNetworkProblem')
    expect(setup().service.createSecret('sameNetwork')).not.toHaveProperty('sameNetworkProblem')
  })
})

describe('pairing flow', () => {
  it('pairs: stores the device, pins the runtime and burns the secret', async () => {
    const ctx = setup()
    const created = ctx.service.createSecret('sameNetwork')
    expect(decodePairingUri(created.uri).addresses).toEqual(['192.168.1.4:4100'])
    const { client, runtime, deviceKeys } = await attempt(ctx, secretOf(created.uri), undefined, fingerprint(ctx.runtimeKeys.publicKey))
    expect(client.status).toBe('fulfilled')
    expect(runtime.status).toBe('fulfilled')

    expect(ctx.service.isPaired(deviceKeys.publicKey)).toBe(true)
    const [device] = ctx.service.list()
    expect(device.name).toBe('Anton’s phone')
    expect(device.fingerprint).toBe(fingerprint(deviceKeys.publicKey))
    expect(bytesEqual((await ctx.pins.get(RUNTIME_ID))!, ctx.runtimeKeys.publicKey)).toBe(true)

    // The channel stays open for hello.
    if (client.status === 'fulfilled' && runtime.status === 'fulfilled') {
      const got = new Promise<Uint8Array>((resolve) => runtime.value.onFrame(resolve))
      client.value.send(Uint8Array.of(42))
      expect((await got)[0]).toBe(42)
    }

    // Single use.
    const again = await attempt(ctx, secretOf(created.uri))
    expect(again.client.status).toBe('rejected')
    expect((again.client as PromiseRejectedResult).reason.reason).toBe('no-secret')
  })

  it('then reconnects by key with no secret', async () => {
    const ctx = setup()
    const { deviceKeys } = await attempt(ctx, secretOf(ctx.service.createSecret('sameNetwork').uri))
    const [a, b] = createMemoryPortPair()
    const [client, runtime] = await Promise.all([
      connectToRuntime(a, { deviceKeys, runtimeId: RUNTIME_ID, pins: ctx.pins }),
      acceptPeer(b, { runtimeKeys: ctx.runtimeKeys, policy: ctx.service }),
    ])
    expect(client.closed || runtime.closed).toBe(false)
  })

  it('records a device that connected as a user of the machine, which is then known on the network too', async () => {
    const ctx = setup()
    const deviceKeys = generateKeyPair()
    const publicKey = bytesToHex(deviceKeys.publicKey)
    ctx.service.connected({ name: 'Laptop', publicKey })
    // A connection that is no device (`cate serve`) is not recorded.
    ctx.service.connected({ name: 'cate serve', publicKey: '' })
    expect(ctx.service.list()).toMatchObject([{ publicKey, name: 'Laptop', admittedBy: 'machineUser' }])
    expect(ctx.service.isPaired(deviceKeys.publicKey)).toBe(true)

    // Connecting again only updates its name and when it was seen.
    ctx.service.connected({ name: 'Laptop 2', publicKey })
    expect(ctx.service.list()).toMatchObject([{ publicKey, name: 'Laptop 2', admittedBy: 'machineUser' }])
  })

  it('a paired device that connects stays paired', async () => {
    const ctx = setup()
    const { deviceKeys } = await attempt(ctx, secretOf(ctx.service.createSecret('sameNetwork').uri))
    ctx.service.connected({ name: 'phone', publicKey: bytesToHex(deviceKeys.publicKey) })
    expect(ctx.service.list()).toMatchObject([{ name: 'phone', admittedBy: 'pairing' }])
  })

  it('makes a secret only when the person confirmed this time', () => {
    const impl = pairingCapabilityImpl(setup().service)
    const ctx = {} as Parameters<typeof impl.createSecret>[1]
    expect(() => impl.createSecret({ mode: 'sameNetwork' } as never, ctx)).toThrow(/must confirm/)
    expect(impl.createSecret({ mode: 'sameNetwork', acknowledged: true }, ctx)).toMatchObject({ code: expect.any(String) })
  })

  it('revokes a device removed by editing devices.json, as removing it in the app does', async () => {
    const ctx = setup()
    const revoked: string[] = []
    ctx.service.onRevoked((key) => revoked.push(key))
    const { deviceKeys } = await attempt(ctx, secretOf(ctx.service.createSecret('sameNetwork').uri))
    const kept = ctx.store.get().devices[0]!
    ctx.store.edit({ devices: [] })
    expect(revoked).toEqual([kept.publicKey])
    expect(ctx.service.isPaired(deviceKeys.publicKey)).toBe(false)
  })

  it('tells watchers about every change of the device list', async () => {
    const ctx = setup()
    const seen: string[][] = []
    const stop = ctx.service.watch((devices) => seen.push(devices.map((d) => d.fingerprint)))
    const { deviceKeys } = await attempt(ctx, secretOf(ctx.service.createSecret('sameNetwork').uri))
    const fp = fingerprint(deviceKeys.publicKey)
    expect(seen.at(-1)).toEqual([fp])
    ctx.service.revoke(ctx.service.list()[0]!.publicKey)
    expect(seen.at(-1)).toEqual([])
    stop()
    await attempt(ctx, secretOf(ctx.service.createSecret('sameNetwork').uri))
    expect(seen.at(-1)).toEqual([])
  })

  it('a wrong proof burns nothing, so finding a live id does not spoil its code', async () => {
    const ctx = setup()
    const first = secretOf(ctx.service.createSecret('sameNetwork').uri)
    for (let i = 0; i < 10; i++) {
      const wrong = await attempt(ctx, { secretId: first.secretId, secret: new Uint8Array(10).fill(i) })
      expect((wrong.client as PromiseRejectedResult).reason.reason).toBe('invalid-proof')
      expect((wrong.runtime as PromiseRejectedResult).reason).toBeInstanceOf(UnpairedPeerError)
    }
    const right = await attempt(ctx, first)
    expect(right.client.status).toBe('fulfilled')
    expect(ctx.service.list()).toHaveLength(1)
    // Used once: the code is gone now.
    const again = await attempt(ctx, first)
    expect((again.client as PromiseRejectedResult).reason.reason).toBe('no-secret')
  })

  it('an unknown secret id is refused and burns nothing', async () => {
    const ctx = setup()
    const created = secretOf(ctx.service.createSecret('sameNetwork').uri)
    const unknown = created.secretId === 'aaaa' ? 'bbbb' : 'aaaa'
    for (let i = 0; i < 10; i++) {
      const guess = await attempt(ctx, { secretId: unknown, secret: new Uint8Array(10).fill(i) })
      expect((guess.client as PromiseRejectedResult).reason.reason).toBe('no-secret')
    }
    expect((await attempt(ctx, created)).client.status).toBe('fulfilled')
  })

  it('an expired secret is refused', async () => {
    let now = 1_000
    const ctx = setup({ now: () => now })
    const created = ctx.service.createSecret('sameNetwork')
    expect(created.expiresAt).toBe(1_000 + PAIRING_SECRET_TTL_MS)
    now += PAIRING_SECRET_TTL_MS
    const late = await attempt(ctx, secretOf(created.uri))
    expect((late.client as PromiseRejectedResult).reason.reason).toBe('no-secret')
  })

  it('client aborts when the runtime key does not match the QR fingerprint', async () => {
    const ctx = setup()
    const created = ctx.service.createSecret('sameNetwork')
    const result = await attempt(ctx, secretOf(created.uri), undefined, fingerprint(generateKeyPair().publicKey))
    expect((result.client as PromiseRejectedResult).reason.reason).toBe('fingerprint-mismatch')
    expect(await ctx.pins.get(RUNTIME_ID)).toBeUndefined()
  })

  it('client rejects a runtime whose key does not derive the code\'s id, and pins nothing', async () => {
    const ctx = setup()
    const created = ctx.service.createSecret('sameNetwork')
    const result = await attempt(ctx, secretOf(created.uri), undefined, undefined, 'abcdefghijklmnop')
    expect(result.client.status).toBe('rejected')
    expect((result.client as PromiseRejectedResult).reason.reason).toBe('id-mismatch')
    expect(await ctx.pins.list()).toEqual({})
  })

  it('client rejects a runtime that cannot prove the secret', async () => {
    const ctx = setup()
    const [a, b] = createMemoryPortPair()
    const fake = openSecureChannel(b, { role: 'responder', staticKeys: generateKeyPair() }).then((channel) => {
      channel.onFrame(() => channel.send(encodePairMessage({ type: 'paired', proof: bytesToHex(new Uint8Array(32)) })))
    })
    const pairing = pairWithRuntime(a, {
      deviceKeys: generateKeyPair(),
      deviceName: 'x',
      target: { runtimeId: RUNTIME_ID, secretId: 'aaaa', secret: new Uint8Array(10) },
      pins: ctx.pins,
    })
    await fake
    await expect(pairing).rejects.toBeInstanceOf(PairingError)
    expect(await ctx.pins.get(RUNTIME_ID)).toBeUndefined()
  })

  it('revoke removes the device and notifies so connections drop', async () => {
    const ctx = setup()
    const { deviceKeys } = await attempt(ctx, secretOf(ctx.service.createSecret('sameNetwork').uri))
    const revoked: string[] = []
    ctx.service.onRevoked((key) => revoked.push(key))
    expect(ctx.service.revoke(bytesToHex(deviceKeys.publicKey))).toEqual({ removed: true })
    expect(revoked).toEqual([bytesToHex(deviceKeys.publicKey)])
    expect(ctx.service.isPaired(deviceKeys.publicKey)).toBe(false)
    expect(ctx.service.revoke(bytesToHex(deviceKeys.publicKey))).toEqual({ removed: false })

    const [a, b] = createMemoryPortPair()
    const accepted = acceptPeer(b, { runtimeKeys: ctx.runtimeKeys, policy: ctx.service })
    const client = await connectToRuntime(a, { deviceKeys, runtimeId: RUNTIME_ID, pins: ctx.pins })
    client.send(Uint8Array.of(1))
    await expect(accepted).rejects.toBeInstanceOf(UnpairedPeerError)
  })

  it('forgetting a runtime deletes its pin', async () => {
    const pins = new KnownRuntimes(createMemoryDeviceStore())
    await pins.pin(RUNTIME_ID, generateKeyPair().publicKey)
    await pins.forget(RUNTIME_ID)
    expect(await pins.get(RUNTIME_ID)).toBeUndefined()
  })

  it('persists devices.json 0600', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-'))
    try {
      const file = openDevicesFile(dir)
      file.update(() => ({ devices: [{ publicKey: 'ab'.repeat(32), name: 'n', admittedBy: 'pairing', addedAt: 1, lastSeen: 1 }] }))
      await file.flushDurable()
      file.dispose()
      // Windows has no POSIX file modes.
      if (process.platform !== 'win32') expect((await fs.stat(path.join(dir, 'devices.json'))).mode & 0o777).toBe(0o600)
      const reopened = openDevicesFile(dir)
      expect(reopened.get().devices).toHaveLength(1)
      reopened.dispose()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
