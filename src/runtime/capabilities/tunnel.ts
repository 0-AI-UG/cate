// =============================================================================
// Tunnel capability — electron-free raw TCP bridge to a server child's loopback
// port. Mirrors the agent.start register-before-start streaming pattern: the
// client registers a stream keyed by connId, calls open(), and the daemon pipes
// the socket's bytes back as base64 `data` evt frames, ending with `close`.
// Outbound bytes (write) are base64-decoded and written to the socket.
//
// Nothing electron is imported here, so the SAME code runs locally and inside
// the standalone daemon.
// =============================================================================

import net from 'net'

// Daemon→client credit window (the direction big payloads flow: assets,
// downloads, server output). We track per-conn bytes sent-but-not-yet-acked and
// pause the source socket once `outstanding` exceeds WINDOW_HIGH, resuming once
// the client's acks bring it back below WINDOW_LOW. This bounds how much a single
// large response can buffer ahead of the slow stdio RPC pipe, so it can't starve
// interactive RPC.
//
// The client→daemon direction (tunnel.write: requests/uploads) relies on Node
// socket backpressure best-effort only — no explicit credit window. That is
// acceptable for v1: those payloads are typically much smaller than responses.
const WINDOW_HIGH = 1 * 1024 * 1024 // pause the socket past 1 MiB outstanding
const WINDOW_LOW = WINDOW_HIGH / 2  // resume once acks drain below 512 KiB

export interface TunnelCapability {
  open(connId: string, port: number, onData: (connId: string, chunkB64: string) => void, onClose: (connId: string) => void): Promise<void>
  write(connId: string, chunkB64: string): void
  /** Credit ack: the client delivered `byteCount` decoded bytes for connId.
   *  Decrements outstanding and resumes the socket if it was paused. */
  ack(connId: string, byteCount: number): void
  close(connId: string): void
  /**
   * Reverse tunnel: bind a 127.0.0.1 listener on this host (port 0 → free port).
   * Each inbound socket is assigned a fresh connId (stored in the SAME socket
   * map so write/close work on it), `onConnection(connId)` fires, then its bytes
   * stream via `onData(connId, b64)` and end via `onClose(connId)`. Returns the
   * bound port. Mirrors `open`'s data plane in reverse.
   */
  listen(
    listenerId: string,
    onConnection: (connId: string) => void,
    onData: (connId: string, chunkB64: string) => void,
    onClose: (connId: string) => void,
  ): Promise<{ port: number }>
  /** Close a listener and destroy its accepted sockets. */
  stopListen(listenerId: string): void
  /** Destroy every live socket + listener synchronously (daemon shutdown). */
  closeAll(): void
}

export function createTunnelCapability(): TunnelCapability {
  const sockets = new Map<string, net.Socket>()
  const listeners = new Map<string, net.Server>()
  // Per-conn bytes sent to the client but not yet acked (the credit window). Lives
  // in its own map (not on the socket) so ack() works regardless of socket source.
  const outstanding = new Map<string, number>()
  let connSeq = 0

  // Wire a freshly-connected/accepted socket's `data` to onData with flow control:
  // count the chunk against the credit window and pause the socket once it exceeds
  // WINDOW_HIGH, so a flood of bytes can't outrun the client's ack rate. Applies
  // uniformly to open() and listen()-accepted sockets (same outstanding map).
  const wireData = (connId: string, socket: net.Socket, onData: (connId: string, chunkB64: string) => void) => {
    socket.on('data', (buf: Buffer) => {
      onData(connId, buf.toString('base64'))
      const next = (outstanding.get(connId) ?? 0) + buf.length
      outstanding.set(connId, next)
      if (next > WINDOW_HIGH) socket.pause()
    })
  }

  return {
    open(connId, port, onData, onClose): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        let opened = false
        const socket = net.connect(port, '127.0.0.1')
        sockets.set(connId, socket)

        socket.on('connect', () => { opened = true; resolve() })
        wireData(connId, socket, onData)
        const end = () => {
          if (sockets.get(connId) === socket) sockets.delete(connId)
          outstanding.delete(connId)
          onClose(connId)
        }
        socket.on('close', end)
        socket.on('error', (err) => {
          // A pre-connect error rejects open(); post-connect it just closes the
          // tunnel (the 'close' that follows fires end()).
          if (!opened) {
            sockets.delete(connId)
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })
      })
    },

    write(connId, chunkB64): void {
      const socket = sockets.get(connId)
      if (!socket) return
      try { socket.write(Buffer.from(chunkB64, 'base64')) } catch { /* socket closed */ }
    },

    ack(connId, byteCount): void {
      const prev = outstanding.get(connId)
      if (prev === undefined) return // already closed
      const next = Math.max(0, prev - byteCount)
      outstanding.set(connId, next)
      const socket = sockets.get(connId)
      // Resume the source once enough credit has freed up (below the low-water
      // mark) — hysteresis (HIGH→pause, LOW→resume) avoids thrashing.
      if (socket && socket.isPaused() && next <= WINDOW_LOW) socket.resume()
    },

    close(connId): void {
      const socket = sockets.get(connId)
      outstanding.delete(connId)
      if (!socket) return
      sockets.delete(connId)
      try { socket.destroy() } catch { /* gone */ }
    },

    listen(listenerId, onConnection, onData, onClose): Promise<{ port: number }> {
      return new Promise<{ port: number }>((resolve, reject) => {
        let bound = false
        const server = net.createServer((socket) => {
          const connId = `${listenerId}-c${++connSeq}`
          sockets.set(connId, socket)
          wireData(connId, socket, onData)
          const end = () => {
            if (sockets.get(connId) === socket) sockets.delete(connId)
            outstanding.delete(connId)
            onClose(connId)
          }
          socket.on('close', end)
          socket.on('error', () => { /* 'close' follows and runs end() */ })
          onConnection(connId)
        })
        listeners.set(listenerId, server)
        server.on('error', (err) => {
          if (!bound) {
            listeners.delete(listenerId)
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })
        server.listen(0, '127.0.0.1', () => {
          bound = true
          const addr = server.address()
          const port = addr && typeof addr === 'object' ? addr.port : 0
          resolve({ port })
        })
      })
    },

    stopListen(listenerId): void {
      const server = listeners.get(listenerId)
      if (!server) return
      listeners.delete(listenerId)
      // Destroy accepted sockets belonging to this listener.
      const prefix = `${listenerId}-c`
      for (const [connId, socket] of sockets) {
        if (connId.startsWith(prefix)) {
          sockets.delete(connId)
          outstanding.delete(connId)
          try { socket.destroy() } catch { /* gone */ }
        }
      }
      try { server.close() } catch { /* gone */ }
    },

    closeAll(): void {
      for (const server of listeners.values()) {
        try { server.close() } catch { /* gone */ }
      }
      listeners.clear()
      for (const socket of sockets.values()) {
        try { socket.destroy() } catch { /* gone */ }
      }
      sockets.clear()
      outstanding.clear()
    },
  }
}
