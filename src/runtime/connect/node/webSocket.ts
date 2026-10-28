import WebSocket from 'ws'
import { NETWORK_MAX_MESSAGE, type WebSocketFactory, type WebSocketLike } from '@runtime/transports/contract'

const HEARTBEAT_MS = 30_000

/** Detect a broken network path even when TCP never reports a close. */
export const connectWebSocketFactory: WebSocketFactory = (url) => {
  const socket = new WebSocket(url, { maxPayload: NETWORK_MAX_MESSAGE })
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let alive = true
  socket.on('pong', () => { alive = true })
  socket.on('open', () => {
    heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate()
        return
      }
      alive = false
      socket.ping()
    }, HEARTBEAT_MS)
    heartbeat.unref()
  })
  socket.on('close', () => clearInterval(heartbeat))
  return socket as unknown as WebSocketLike
}
