// The runtime's registration with Cate Connect: one Noise connection to the
// service, kept open and re-established with backoff. Each incoming session
// becomes a WebRTC data channel handed to the network peers, which run Noise
// again inside it with the device's pinned key (architecture 7.6). Each
// session logs whether it went direct or through the relay, and the bytes it
// carried when it ends.

import type { Logger } from '@kernel/log/contract'
import { networkIdOf, openSecureChannel, type KeyPair, type MessagePortLike, type SecureChannel } from '../../security/contract'
import {
  answerDataChannel,
  connectionPath,
  type IceServer,
  openWebSocket,
  type PeerConnectionFactory,
  type PeerConnectionLike,
  type SignalMessage,
  type WebSocketFactory,
} from '../../transports/contract'
import {
  CONNECT_PROLOGUE,
  CONNECT_PROTOCOL,
  connectEndpoint,
  decodeServiceRuntimeMessage,
  encodeConnectMessage,
  type ConnectPush,
  type ConnectPushResult,
  type RegisterRefusal,
  type RuntimeMessage,
} from '../contract'

export type RegistrationState =
  | { kind: 'connecting' }
  | { kind: 'registered' }
  | { kind: 'refused'; reason: RegisterRefusal }
  | { kind: 'closed' }

export interface ConnectRegistrationOptions {
  url: string
  /** Registers under the key's network id. */
  runtimeKeys: KeyPair
  webSocket: WebSocketFactory
  /** Loaded lazily: the WebRTC stack is only needed once someone connects. */
  peerConnection: () => Promise<PeerConnectionFactory>
  /** A data channel from a client, not yet secured. */
  onConnection: (port: MessagePortLike) => void
  log?: Logger
  retry?: { minMs?: number; maxMs?: number }
  sessionTimeoutMs?: number
  /** How long a push waits for the service's answer. Default 15 s. */
  pushTimeoutMs?: number
}

export interface ConnectRegistration {
  state(): RegistrationState
  onState(listener: (state: RegistrationState) => void): () => void
  /** Registered with a service that forwards pushes. */
  pushAvailable(): boolean
  /** Asks the service to forward a push; `unavailable` while it cannot. */
  push(push: ConnectPush): Promise<ConnectPushResult>
  close(): void
}

