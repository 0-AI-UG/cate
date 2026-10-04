// Test-only stand-ins for the Cate Connect service: a small `ws` server with
// the registry and signaling of `contract/protocol.ts`, and a
// man-in-the-middle variant that terminates WebRTC and Noise on both sides
// with its own keys, the strongest thing a compromised service could do.
// ICE servers default to none: host candidates are enough on one machine.

import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  bytesToHex,
  generateKeyPair,
  openSecureChannel,
  type KeyPair,
  type MessagePortLike,
  type SecureChannel,
} from '../../security/contract'
import {
  answerDataChannel,
  offerDataChannel,
  webSocketPort,
  type IceServer,
  type PeerConnectionFactory,
  type SignalMessage,
  type SignalingPort,
  type WebSocketLike,
} from '../../transports/contract'
import {
  CONNECT_PROLOGUE,
  CONNECT_PROTOCOL,
  decodeClientMessage,
  decodeRuntimeMessage,
  encodeConnectMessage,
  type ConnectPush,
  type ConnectPushResult,
  type ServiceClientMessage,
  type ServiceRuntimeMessage,
} from '../contract'

export interface StandInOptions {
  iceServers?: IceServer[]
  serviceKeys?: KeyPair
  /** Terminate every session here instead of relaying it. */
  mitm?: { keys: KeyPair; createPeer: PeerConnectionFactory }
  /** Forward pushes: each is recorded and answered with this result. */
  push?: () => ConnectPushResult
}

export interface MitmEvent {
  side: 'client' | 'runtime'
  outcome: 'secured' | 'failed'
  error?: string
}

export interface ConnectStandIn {
  /** `ws://127.0.0.1:<port>`, the base URL the runtime and clients take. */
  readonly url: string
  /** runtimeId to hex static key, as bound on first registration. */
  bindings(): Map<string, string>
  online(runtimeId: string): boolean
  /** What the man in the middle managed, per session side. */
  readonly mitmEvents: MitmEvent[]
  /** Pushes runtimes asked to forward, oldest first. */
  readonly pushes: Array<{ runtimeId: string; push: ConnectPush }>
  close(): Promise<void>
}

interface Registration {
  channel: SecureChannel
  send(message: ServiceRuntimeMessage): void
}

interface Session {
  runtimeId: string
  toClient(signal: SignalMessage): void
  toRuntime(signal: SignalMessage): void
  end(): void
}

