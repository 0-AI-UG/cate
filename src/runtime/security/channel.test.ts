import { describe, expect, it } from 'vitest'
import {
  bytesEqual,
  createMemoryPortPair,
  fingerprint,
  generateKeyPair,
  MAX_CHUNK,
  openSecureChannel,
  type SecureChannel,
} from './contract'
import { connectToRuntime, PinMismatchError, UnknownRuntimeError } from './client'
import { acceptPeer, UnpairedPeerError } from './runtime'

function nextFrame(channel: SecureChannel): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const off = channel.onFrame((frame) => {
      off()
      resolve(frame)
    })
  })
}

function closedWith(channel: SecureChannel): Promise<Error | undefined> {
  return new Promise((resolve) => channel.onClose(resolve))
}

async function openPair() {
  const [a, b] = createMemoryPortPair()
  const clientKeys = generateKeyPair()
  const runtimeKeys = generateKeyPair()
  const [client, runtime] = await Promise.all([
    openSecureChannel(a, { role: 'initiator', staticKeys: clientKeys }),
    openSecureChannel(b, { role: 'responder', staticKeys: runtimeKeys }),
  ])
  return { a, b, client, runtime, clientKeys, runtimeKeys }
}

describe('secure channel', () => {
  it('handshakes, learns both static keys and exchanges frames', async () => {
    const { client, runtime, clientKeys, runtimeKeys } = await openPair()
    expect(bytesEqual(client.remoteStatic, runtimeKeys.publicKey)).toBe(true)
    expect(bytesEqual(runtime.remoteStatic, clientKeys.publicKey)).toBe(true)
    expect(bytesEqual(client.handshakeHash, runtime.handshakeHash)).toBe(true)

    const got = nextFrame(runtime)
    client.send(new TextEncoder().encode('hello'))
    expect(new TextDecoder().decode(await got)).toBe('hello')
    const back = nextFrame(client)
    runtime.send(new Uint8Array(0))
    expect((await back).length).toBe(0)
  })

  it('queues frames that arrive before a listener', async () => {
    const { client, runtime } = await openPair()
    client.send(Uint8Array.of(1))
    client.send(Uint8Array.of(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const seen: number[] = []
    const off = runtime.onFrame((frame) => {
      seen.push(frame[0])
      off()
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toEqual([1])
    runtime.onFrame((frame) => seen.push(frame[0]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toEqual([1, 2])
  })

  it('closes on a tampered frame', async () => {
    const { a, client, runtime } = await openPair()
    const closed = closedWith(runtime)
    const frames: Uint8Array[] = []
    runtime.onFrame((frame) => frames.push(frame))
    a.intercept = (message) => {
      const copy = message.slice()
      copy[copy.length - 1] ^= 0x80
      return copy
    }
    client.send(Uint8Array.of(1, 2, 3))
    expect((await closed)?.message).toMatch(/decryption failed/)
    expect(frames).toEqual([])
  })

  it('splits frames larger than a Noise message and reassembles them', async () => {
    const { a, client, runtime } = await openPair()
    const big = new Uint8Array(MAX_CHUNK * 3 + 17)
    for (let i = 0; i < big.length; i++) big[i] = i % 251
    const sentBefore = a.sent.length
    const got = nextFrame(runtime)
    client.send(big)
    const frame = await got
    expect(a.sent.length - sentBefore).toBe(4)
    for (const message of a.sent.slice(sentBefore)) expect(message.length).toBeLessThanOrEqual(65535)
    expect(bytesEqual(frame, big)).toBe(true)
  })

  it('rejects a frame over the size limit', async () => {
    const [a, b] = createMemoryPortPair()
    const [client, runtime] = await Promise.all([
      openSecureChannel(a, { role: 'initiator', staticKeys: generateKeyPair() }),
      openSecureChannel(b, { role: 'responder', staticKeys: generateKeyPair(), maxFrameBytes: 1000 }),
    ])
    const closed = closedWith(runtime)
    client.send(new Uint8Array(1001))
    expect((await closed)?.message).toMatch(/too large/)
  })

  it('fails the handshake when the peer closes', async () => {
    const [a, b] = createMemoryPortPair()
    const opening = openSecureChannel(a, { role: 'initiator', staticKeys: generateKeyPair() })
    b.close()
    await expect(opening).rejects.toThrow()
  })
})

describe('peer checks', () => {
  it('client connects when the runtime key matches its pin', async () => {
    const [a, b] = createMemoryPortPair()
    const runtimeKeys = generateKeyPair()
    const deviceKeys = generateKeyPair()
    const pins = { get: async (id: string) => (id === 'r1' ? runtimeKeys.publicKey : undefined) }
    const [client, runtime] = await Promise.all([
      connectToRuntime(a, { deviceKeys, runtimeId: 'r1', pins }),
      acceptPeer(b, {
        runtimeKeys,
        policy: { isPaired: (key) => bytesEqual(key, deviceKeys.publicKey), pairUnknown: async () => false },
      }),
    ])
    expect(fingerprint(client.remoteStatic)).toBe(fingerprint(runtimeKeys.publicKey))
    expect(bytesEqual(runtime.remoteStatic, deviceKeys.publicKey)).toBe(true)
  })

  it('client aborts when the runtime presents another key', async () => {
    const [a, b] = createMemoryPortPair()
    const pinned = generateKeyPair().publicKey
    const impostor = openSecureChannel(b, { role: 'responder', staticKeys: generateKeyPair() })
    await expect(
      connectToRuntime(a, { deviceKeys: generateKeyPair(), runtimeId: 'r1', pins: { get: async () => pinned } }),
    ).rejects.toBeInstanceOf(PinMismatchError)
    const channel = await impostor
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(channel.closed).toBe(true)
  })

  it('client refuses a runtime it never paired with', async () => {
    const [a] = createMemoryPortPair()
    await expect(
      connectToRuntime(a, { deviceKeys: generateKeyPair(), runtimeId: 'r1', pins: { get: async () => undefined } }),
    ).rejects.toBeInstanceOf(UnknownRuntimeError)
    expect(a.closed).toBe(true)
  })

  it('runtime gives an unknown key one pairing attempt, then closes', async () => {
    const [a, b] = createMemoryPortPair()
    let attempts = 0
    const accepting = acceptPeer(b, {
      runtimeKeys: generateKeyPair(),
      policy: {
        isPaired: () => false,
        pairUnknown: async () => {
          attempts++
          return false
        },
      },
    })
    const client = await openSecureChannel(a, { role: 'initiator', staticKeys: generateKeyPair() })
    await expect(accepting).rejects.toBeInstanceOf(UnpairedPeerError)
    expect(attempts).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.closed).toBe(true)
  })

  it('runtime admits an unknown key that pairs', async () => {
    const [a, b] = createMemoryPortPair()
    const accepting = acceptPeer(b, {
      runtimeKeys: generateKeyPair(),
      policy: { isPaired: () => false, pairUnknown: async () => true },
    })
    await openSecureChannel(a, { role: 'initiator', staticKeys: generateKeyPair() })
    await expect(accepting).resolves.toBeTruthy()
  })
})