export function startConnectRegistration(options: ConnectRegistrationOptions): ConnectRegistration {
  const minMs = options.retry?.minMs ?? 1_000
  const maxMs = options.retry?.maxMs ?? 60_000
  const listeners = new Set<(state: RegistrationState) => void>()
  let state: RegistrationState = { kind: 'connecting' }
  let channel: SecureChannel | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let delay = minMs
  let stopped = false
  let pushes = false
  let nextPushId = 1
  const pendingPushes = new Map<string, (result: ConnectPushResult) => void>()
  const settlePushes = (result: ConnectPushResult) => {
    for (const settle of [...pendingPushes.values()]) settle(result)
  }
  // Signals for a session; held until its peer connection listens, since the
  // offer can arrive while the WebRTC stack is still loading.
  const sessions = new Map<string, { listener: ((signal: SignalMessage) => void) | null; held: SignalMessage[] }>()

  const setState = (next: RegistrationState) => {
    state = next
    for (const listener of listeners) listener(next)
  }

  const send = (message: RuntimeMessage) => {
    if (channel && !channel.closed) channel.send(encodeConnectMessage(message))
  }

  const scheduleRetry = () => {
    if (stopped || state.kind === 'refused') return
    setState({ kind: 'connecting' })
    retryTimer = setTimeout(() => void connect(), delay)
    delay = Math.min(maxMs, delay * 2)
  }

  const acceptSession = (session: string, iceServers: IceServer[]) => {
    const entry: { listener: ((signal: SignalMessage) => void) | null; held: SignalMessage[] } = { listener: null, held: [] }
    sessions.set(session, entry)
    let peer: PeerConnectionLike | null = null
    void options.peerConnection()
      .then((createPeer) => answerDataChannel({
        createPeer: (config) => (peer = createPeer(config)),
        iceServers,
        timeoutMs: options.sessionTimeoutMs,
        signaling: {
          send: (signal) => send({ t: 'signal', session, signal }),
          onSignal: (listener) => {
            entry.listener = listener
            for (const signal of entry.held.splice(0)) listener(signal)
            return () => { entry.listener = null }
          },
        },
      }))
      .then(
        (port) => options.onConnection(options.log && peer ? logSession(port, peer, session, options.log) : port),
        (error: Error) => options.log?.info('cate connect session %s failed: %s', session, error.message),
      )
      .finally(() => sessions.delete(session))
  }

  const connect = async () => {
    retryTimer = null
    if (stopped) return
    let secure: SecureChannel
    try {
      const port = await openWebSocket(options.webSocket, connectEndpoint(options.url, 'runtime'), 10_000)
      secure = await openSecureChannel(port, {
        role: 'initiator',
        staticKeys: options.runtimeKeys,
        prologue: CONNECT_PROLOGUE,
        handshakeTimeoutMs: 10_000,
      })
    } catch (error) {
      options.log?.info('cate connect unreachable: %s', (error as Error).message)
      scheduleRetry()
      return
    }
    if (stopped) {
      secure.close()
      return
    }
    channel = secure
    secure.onClose(() => {
      if (channel !== secure) return
      channel = null
      pushes = false
      sessions.clear()
      settlePushes('failed')
      scheduleRetry()
    })
    secure.onFrame((frame) => {
      const message = decodeServiceRuntimeMessage(frame)
      if (!message) return
      switch (message.t) {
        case 'registered':
          pushes = message.push === true
          delay = minMs
          setState({ kind: 'registered' })
          return
        case 'refused':
          options.log?.warn('cate connect refused the registration: %s', message.reason)
          setState({ kind: 'refused', reason: message.reason })
          secure.close()
          return
        case 'incoming':
          acceptSession(message.session, message.iceServers)
          return
        case 'signal': {
          const entry = sessions.get(message.session)
          if (entry?.listener) entry.listener(message.signal)
          else entry?.held.push(message.signal)
          return
        }
        case 'ended':
          sessions.delete(message.session)
          return
        case 'pushed':
          pendingPushes.get(message.id)?.(message.result)
          return
      }
    })
    send({ t: 'register', runtimeId: networkIdOf(options.runtimeKeys.publicKey), protocol: CONNECT_PROTOCOL })
  }

  void connect()

  return {
    state: () => state,
    onState(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    pushAvailable: () => pushes && state.kind === 'registered',
    push(push) {
      if (!pushes || state.kind !== 'registered') return Promise.resolve('unavailable')
      const id = String(nextPushId++)
      return new Promise<ConnectPushResult>((resolve) => {
        const timer = setTimeout(() => settle('failed'), options.pushTimeoutMs ?? 15_000)
        const settle = (result: ConnectPushResult) => {
          clearTimeout(timer)
          pendingPushes.delete(id)
          resolve(result)
        }
        pendingPushes.set(id, settle)
        send({ t: 'push', id, push })
      })
    },
    close() {
      stopped = true
      settlePushes('failed')
      if (retryTimer) clearTimeout(retryTimer)
      const open = channel
      channel = null
      open?.close()
      setState({ kind: 'closed' })
    },
  }
}

/** Logs the path a session took and, when it ends, the bytes it carried:
 *  the numbers that size the relay. Counts what the network peer sends and
 *  receives through its one message listener. */
function logSession(port: MessagePortLike, peer: PeerConnectionLike, session: string, log: Logger): MessagePortLike {
  const opened = Date.now()
  let path = 'unknown'
  let sent = 0
  let received = 0
  void connectionPath(peer).then((found) => {
    path = found
    log.info('cate connect session %s: %s', session, path)
  })
  port.onClose(() => {
    log.info('cate connect session %s ended: %s, %d bytes sent, %d received, %ds',
      session, path, sent, received, Math.round((Date.now() - opened) / 1000))
  })
  return {
    send(message) {
      sent += message.byteLength
      port.send(message)
    },
    close: () => port.close(),
    onMessage: (listener) => port.onMessage((message) => {
      received += message.byteLength
      listener(message)
    }),
    onClose: (listener) => port.onClose(listener),
  }
}