export async function startConnectStandIn(options: StandInOptions = {}): Promise<ConnectStandIn> {
  const iceServers = options.iceServers ?? []
  const serviceKeys = options.serviceKeys ?? generateKeyPair()
  const bindings = new Map<string, string>()
  const registrations = new Map<string, Registration>()
  const sessions = new Map<string, Session>()
  const mitmEvents: MitmEvent[] = []
  const pushes: Array<{ runtimeId: string; push: ConnectPush }> = []

  const server = await new Promise<WebSocketServer>((resolve) => {
    const wss: WebSocketServer = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => resolve(wss))
  })

  server.on('connection', (socket: WebSocket, request) => {
    const port = webSocketPort(socket as unknown as WebSocketLike)
    if (request.url === '/runtime') void serveRuntime(port)
    else if (request.url === '/client') serveClient(port)
    else port.close()
  })

  async function serveRuntime(port: MessagePortLike): Promise<void> {
    let channel: SecureChannel
    try {
      channel = await openSecureChannel(port, { role: 'responder', staticKeys: serviceKeys, prologue: CONNECT_PROLOGUE })
    } catch {
      return
    }
    const registration: Registration = {
      channel,
      send: (message) => { if (!channel.closed) channel.send(encodeConnectMessage(message)) },
    }
    let runtimeId: string | null = null
    channel.onClose(() => {
      if (runtimeId && registrations.get(runtimeId) === registration) registrations.delete(runtimeId)
    })
    channel.onFrame((frame) => {
      const message = decodeRuntimeMessage(frame)
      if (!message) return
      if (message.t === 'register') {
        if (message.protocol !== CONNECT_PROTOCOL) return refuse('protocol')
        const key = bytesToHex(channel.remoteStatic)
        const bound = bindings.get(message.runtimeId)
        if (bound && bound !== key) return refuse('key-mismatch')
        bindings.set(message.runtimeId, key)
        runtimeId = message.runtimeId
        registrations.get(runtimeId)?.channel.close()
        registrations.set(runtimeId, registration)
        registration.send({ t: 'registered', iceServers, ...(options.push ? { push: true } : {}) })
        return
      }
      if (message.t === 'push') {
        if (!runtimeId || !options.push) return registration.send({ t: 'pushed', id: message.id, result: 'unavailable' })
        pushes.push({ runtimeId, push: message.push })
        return registration.send({ t: 'pushed', id: message.id, result: options.push() })
      }
      const session = sessions.get(message.session)
      if (session && session.runtimeId === runtimeId) session.toClient(message.signal)
    })
    function refuse(reason: 'protocol' | 'key-mismatch'): void {
      registration.send({ t: 'refused', reason })
      channel.close()
    }
  }

  function serveClient(port: MessagePortLike): void {
    const send = (message: ServiceClientMessage) => { try { port.send(encodeConnectMessage(message)) } catch { /* gone */ } }
    const mine = new Set<string>()
    port.onClose(() => {
      for (const id of mine) sessions.get(id)?.end()
    })
    port.onMessage((bytes) => {
      const message = decodeClientMessage(bytes)
      if (!message) return send({ t: 'error', code: 'malformed' })
      if (message.t === 'lookup') {
        return send({ t: 'lookup', runtimeId: message.runtimeId, online: registrations.has(message.runtimeId), iceServers })
      }
      if (message.t === 'signal') {
        const session = mine.has(message.session) ? sessions.get(message.session) : undefined
        if (!session) return send({ t: 'error', code: 'unknown-session' })
        return session.toRuntime(message.signal)
      }
      const registration = registrations.get(message.runtimeId)
      if (!registration) return send({ t: 'error', code: 'offline' })
      const id = randomBytes(12).toString('hex')
      mine.add(id)
      const toClient = (signal: SignalMessage) => send({ t: 'signal', session: id, signal })
      if (options.mitm) {
        sessions.set(id, intercept(id, message.runtimeId, registration, toClient, options.mitm))
      } else {
        sessions.set(id, {
          runtimeId: message.runtimeId,
          toClient,
          toRuntime: (signal) => registration.send({ t: 'signal', session: id, signal }),
          end: () => {
            sessions.delete(id)
            registration.send({ t: 'ended', session: id })
          },
        })
        registration.send({ t: 'incoming', session: id })
      }
      send({ t: 'opened', session: id, iceServers })
    })
  }

  // The man in the middle answers the client's offer itself (its own DTLS
  // fingerprint in the SDP), opens its own session to the real runtime, and
  // tries to run Noise with its own key on both, relaying what it can read.
  function intercept(
    id: string,
    runtimeId: string,
    registration: Registration,
    toClient: (signal: SignalMessage) => void,
    mitm: NonNullable<StandInOptions['mitm']>,
  ): Session {
    const fromClient = relaySignals()
    const fromRuntime = relaySignals()
    const clientSide = answerDataChannel({ createPeer: mitm.createPeer, iceServers, signaling: { send: toClient, onSignal: fromClient.onSignal } })
    const runtimeSession = `${id}-m`
    const runtimeHandler: Session = {
      runtimeId,
      toClient: (signal) => fromRuntime.deliver(signal),
      toRuntime: () => {},
      end: () => sessions.delete(runtimeSession),
    }
    sessions.set(runtimeSession, runtimeHandler)
    registration.send({ t: 'incoming', session: runtimeSession })
    const runtimeSide = offerDataChannel({
      createPeer: mitm.createPeer,
      iceServers,
      signaling: { send: (signal) => registration.send({ t: 'signal', session: runtimeSession, signal }), onSignal: fromRuntime.onSignal },
    })

    void (async () => {
      const [clientPort, runtimePort] = await Promise.all([clientSide, runtimeSide])
      const record = (side: MitmEvent['side'], promise: Promise<SecureChannel>) => promise.then(
        (channel) => { mitmEvents.push({ side, outcome: 'secured' }); return channel },
        (error: Error) => { mitmEvents.push({ side, outcome: 'failed', error: error.message }); return null },
      )
      const [toDevice, toRuntime] = await Promise.all([
        record('client', openSecureChannel(clientPort, { role: 'responder', staticKeys: mitm.keys })),
        record('runtime', openSecureChannel(runtimePort, { role: 'initiator', staticKeys: mitm.keys })),
      ])
      if (!toDevice || !toRuntime) {
        toDevice?.close()
        toRuntime?.close()
        return
      }
      toDevice.onFrame((frame) => { if (!toRuntime.closed) toRuntime.send(frame) })
      toRuntime.onFrame((frame) => { if (!toDevice.closed) toDevice.send(frame) })
      toDevice.onClose(() => toRuntime.close())
      toRuntime.onClose(() => toDevice.close())
    })().catch(() => {})

    return {
      runtimeId,
      toClient,
      toRuntime: (signal) => fromClient.deliver(signal),
      end: () => sessions.delete(id),
    }
  }

  const address = server.address() as AddressInfo
  return {
    url: `ws://127.0.0.1:${address.port}`,
    bindings: () => new Map(bindings),
    online: (runtimeId) => registrations.has(runtimeId),
    mitmEvents,
    pushes,
    close: () => new Promise<void>((resolve) => {
      for (const client of server.clients) client.terminate()
      server.close(() => resolve())
    }),
  }
}

function relaySignals(): { deliver(signal: SignalMessage): void; onSignal: SignalingPort['onSignal'] } {
  const listeners = new Set<(signal: SignalMessage) => void>()
  const held: SignalMessage[] = []
  return {
    deliver(signal) {
      if (listeners.size === 0) held.push(signal)
      else for (const listener of listeners) listener(signal)
    },
    onSignal(listener) {
      listeners.add(listener)
      for (const signal of held.splice(0)) listener(signal)
      return () => listeners.delete(listener)
    },
  }
}
