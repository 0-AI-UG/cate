// Runtime side of the same-network transport: a WebSocket server on a LAN
// port, advertised over mDNS. It serves private addresses only; any other
// connection is closed before anything is read. Connections go to the
// network peers, which secure them before anything else is read.

import http from 'node:http'
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  isPrivateAddress,
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
  /** Whether to serve a peer at this address. Default: private addresses only. */
  isAllowed?: (remoteAddress: string) => boolean
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
  const addresses = () => (options.addresses ?? lanAddresses)(port)

  server.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    void options.peers.accept(webSocketPort(socket as unknown as WebSocketLike), request.socket.remoteAddress)
  })
  server.on('error', (error) => options.onError?.(error))

  let advertisement: Advertisement | null = null
  // No private address (a cloud VM): nothing on the network could reach it.
  if (options.advertise !== false && addresses().length > 0) {
    try {
      advertisement = advertiseRuntime({ runtimeId: options.runtimeId, port, onError: options.onError })
    } catch (error) {
      options.onError?.(error as Error)
    }
  }

  return {
    port,
    addresses,
    async close() {
      await advertisement?.stop().catch(() => {})
      for (const client of server.clients) client.terminate()
      const httpServer = server.options.server as http.Server
      await new Promise<void>((resolve) => server.close(() => resolve()))
      httpServer.closeAllConnections()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    },
  }
}

function listen(options: SameNetworkOptions, port: number): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const isAllowed = options.isAllowed ?? isPrivateAddress
    const httpServer = http.createServer()
    // Ahead of the HTTP parser, so a refused peer gets nothing read.
    httpServer.prependListener('connection', (socket) => {
      if (!isAllowed(socket.remoteAddress ?? '')) socket.destroy()
    })
    const server = new WebSocketServer({
      server: httpServer,
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
    httpServer.listen(port, options.host)
  })
}
