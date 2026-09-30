// The runtime's registration with Cate Connect: one Noise connection to the
// service, kept open and re-established with backoff. Each incoming session
// becomes a WebRTC data channel handed to the network peers, which run Noise
// again inside it with the device's pinned key (architecture 7.6).

import type { Logger } from '@kernel/log/contract'
import { openSecureChannel, type KeyPair, type MessagePortLike, type SecureChannel } from '../../security/contract'
import {
  answerDataChannel,
  type IceServer,
  openWebSocket,
  type PeerConnectionFactory,
  type SignalMessage,
  type WebSocketFactory,
} from '../../transports/contract'
import {
  CONNECT_PROLOGUE,
  CONNECT_PROTOCOL,
  connectEndpoint,
  decodeServiceRuntimeMessage,
  encodeConnectMessage,
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
  runtimeId: string
  runtimeKeys: KeyPair
  webSocket: WebSocketFactory
  /** Loaded lazily: the WebRTC stack is only needed once someone connects. */
  peerConnection: () => Promise<PeerConnectionFactory>
  /** A data channel from a client, not yet secured. */
  onConnection: (port: MessagePortLike) => void
  log?: Logger
  retry?: { minMs?: number; maxMs?: number }
  sessionTimeoutMs?: number
}

export interface ConnectRegistration {
  state(): RegistrationState
  onState(listener: (state: RegistrationState) => void): () => void
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
  let iceServers: IceServer[] = []
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

  const acceptSession = (session: string) => {
    const entry: { listener: ((signal: SignalMessage) => void) | null; held: SignalMessage[] } = { listener: null, held: [] }
    sessions.set(session, entry)
    void options.peerConnection()
      .then((createPeer) => answerDataChannel({
        createPeer,
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
        (port) => options.onConnection(port),
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
      sessions.clear()
      scheduleRetry()
    })
    secure.onFrame((frame) => {
      const message = decodeServiceRuntimeMessage(frame)
      if (!message) return
      switch (message.t) {
        case 'registered':
          iceServers = message.iceServers
          delay = minMs
          setState({ kind: 'registered' })
          return
        case 'refused':
          options.log?.warn('cate connect refused the registration: %s', message.reason)
          setState({ kind: 'refused', reason: message.reason })
          secure.close()
          return
        case 'incoming':
          acceptSession(message.session)
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
      }
    })
    send({ t: 'register', runtimeId: options.runtimeId, protocol: CONNECT_PROTOCOL })
  }

  void connect()

  return {
    state: () => state,
    onState(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      stopped = true
      if (retryTimer) clearTimeout(retryTimer)
      const open = channel
      channel = null
      open?.close()
      setState({ kind: 'closed' })
    },
  }
}
