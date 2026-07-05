// =============================================================================
// Tunnel-backed Duplex — wraps a Runtime.tunnel raw-TCP connection (3A) in a
// Node stream.Duplex so the standard `http` client / raw socket piping can run
// over it transparently. Bytes go out as base64 via tunnel.write and decoded
// bytes from the tunnel's onData callback are pushed into the readable side.
//
// This is the ONLY way to reach a server-backed extension's loopback port: the
// port is bound on the daemon host (local OR remote, no isLocal branch), and the
// tunnel bridges its TCP bytes over the runtime pipe. Wrapping it as a Duplex
// lets us hand it to `http.request({ createConnection })` and to clientSocket
// pipes (WebSocket upgrade) without either side knowing about the tunnel.
//
// Backpressure on the OUTBOUND (write) side is best-effort: tunnel.write is
// fire-and-forget over the runtime RPC. The INBOUND (daemon→client) side — where
// big payloads flow — has a credit window: after we hand decoded bytes to their
// destination (push into the Duplex), we ack the decoded byte count so the daemon
// can resume a socket it paused. See tunnel.ts (WINDOW_HIGH / WINDOW_LOW).
// =============================================================================

import { Duplex } from 'stream'
import { randomUUID } from 'crypto'
import log from '../logger'
import type { Runtime } from '../runtime/types'

/**
 * Open a tunnel to `127.0.0.1:port` on the runtime's host and return a Duplex
 * bridging it. Resolves once the tunnel is open; writes/reads then flow over it.
 */
export async function openTunnelDuplex(runtime: Runtime, port: number): Promise<Duplex> {
  const connId = `exttun_${randomUUID()}`
  let closed = false

  const duplex = new Duplex({
    write(chunk: Buffer | string, _enc, cb): void {
      try {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        runtime.tunnel.write(connId, buf.toString('base64'))
        cb()
      } catch (err) {
        cb(err instanceof Error ? err : new Error(String(err)))
      }
    },
    // Readable side is driven by the tunnel's onData callback (push-based);
    // nothing to pull on demand.
    read(): void {},
    final(cb): void {
      if (!closed) {
        closed = true
        try { runtime.tunnel.close(connId) } catch { /* already gone */ }
      }
      cb()
    },
    destroy(err, cb): void {
      if (!closed) {
        closed = true
        try { runtime.tunnel.close(connId) } catch { /* already gone */ }
      }
      cb(err)
    },
  })

  const onData = (id: string, chunkB64: string): void => {
    if (id !== connId) return
    try {
      const buf = Buffer.from(chunkB64, 'base64')
      duplex.push(buf)
      // Credit the daemon for the decoded bytes we just delivered, so it can
      // resume the source socket if its outstanding window had paused it. Acked
      // on push (not on drain) — simple and correct; the daemon's window still
      // bounds total buffering even if the Duplex reader briefly lags.
      runtime.tunnel.ack(connId, buf.length)
    } catch (err) {
      log.warn('[extensions] tunnel push failed conn=%s: %O', connId, err)
    }
  }
  const onClose = (id: string): void => {
    if (id !== connId) return
    if (!closed) {
      closed = true
      // Signal EOF to the readable side; the writable side ends naturally.
      try { duplex.push(null) } catch { /* already ended */ }
    }
  }

  await runtime.tunnel.open(connId, port, onData, onClose)
  return duplex
}

/**
 * Reverse variant: a Duplex for an ALREADY-ACCEPTED reverse-tunnel connection
 * (the daemon's CATE_API listener accepted an inbound socket from the extension
 * server). There is no `tunnel.open` — the connection already exists. Outbound
 * bytes go via tunnel.write(connId); the caller pushes inbound bytes in (from the
 * listener's onData); destroy/_final close the connId.
 */
export function reverseDuplex(runtime: Runtime, connId: string): Duplex {
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    try { runtime.tunnel.close(connId) } catch { /* already gone */ }
  }
  return new Duplex({
    write(chunk: Buffer | string, _enc, cb): void {
      try {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        runtime.tunnel.write(connId, buf.toString('base64'))
        cb()
      } catch (err) {
        cb(err instanceof Error ? err : new Error(String(err)))
      }
    },
    // Readable side is push-driven by the caller (listener onData → duplex.push).
    read(): void {},
    final(cb): void { close(); cb() },
    destroy(err, cb): void { close(); cb(err) },
  })
}
