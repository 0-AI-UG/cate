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
      log.warn('[cate-api] tunnel push failed conn=%s: %O', connId, err)
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
