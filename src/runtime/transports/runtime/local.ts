// Runtime side of the local transport: every connection accepted on the bound
// socket is served by the rpc server, length-prefixed frames on the stream.

import type net from 'node:net'
import type { RpcServer } from '@kernel/rpc/runtime'
import { framePortOver } from '@kernel/rpc/contract'
import { FRAME_MODE } from '../contract'
import { socketDuplex } from '../node'

export interface LocalListener {
  /** Starts serving, including connections that arrived since `serveLocal`. */
  open(): void
  /** Stops accepting and drops every open connection. */
  close(): Promise<void>
}

/**
 * Takes over an already-bound server (the socket lock from runtime/data).
 * Call it right after binding: a client can connect as soon as the socket
 * exists, and those connections wait until `open()`, when every capability
 * is registered.
 */
export function serveLocal(server: net.Server, rpc: RpcServer): LocalListener {
  const sockets = new Set<net.Socket>()
  let waiting: net.Socket[] | null = []
  const serve = (socket: net.Socket) => {
    if (!socket.destroyed) rpc.serve(framePortOver(socketDuplex(socket), FRAME_MODE.local))
  }
  const onConnection = (socket: net.Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    if (waiting) waiting.push(socket)
    else serve(socket)
  }
  server.on('connection', onConnection)
  return {
    open() {
      const early = waiting ?? []
      waiting = null
      early.forEach(serve)
    },
    close: () => new Promise<void>((resolve) => {
      server.off('connection', onConnection)
      waiting = null
      for (const socket of sockets) socket.destroy()
      if (!server.listening) return resolve()
      server.close(() => resolve())
    }),
  }
}
