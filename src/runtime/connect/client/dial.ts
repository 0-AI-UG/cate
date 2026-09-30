// Client side of Cate Connect: ask the service for the runtime, trade the
// WebRTC offer, answer and candidates through it, and hand back the direct
// data channel. The caller then runs Noise inside it with the pinned key
// (`openSecureConnection` in runtime/transports), so the service cannot read
// or inject anything even if it lies. Portable: WebSocket and peer
// connection come from the shell.

import type { MessagePortLike } from '../../security/contract'
import {
  DataChannelError,
  offerDataChannel,
  openWebSocket,
  type IceServer,
  type PeerConnectionFactory,
  type SignalMessage,
  type WebSocketFactory,
} from '../../transports/contract'
import {
  CateConnectError,
  connectEndpoint,
  decodeServiceClientMessage,
  DIRECT_CONNECTION_FAILED,
  encodeConnectMessage,
  type ClientMessage,
  type ServiceClientMessage,
} from '../contract'

export interface CateConnectOptions {
  url: string
  runtimeId: string
  webSocket: WebSocketFactory
  createPeer: PeerConnectionFactory
  timeoutMs?: number
}

interface ServiceLink {
  send(message: ClientMessage): void
  next<T extends ServiceClientMessage['t']>(type: T): Promise<Extract<ServiceClientMessage, { t: T }>>
  onMessage(listener: (message: ServiceClientMessage) => void): () => void
  close(): void
}

async function openService(options: CateConnectOptions): Promise<ServiceLink> {
  let port: MessagePortLike
  try {
    port = await openWebSocket(options.webSocket, connectEndpoint(options.url, 'client'), 10_000)
  } catch (error) {
    throw new CateConnectError('unreachable', `Cate Connect is unreachable: ${(error as Error).message}`)
  }
  const listeners = new Set<(message: ServiceClientMessage) => void>()
  port.onMessage((bytes) => {
    const message = decodeServiceClientMessage(bytes)
    if (message) for (const listener of [...listeners]) listener(message)
  })
  let closed = false
  port.onClose(() => { closed = true })
  const link: ServiceLink = {
    send: (message) => port.send(encodeConnectMessage(message)),
    onMessage(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    next(type) {
      return new Promise((resolve, reject) => {
        if (closed) return reject(new CateConnectError('unreachable', 'Cate Connect closed the connection'))
        const off = link.onMessage((message) => {
          if (message.t === 'error') {
            finish()
            reject(message.code === 'offline'
              ? new CateConnectError('offline', 'The workspace is not online')
              : new CateConnectError('protocol', message.message ?? message.code))
          } else if (message.t === type) {
            finish()
            resolve(message as Extract<ServiceClientMessage, { t: typeof type }>)
          }
        })
        const offClose = port.onClose(() => {
          finish()
          reject(new CateConnectError('unreachable', 'Cate Connect closed the connection'))
        })
        const timer = setTimeout(() => {
          finish()
          reject(new CateConnectError('unreachable', 'Cate Connect did not answer'))
        }, 10_000)
        function finish() {
          off()
          offClose()
          clearTimeout(timer)
        }
      })
    },
    close: () => port.close(),
  }
  return link
}

/** Whether the runtime is registered right now, and the ICE servers to use. */
export async function lookupRuntime(options: Omit<CateConnectOptions, 'createPeer'>): Promise<{ online: boolean; iceServers: IceServer[] }> {
  const link = await openService(options as CateConnectOptions)
  try {
    const answer = link.next('lookup')
    link.send({ t: 'lookup', runtimeId: options.runtimeId })
    const { online, iceServers } = await answer
    return { online, iceServers }
  } finally {
    link.close()
  }
}

/** Opens a direct data channel to the runtime through Cate Connect signaling. */
export async function dialCateConnect(options: CateConnectOptions): Promise<MessagePortLike> {
  const link = await openService(options)
  try {
    const opened = link.next('opened')
    link.send({ t: 'open', runtimeId: options.runtimeId })
    const { session, iceServers } = await opened
    const signalListeners = new Set<(signal: SignalMessage) => void>()
    const offMessages = link.onMessage((message) => {
      if (message.t === 'signal' && message.session === session) {
        for (const listener of signalListeners) listener(message.signal)
      }
    })
    try {
      return await offerDataChannel({
        createPeer: options.createPeer,
        iceServers,
        timeoutMs: options.timeoutMs,
        signaling: {
          send: (signal) => link.send({ t: 'signal', session, signal }),
          onSignal: (listener) => {
            signalListeners.add(listener)
            return () => signalListeners.delete(listener)
          },
        },
      })
    } catch (error) {
      if (error instanceof DataChannelError) throw new CateConnectError('direct-failed', DIRECT_CONNECTION_FAILED)
      throw error
    } finally {
      offMessages()
    }
  } finally {
    // Signaling is done either way; the service never carries workspace traffic.
    link.close()
  }
}
