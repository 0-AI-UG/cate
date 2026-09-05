import http from 'http'
import { Duplex } from 'stream'
import log from '../logger'
import type { Runtime } from '../runtime/types'
import { getWindowPanels } from '../windowPanels'
import { getWindow } from '../windowRegistry'
import {
  authorizeCateInvoke,
  dispatchCateInvoke,
  forwardToActiveWindow,
  forwardToOwner,
  type InvokeScope,
} from './cateApiHandlers'
import { reverseDuplex } from './serverTunnel'

const MAX_BODY_BYTES = 1 * 1024 * 1024

export interface ReverseSession {
  workspaceId: string
  token: string
  runtime: Runtime
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
  const panelTargets = new Map<string, string>()

  function panelTargetKey(workspaceId: string, clientId: string): string {
    return `${workspaceId}\0${clientId}`
  }

  const server = http.createServer((req, res) => {
    void handle(req, res)
  })
  // The server only ever receives synthetic connections; swallow its errors so a
  // malformed tunneled request never crashes main.
  server.on('clientError', (_err, socket) => { try { socket.destroy() } catch { /* gone */ } })
  server.on('error', (err) => { log.warn('[cate-api] server error ws=%s: %O', session.workspaceId, err) })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      const json = JSON.stringify(body ?? null)
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) })
      res.end(json)
    }
    try {
      // Authenticate every request with the workspace endpoint token.
      const auth = req.headers['authorization'] || ''
      if (!session.token || auth !== `Bearer ${session.token}`) {
        send(401, { error: 'unauthorized' })
        return
      }
      const raw = await readBody(req)
      let parsed: {
        method?: unknown
        args?: unknown
        clientId?: unknown
        callerPanelId?: unknown
        originCwd?: unknown
      }
      try { parsed = raw ? JSON.parse(raw) : {} } catch { send(400, { error: 'bad-json' }); return }
      const method = typeof parsed.method === 'string' ? parsed.method : ''
      if (!method) { send(400, { error: 'no-method' }); return }
      const clientId = typeof parsed.clientId === 'string' && parsed.clientId
        ? parsed.clientId
        : undefined
      const targetKey = clientId ? panelTargetKey(session.workspaceId, clientId) : undefined
      const args = parsed.args && typeof parsed.args === 'object'
        ? parsed.args as Record<string, unknown>
        : {}
      const callerPanelId = typeof parsed.callerPanelId === 'string'
        ? parsed.callerPanelId
        : undefined
      const callerPanel = callerPanelId
        ? getWindowPanels().find((candidate) =>
            candidate.panelId === callerPanelId &&
            candidate.workspaceId === session.workspaceId &&
            candidate.type === 'terminal',
          )
        : undefined
      const callerWindow = callerPanel ? getWindow(callerPanel.ownerWindowId) : undefined
      const callerWebContents = callerWindow && !callerWindow.isDestroyed()
        ? callerWindow.webContents
        : undefined
      const invokeScope = {
        workspaceId: session.workspaceId,
        panelId: callerPanelId,
        forward: callerWebContents
          ? (payload: Parameters<InvokeScope['forward']>[0]) =>
              forwardToOwner(callerWebContents, payload)
          : forwardToActiveWindow,
        originCwd: typeof parsed.originCwd === 'string'
          ? parsed.originCwd
          : undefined,
      } as const

      if (method.startsWith('cate.panel.target.')) {
        const denied = authorizeCateInvoke(method, args)
        if (denied) {
          send(200, { result: denied })
          return
        }
        if (!clientId) {
          send(200, { result: { error: 'cli-session-unavailable' } })
          return
        }
        if (method === 'cate.panel.target.set') {
          const panelId = typeof args.panelId === 'string' ? args.panelId : ''
          const panel = getWindowPanels().find(
            (candidate) => candidate.panelId === panelId && candidate.workspaceId === session.workspaceId,
          )
          if (!panel) {
            send(200, { result: { error: 'no-such-panel' } })
            return
          }
          panelTargets.set(targetKey!, panel.panelId)
          send(200, { result: { panelId: panel.panelId, type: panel.type } })
          return
        }
        if (method === 'cate.panel.target.current') {
          const panelId = panelTargets.get(targetKey!)
          const panel = panelId
            ? getWindowPanels().find(
                (candidate) => candidate.panelId === panelId && candidate.workspaceId === session.workspaceId,
              )
            : undefined
          if (panelId && !panel) panelTargets.delete(targetKey!)
          send(200, { result: panel ? { panelId: panel.panelId, type: panel.type } : { panelId: null } })
          return
        }
        if (method === 'cate.panel.target.clear') {
          panelTargets.delete(targetKey!)
          send(200, { result: { ok: true } })
          return
        }
      }

      let dispatchArgs: unknown = parsed.args
      let selectedPanelId = targetKey ? panelTargets.get(targetKey) : undefined
      const targetType = method.startsWith('cate.browser.')
        ? 'browser'
        : method.startsWith('cate.terminal.')
          ? 'terminal'
          : method.startsWith('cate.review.')
            ? 'review'
          : undefined
      const usesSelectedPanel = targetType
        && selectedPanelId
        && args.panelId === undefined
        && !(method === 'cate.browser.open' && args.newPanel === true)
      if (usesSelectedPanel) {
        const panel = getWindowPanels().find(
          (candidate) => candidate.panelId === selectedPanelId && candidate.workspaceId === session.workspaceId,
        )
        if (!panel) {
          panelTargets.delete(targetKey!)
          selectedPanelId = undefined
        } else {
          if (panel.type !== targetType) {
            send(200, { result: { error: `selected-panel-is-${panel.type}-not-${targetType}` } })
            return
          }
          dispatchArgs = { ...args, panelId: selectedPanelId }
        }
      }

      const result = await dispatchCateInvoke(invokeScope, method, dispatchArgs)
      // A void host method resolves `undefined`; coerce to `null` so the wire
      // body keeps a `result` key (JSON.stringify drops undefined values). Without
      // this, `{ result: undefined }` serializes to `{}` and the CLI's unwrap
      // reports a successful void call as 'malformed response'.
      send(200, { result: result ?? null })
    } catch (err) {
      log.warn('[cate-api] invoke failed ws=%s: %O', session.workspaceId, err)
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
      panelTargets.clear()
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
