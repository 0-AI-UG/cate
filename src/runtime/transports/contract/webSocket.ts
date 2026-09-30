// A WebSocket as a message port. The browser `WebSocket` and Node's `ws` both
// fit `WebSocketLike`; the portable client gets its constructor from the shell.

import type { MessagePortLike } from '../../security/contract'
import { createPortCore } from './portCore'

export interface WebSocketLike {
  binaryType: string
  readonly readyState: number
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (event: never) => void): void
}

export type WebSocketFactory = (url: string) => WebSocketLike

const OPEN = 1

type On = (type: string, listener: (event: unknown) => void) => void
const listen = (socket: WebSocketLike): On => socket.addEventListener.bind(socket) as On

/** Adapts an open WebSocket. Binary messages only; a text message closes it. */
export function webSocketPort(socket: WebSocketLike): MessagePortLike {
  socket.binaryType = 'arraybuffer'
  const core = createPortCore()
  let failure: Error | undefined
  const on = listen(socket)
  on('message', (event) => {
    const bytes = toBytes((event as { data: unknown }).data)
    if (bytes) return core.deliver(bytes)
    socket.close(1003, 'binary frames only')
    core.finish(new Error('unexpected text message'))
  })
  on('error', (event) => {
    const message = (event as { message?: unknown }).message
    failure = new Error(typeof message === 'string' && message ? message : 'websocket error')
  })
  on('close', () => core.finish(failure))
  return core.port(
    (message) => {
      if (socket.readyState !== OPEN) throw new Error('websocket closed')
      socket.send(message)
    },
    () => {
      try { socket.close(1000) } catch { /* already closing */ }
    },
  )
}

/** Opens a WebSocket and resolves once it is open. */
export function openWebSocket(create: WebSocketFactory, url: string, timeoutMs = 5_000): Promise<MessagePortLike> {
  return new Promise((resolve, reject) => {
    let socket: WebSocketLike
    try {
      socket = create(url)
    } catch (error) {
      reject(error)
      return
    }
    socket.binaryType = 'arraybuffer'
    // Adapt now so nothing sent right after `open` is missed.
    const port = webSocketPort(socket)
    let settled = false
    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!error) return resolve(port)
      port.close()
      reject(error)
    }
    const timer = setTimeout(() => settle(new Error(`timed out connecting to ${url}`)), timeoutMs)
    const on = listen(socket)
    on('open', () => settle())
    on('error', () => settle(new Error(`could not connect to ${url}`)))
    on('close', () => settle(new Error(`${url} closed the connection`)))
  })
}

export function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer || Object.prototype.toString.call(data) === '[object ArrayBuffer]') return new Uint8Array(data as ArrayBuffer)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return null
}
