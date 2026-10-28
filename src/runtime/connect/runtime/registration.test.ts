import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { generateKeyPair, openSecureChannel, type SecureChannel } from '../../security/contract'
import { openWebSocket } from '../../transports/contract'
import { encodeConnectMessage } from '../contract'
import { startConnectRegistration, type ConnectRegistration } from './registration'

vi.mock('../../security/contract', async (original) => ({
  ...await original<typeof import('../../security/contract')>(),
  openSecureChannel: vi.fn(),
}))
vi.mock('../../transports/contract', async (original) => ({
  ...await original<typeof import('../../transports/contract')>(),
  openWebSocket: vi.fn(),
}))

let registration: ConnectRegistration

function channel() {
  let closed = false
  const frames = new Set<(frame: Uint8Array) => void>()
  const closes = new Set<(error?: Error) => void>()
  const secure: SecureChannel = {
    get closed() { return closed },
    remoteStatic: new Uint8Array(),
    handshakeHash: new Uint8Array(),
    send: vi.fn(),
    setMaxFrameBytes: vi.fn(),
    onFrame: (fn) => { frames.add(fn); return () => frames.delete(fn) },
    onClose: (fn) => { closes.add(fn); return () => closes.delete(fn) },
    close: vi.fn(() => {
      if (secure.closed) return
      closed = true
      for (const fn of closes) fn()
    }),
  }
  return {
    secure,
    registered: () => {
      for (const fn of frames) fn(encodeConnectMessage({ t: 'registered', iceServers: [], push: true }))
    },
    refuse: () => {
      for (const fn of frames) fn(encodeConnectMessage({ t: 'refused', reason: 'protocol' }))
    },
  }
}

async function start(...channels: SecureChannel[]) {
  vi.mocked(openWebSocket).mockResolvedValue({ send: vi.fn(), close: vi.fn(), onMessage: () => () => {}, onClose: () => () => {} })
  for (const secure of channels) vi.mocked(openSecureChannel).mockResolvedValueOnce(secure)
  registration = startConnectRegistration({
    url: 'wss://connect.test',
    runtimeKeys: generateKeyPair(),
    webSocket: vi.fn(),
    peerConnection: vi.fn(),
    onConnection: vi.fn(),
  })
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
})
afterEach(() => {
  registration?.close()
  vi.useRealTimers()
})

it('closes an unacknowledged registration and registers on a fresh connection', async () => {
  const first = channel()
  const second = channel()
  await start(first.secure, second.secure)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(first.secure.closed).toBe(true)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(openWebSocket).toHaveBeenCalledTimes(2)
  second.registered()
  expect(registration.state()).toEqual({ kind: 'registered' })
  expect(registration.pushAvailable()).toBe(true)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(second.secure.closed).toBe(false)
  expect(openWebSocket).toHaveBeenCalledTimes(2)
})

it('cancels the registration deadline and retries when a registered connection closes', async () => {
  const first = channel()
  const second = channel()
  await start(first.secure, second.secure)
  first.registered()
  first.secure.close()
  expect(registration.pushAvailable()).toBe(false)
  await vi.advanceTimersByTimeAsync(1_000)
  second.registered()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(second.secure.closed).toBe(false)
  expect(openWebSocket).toHaveBeenCalledTimes(2)
})

it('does not retry a refused registration', async () => {
  const first = channel()
  await start(first.secure)
  first.refuse()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(registration.state()).toEqual({ kind: 'refused', reason: 'protocol' })
  expect(openWebSocket).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels the registration deadline when sharing stops', async () => {
  const first = channel()
  await start(first.secure)
  registration.close()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(registration.state()).toEqual({ kind: 'closed' })
  expect(openWebSocket).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('retries if the channel closed before its close listener could attach', async () => {
  const first = channel()
  const second = channel()
  first.secure.close()
  await start(first.secure, second.secure)
  await vi.advanceTimersByTimeAsync(1_000)
  second.registered()
  expect(registration.state()).toEqual({ kind: 'registered' })
  expect(openWebSocket).toHaveBeenCalledTimes(2)
})

it('retries if sending the registration throws', async () => {
  const first = channel()
  const second = channel()
  vi.mocked(first.secure.send).mockImplementation(() => { throw new Error('socket closed') })
  await start(first.secure, second.secure)
  await vi.advanceTimersByTimeAsync(1_000)
  second.registered()
  expect(registration.state()).toEqual({ kind: 'registered' })
  expect(first.secure.closed).toBe(true)
})
