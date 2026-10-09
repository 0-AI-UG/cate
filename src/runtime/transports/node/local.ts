// The local transport over a Node socket: the Unix socket in the workspace
// data dir, or the named pipe on Windows (architecture 7.5). Shared by the
// daemon, the desktop shell and the CLI.

import net from 'node:net'
import type { ByteDuplex } from '@kernel/rpc/contract'

/** Adapts a connected socket to the byte pipe `framePortOver(..., 'stream')` wraps. */
export function socketDuplex(socket: net.Socket): ByteDuplex {
  let reason: string | undefined
  socket.on('error', (err) => { reason = err.message })
  return {
    write: (bytes) => { if (!socket.destroyed) socket.write(bytes) },
    onData: (listener) => {
      socket.on('data', (chunk: Buffer) => listener(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
    },
    onClose: (listener) => { socket.once('close', () => listener(reason)) },
    close: (why) => {
      if (why && reason === undefined) reason = why
      socket.destroy()
    },
  }
}

export interface DialOptions {
  /** Give up connecting after this long. Default 2 s. */
  timeoutMs?: number
}

/** Connects to a runtime's local endpoint. Rejects when nothing listens there. */
export function dialLocal(endpoint: string, options: DialOptions = {}): Promise<ByteDuplex> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`timed out connecting to ${endpoint}`))
    }, options.timeoutMs ?? 2000)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.removeListener('error', onError)
      resolve(socketDuplex(socket))
    })
    const onError = (err: Error) => {
      clearTimeout(timer)
      socket.destroy()
      reject(err)
    }
    socket.once('error', onError)
  })
}

/** Keeps dialing until the endpoint answers or `budgetMs` runs out (a runtime
 *  that was just started binds its socket a moment later). */
export async function dialLocalRetrying(
  endpoint: string,
  options: { budgetMs: number; intervalMs?: number },
): Promise<ByteDuplex> {
  const deadline = Date.now() + options.budgetMs
  for (;;) {
    try {
      return await dialLocal(endpoint, { timeoutMs: Math.max(100, Math.min(2000, deadline - Date.now())) })
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new Error(`runtime did not answer at ${endpoint} within ${options.budgetMs} ms: ${(err as Error).message}`)
      }
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 100))
    }
  }
}

/** A TCP connection to `port` on this machine's loopback. Without a host it
 *  tries 127.0.0.1, then ::1: a dev server bound to `localhost` listens on
 *  either, as a browser on that machine would find it. */
export function connectLoopback(port: number, host?: string): Promise<net.Socket> {
  const attempt = (address: string) => new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ host: address, port })
    socket.once('connect', () => {
      socket.removeListener('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })
  if (host) return attempt(host)
  return attempt('127.0.0.1').catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ECONNREFUSED' && err.code !== 'EADDRNOTAVAIL') throw err
    return attempt('::1').catch(() => { throw err })
  })
}
