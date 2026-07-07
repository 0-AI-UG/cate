// =============================================================================
// CATE_API reverse endpoint — the server half of Phase 3C. A server-backed
// extension's server process runs on the daemon host and can't reach the client
// directly, so the daemon opens a 127.0.0.1 listener there, injects
// env.CATE_API='http://127.0.0.1:<port>', and tunnels inbound connections BACK
// over the runtime pipe (mirror of 3B's forward tunnel).
//
// This module owns the MAIN-PROCESS side: a non-listening http.Server whose
// request handler validates `Authorization: Bearer <token>` and dispatches the
// `cate.*` method via the shared dispatch core (cateApiHandlers.dispatchCateInvoke).
// `feedConnection(connId)` wraps an already-accepted reverse-tunnel connection in
// a Duplex and feeds it to the http.Server via emit('connection'), so Node parses
// requests off the tunneled socket. The manager pushes inbound bytes into the
// returned duplex.
// =============================================================================

import http from 'http'
import { Duplex } from 'stream'
import log from '../logger'
import type { Runtime } from '../runtime/types'
import { dispatchCateInvoke, forwardToActiveWindow } from './cateApiHandlers'
import { reverseDuplex } from './serverTunnel'

const MAX_BODY_BYTES = 1 * 1024 * 1024

export interface ReverseSession {
  extensionId: string
  workspaceId: string
  token: string
  runtime: Runtime
  /** First-party (terminal/agent) callers skip the extension-enabled gate and
   *  browser consent prompt. Absent for extension-server sessions (the default).
   *  `extensionId` may be a sentinel string for first-party sessions. */
  caller?: 'first-party'
  /** Scopes granted to a first-party caller (used instead of a manifest's
   *  `cateApi`). Absent for extension-server sessions. */
  grantedScopes?: string[]
}

export interface CateApiReverseEndpoint {
  /** Wrap an already-accepted reverse-tunnel connection and feed it to the http
   *  server. Returns the Duplex so the caller can push inbound bytes into it. */
  feedConnection(connId: string): Duplex
  /** Close the http server and destroy all live duplexes. */
  dispose(): void
}

/** Read a request body up to a cap; rejects on overflow. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Create a per-session CATE_API endpoint. The http.Server never binds an OS
 * port — it only parses requests off duplexes fed via feedConnection.
 */
export function createCateApiReverse(session: ReverseSession): CateApiReverseEndpoint {
  const duplexes = new Set<Duplex>()

  const server = http.createServer((req, res) => {
    void handle(req, res)
  })
  // The server only ever receives synthetic connections; swallow its errors so a
  // malformed tunneled request never crashes main.
  server.on('clientError', (_err, socket) => { try { socket.destroy() } catch { /* gone */ } })
  server.on('error', (err) => { log.warn('[ext-cateapi] server error %s: %O', session.extensionId, err) })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      const json = JSON.stringify(body ?? null)
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) })
      res.end(json)
    }
    try {
      // Validate the bearer token (mirrors the proxy's forward injection).
      const auth = req.headers['authorization'] || ''
      if (!session.token || auth !== `Bearer ${session.token}`) {
        send(401, { error: 'unauthorized' })
        return
      }
      const raw = await readBody(req)
      let parsed: { method?: unknown; args?: unknown }
      try { parsed = raw ? JSON.parse(raw) : {} } catch { send(400, { error: 'bad-json' }); return }
      const method = typeof parsed.method === 'string' ? parsed.method : ''
      if (!method) { send(400, { error: 'no-method' }); return }

      const result = await dispatchCateInvoke(
        {
          extensionId: session.extensionId,
          workspaceId: session.workspaceId,
          // No owning panel/sender on the server side: panel-scoped storage and
          // forwarded methods target the workspace best-effort.
          panelId: undefined,
          // State-mutating methods (editor.openFile / canvas.createPanel /
          // panel.setTitle) need a renderer. The server has no sender, so we
          // forward to the active main window (best-effort — there's no
          // authoritative workspace→window map for main windows).
          forward: forwardToActiveWindow,
          // Absent for extension-server sessions (undefined => 'extension'
          // gate + manifest scopes); set for first-party terminal/agent callers.
          caller: session.caller,
          grantedScopes: session.grantedScopes,
        },
        method,
        parsed.args,
      )
      // A void host method resolves `undefined`; coerce to `null` so the wire
      // body keeps a `result` key (JSON.stringify drops undefined values). Without
      // this, `{ result: undefined }` serializes to `{}` and the CLI's unwrap
      // reports a successful void call as 'malformed response'.
      send(200, { result: result ?? null })
    } catch (err) {
      log.warn('[ext-cateapi] invoke failed %s: %O', session.extensionId, err)
      send(500, { error: 'internal' })
    }
  }

  return {
    feedConnection(connId): Duplex {
      const duplex = reverseDuplex(session.runtime, connId)
      duplexes.add(duplex)
      duplex.on('close', () => duplexes.delete(duplex))
      // Hand the socket-like duplex to the http server so it parses requests off it.
      server.emit('connection', duplex)
      return duplex
    },
    dispose(): void {
      for (const d of duplexes) { try { d.destroy() } catch { /* gone */ } }
      duplexes.clear()
      try { server.close() } catch { /* gone */ }
    },
  }
}

export interface ReverseTunnelBinding {
  /** Loopback port bound on the runtime host for inbound connections. */
  port: number
  /** Stop the listener, dispose the endpoint, and drop all inbound duplexes. */
  dispose(): void
}

/**
 * Wire a reverse endpoint to a runtime tunnel listener and start listening.
 * OWNS the per-connId inbound duplex map: an inbound connection is fed to the
 * endpoint (feedConnection), inbound bytes are base64-decoded and pushed into
 * its duplex (crediting the daemon's reverse-tunnel window via tunnel.ack, so a
 * paused accepted socket resumes), and a close pushes EOF.
 *
 * A `listen` failure PROPAGATES — this helper does not catch/log/dispose. The
 * caller owns that policy (ExtensionServerManager is fail-hard; the workspace
 * first-party endpoint is fail-soft), so on throw the caller must dispose the
 * endpoint it created.
 */
export async function bindReverseTunnel(
  runtime: Runtime,
  reverse: CateApiReverseEndpoint,
  listenerId: string,
): Promise<ReverseTunnelBinding> {
  const conns = new Map<string, Duplex>()

  const onConnection = (connId: string): void => {
    conns.set(connId, reverse.feedConnection(connId))
  }
  const onData = (connId: string, b64: string): void => {
    const duplex = conns.get(connId)
    if (!duplex) return
    try {
      const buf = Buffer.from(b64, 'base64')
      duplex.push(buf)
      // Credit the daemon's reverse-tunnel window for the delivered bytes.
      runtime.tunnel.ack(connId, buf.length)
    } catch { /* ended */ }
  }
  const onClose = (connId: string): void => {
    const duplex = conns.get(connId)
    conns.delete(connId)
    if (duplex) { try { duplex.push(null) } catch { /* ended */ } }
  }

  const { port } = await runtime.tunnel.listen(listenerId, onConnection, onData, onClose)

  return {
    port,
    dispose(): void {
      try { runtime.tunnel.stopListen(listenerId) } catch { /* already gone */ }
      try { reverse.dispose() } catch { /* gone */ }
      conns.clear()
    },
  }
}
