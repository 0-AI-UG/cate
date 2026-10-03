// Runtime side of the same-network transport: a WebSocket server on a LAN
// port, advertised over mDNS. Connections go to the network peers, which
// secure them before anything else is read.

import { WebSocketServer, type WebSocket } from 'ws'
import {
  NETWORK_MAX_MESSAGE,
  preferredPort,
  sameNetworkPath,
  webSocketPort,
  type WebSocketLike,
} from '../contract'
import { advertiseRuntime, lanAddresses, type Advertisement } from '../node'
import type { NetworkPeers } from './networkPeers'

export interface SameNetworkOptions {
  runtimeId: string
  peers: NetworkPeers
  /** Interface to listen on. Default: all. */
  host?: string
  /** Default: the runtimeId's preferred port, or any free one if it is taken. */
  port?: number
  /** Advertise `_cate._tcp` over mDNS. Default true. */
  advertise?: boolean
  /** The addresses to hand out. Default: this machine's LAN addresses. */
  addresses?: (port: number) => string[]
  onError?: (error: Error) => void
}

export interface SameNetworkListener {
  readonly port: number
  /** `host:port` for the pairing payload and runtime.json. */
  addresses(): string[]
  close(): Promise<void>
}

export async function serveSameNetwork(options: SameNetworkOptions): Promise<SameNetworkListener> {
  const server = await listen(options, options.port ?? preferredPort(options.runtimeId))
    .catch((error: NodeJS.ErrnoException) => {
      if (options.port !== undefined || error.code !== 'EADDRINUSE') throw error
      return listen(options, 0)
    })
  const port = (server.address() as { port: number }).port

  server.on('connection', (socket: WebSocket) => {
    void options.peers.accept(webSocketPort(socket as unknown as WebSocketLike))
  })
  server.on('error', (error) => options.onError?.(error))

  let advertisement: Advertisement | null = null
  if (options.advertise !== false) {
    try {
      advertisement = advertiseRuntime({ runtimeId: options.runtimeId, port, onError: options.onError })
    } catch (error) {
      options.onError?.(error as Error)
    }
  }

  return {
    port,
    addresses: () => (options.addresses ?? lanAddresses)(port),
    async close() {
      await advertisement?.stop().catch(() => {})
      for (const client of server.clients) client.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function listen(options: SameNetworkOptions, port: number): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({
      host: options.host,
      port,
      maxPayload: NETWORK_MAX_MESSAGE,
      perMessageDeflate: false,
      // A stale address that now belongs to another runtime refuses the
      // upgrade, so the client's dial fails instead of winning the race.
      verifyClient: (info: { req: { url?: string } }) => info.req.url === sameNetworkPath(options.runtimeId),
    })
    const onError = (error: Error) => {
      server.close()
      reject(error)
    }
    server.once('error', onError)
    server.once('listening', () => {
      server.off('error', onError)
      resolve(server)
    })
  })
}
