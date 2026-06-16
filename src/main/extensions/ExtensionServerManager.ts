// =============================================================================
// ExtensionServerManager — one long-lived server child per (extension,
// workspace), run THROUGH the runtime (3A). Modeled structurally on
// AgentManager: a keyed Map of sessions, a per-key lock to serialize lifecycle
// transitions, runtime resolution from the workspace locator, and
// disposeForWebContents to tie server lifetime to the owning windows.
//
// A server-backed extension (manifest.server present) ships its own HTTP server.
// We spawn it on whichever host owns the workspace files (local OR remote — the
// daemon allocates a free loopback port THERE and injects it), probe its ready
// path, and only then consider it READY. The proxy reverse-proxies to it over a
// tunnel Duplex (see serverTunnel.ts + proxyServer.ts).
//
// Lifecycle state machine (serialized via withLock(key)):
//   IDLE → SPAWNING → READY ⇄ GRACE → STOPPING → IDLE
//                     READY → CRASHED → (auto-restart) → READY | ERROR
//                     SPAWNING → ERROR (start rejected / early exit)
// A panel "joins" to ensure the server is up and "leaves" on unmount; when the
// last panel leaves we start a grace timer and stop the server on expiry. A
// rejoin within grace cancels the timer (cheap reuse on a quick reopen).
// =============================================================================

import { randomBytes } from 'crypto'
import { type WebContents } from 'electron'
import log from '../logger'
import { parseLocator } from '../runtime/locator'
import { runtimes } from '../runtime/runtimeManager'
import type { Runtime, ServerHandle, ServerStartOptions } from '../runtime/types'
import { extensionManager } from './ExtensionManager'
import { getWorkspaceInfo } from '../workspaceManager'
import { DEFAULT_PORT_ENV, DEFAULT_READY_PATH } from '../../shared/extensions'
import { createCateApiReverse, type CateApiReverseEndpoint } from './cateApiReverse'
import type { Duplex } from 'stream'

type ServerState = 'IDLE' | 'SPAWNING' | 'READY' | 'GRACE' | 'STOPPING' | 'CRASHED' | 'ERROR'

const GRACE_MS = 30_000
const READY_TIMEOUT_MS = 15_000
/** Crash-restart budget: at most this many auto-restarts within the window. */
const MAX_RESTARTS = 2
const RESTART_WINDOW_MS = 60_000
/** Cap the captured stdout/stderr we keep for the error UI (~8KB). */
const OUTPUT_RING_MAX = 8 * 1024

export interface ServerEndpoint {
  runtime: Runtime
  port: number
  token: string
}

interface ServerSession {
  extensionId: string
  workspaceId: string
  runtime: Runtime
  /** Runtime-absolute workspace path (the locator's path part). */
  cwd: string
  /** Per-server bearer token the proxy injects so the webview never holds it. */
  token: string
  handle: ServerHandle | null
  state: ServerState
  panels: Set<string>
  owners: Map<string, WebContents>
  /** Last ~8KB of combined stdout/stderr, for the error UI. */
  outputRing: string
  graceTimer: ReturnType<typeof setTimeout> | null
  /** Timestamps (ms) of recent auto-restarts, for the backoff budget. */
  restartTimes: number[]
  /** Last error message (start failure / crash), surfaced to the panel. */
  lastError: string | null
  /** CATE_API reverse endpoint + its tunnel listener (Phase 3C), live while the
   *  server runs. Torn down on stop/crash. */
  cateApi: CateApiReverseEndpoint | null
  /** Per-connId inbound duplexes for the reverse listener. */
  cateApiConns: Map<string, Duplex>
}

function keyFor(extensionId: string, workspaceId: string): string {
  return `${extensionId} ${workspaceId}`
}

export class ExtensionServerManager {
  private sessions = new Map<string, ServerSession>()
  private locks = new Map<string, Promise<unknown>>()

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.locks.set(key, next.catch(() => undefined))
    return next
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Lazy: ensure the server for (extension, workspace) is READY and return its
   * endpoint. Resolves the runtime + cwd from the workspace locator, builds
   * ServerStartOptions from the manifest, spawns + waits for ready. Throws (with
   * captured output where available) on a spawn / ready failure so the proxy can
   * render the error.
   */
  async ensureServer(extensionId: string, workspaceId: string): Promise<ServerEndpoint> {
    const key = keyFor(extensionId, workspaceId)
    return this.withLock(key, async () => {
      const session = this.getOrCreateSession(extensionId, workspaceId)
      if (session.state === 'READY' && session.handle) {
        return { runtime: session.runtime, port: session.handle.port, token: session.token }
      }
      await this.startServer(session)
      if (!session.handle) {
        throw new Error(session.lastError ?? 'Extension server failed to start')
      }
      return { runtime: session.runtime, port: session.handle.port, token: session.token }
    })
  }

  /** Add a panel to the server's owners and ensure it's running. Cancels any
   *  in-flight grace timer (a rejoin during grace reuses the live server). */
  async joinPanel(
    extensionId: string,
    workspaceId: string,
    panelId: string,
    sender: WebContents,
  ): Promise<ServerEndpoint> {
    const key = keyFor(extensionId, workspaceId)
    // Cancel grace + register the panel under the lock so a concurrent
    // leave-driven grace expiry can't race past us.
    await this.withLock(key, async () => {
      const session = this.getOrCreateSession(extensionId, workspaceId)
      if (session.graceTimer) {
        clearTimeout(session.graceTimer)
        session.graceTimer = null
        if (session.state === 'GRACE') session.state = 'READY'
      }
      session.panels.add(panelId)
      session.owners.set(panelId, sender)
    })
    return this.ensureServer(extensionId, workspaceId)
  }

  /** Remove a panel. When the last panel leaves, start a grace timer; on expiry
   *  stop the server and drop the session. */
  leavePanel(extensionId: string, workspaceId: string, panelId: string): void {
    const key = keyFor(extensionId, workspaceId)
    const session = this.sessions.get(key)
    if (!session) return
    session.panels.delete(panelId)
    session.owners.delete(panelId)
    if (session.panels.size > 0) return
    if (session.graceTimer) clearTimeout(session.graceTimer)
    if (session.state === 'READY') session.state = 'GRACE'
    session.graceTimer = setTimeout(() => {
      void this.withLock(key, async () => {
        const s = this.sessions.get(key)
        // A rejoin during grace would have cancelled this timer + re-added a
        // panel; bail if anything changed.
        if (!s || s.panels.size > 0 || s.graceTimer == null) return
        s.graceTimer = null
        await this.stopServer(s)
        this.sessions.delete(key)
        log.info('[ext-server] grace expired, stopped %s', key)
      })
    }, GRACE_MS)
    if (session.graceTimer.unref) session.graceTimer.unref()
  }

  /** Manual restart from ERROR/CRASHED (resets the crash budget). */
  async restart(extensionId: string, workspaceId: string): Promise<{ ok: boolean; error?: string }> {
    const key = keyFor(extensionId, workspaceId)
    return this.withLock(key, async () => {
      const session = this.sessions.get(key)
      if (!session) return { ok: false, error: 'No server session' }
      session.restartTimes = []
      session.lastError = null
      try {
        await this.stopServer(session)
        await this.startServer(session)
        return session.handle ? { ok: true } : { ok: false, error: session.lastError ?? 'Failed to start' }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
  }

  /** Drop every panel whose owner WebContents has gone away (window closed). */
  disposeForWebContents(wcId: number): void {
    for (const session of this.sessions.values()) {
      for (const [panelId, sender] of session.owners) {
        if (sender.id === wcId) {
          this.leavePanel(session.extensionId, session.workspaceId, panelId)
        }
      }
    }
  }

  /** Stop every server (app quit). The daemon already kills its children on
   *  transport close, so this is best-effort belt-and-suspenders. */
  async disposeAll(): Promise<void> {
    const keys = [...this.sessions.keys()]
    await Promise.all(
      keys.map((key) =>
        this.withLock(key, async () => {
          const session = this.sessions.get(key)
          if (!session) return
          if (session.graceTimer) clearTimeout(session.graceTimer)
          await this.stopServer(session)
          this.sessions.delete(key)
        }),
      ),
    )
  }

  // --- Accessors for the error UI -------------------------------------------

  getOutput(extensionId: string, workspaceId: string): string {
    return this.sessions.get(keyFor(extensionId, workspaceId))?.outputRing ?? ''
  }

  getState(extensionId: string, workspaceId: string): ServerState | null {
    return this.sessions.get(keyFor(extensionId, workspaceId))?.state ?? null
  }

  // ---------------------------------------------------------------------------
  // Internals (always called under withLock(key))
  // ---------------------------------------------------------------------------

  private getOrCreateSession(extensionId: string, workspaceId: string): ServerSession {
    const key = keyFor(extensionId, workspaceId)
    const existing = this.sessions.get(key)
    if (existing) return existing

    // Resolve runtime + cwd from the workspace locator (throws if a remote
    // runtime isn't connected — surfaced as a start error). A workspace with no
    // info / no root falls back to the local runtime with an empty cwd.
    const info = getWorkspaceInfo(workspaceId)
    const { runtimeId, path: cwd } = parseLocator(info?.rootPath ?? '')
    const runtime = runtimes.resolve(runtimeId)

    const session: ServerSession = {
      extensionId,
      workspaceId,
      runtime,
      cwd,
      token: randomBytes(32).toString('base64url'),
      handle: null,
      state: 'IDLE',
      panels: new Set(),
      owners: new Map(),
      outputRing: '',
      graceTimer: null,
      restartTimes: [],
      lastError: null,
      cateApi: null,
      cateApiConns: new Map(),
    }
    this.sessions.set(key, session)
    return session
  }

  /** Build ServerStartOptions from the manifest and spawn the server, blocking
   *  until the ready probe passes. Sets handle + READY, or ERROR + lastError. */
  private async startServer(session: ServerSession): Promise<void> {
    if (session.state === 'READY' && session.handle) return

    const manifest = extensionManager.getManifest(session.extensionId)
    const server = manifest?.server
    if (!manifest || !server) {
      session.state = 'ERROR'
      session.lastError = 'Extension is not server-backed'
      throw new Error(session.lastError)
    }

    // The server process runs from the EXTENSION's own dir (where server.js +
    // assets live), not the workspace root — `command` paths (e.g. "node
    // server.js") are relative to it. The workspace is passed via WORKSPACE_ROOT.
    // NOTE (remote seam): for a remote workspace this dir is the client-side
    // install cache, which the daemon host can't see; remote server-backed
    // extensions need the artifact synced to the host (runtime.file.* — see
    // install.ts). Local works today since the daemon shares the filesystem.
    const extensionDir = extensionManager.getExtensionRootDir(session.extensionId)
    if (!extensionDir) {
      session.state = 'ERROR'
      session.lastError = 'Extension is not installed (no root dir to run the server from)'
      throw new Error(session.lastError)
    }

    const id = `extsrv_${session.extensionId}_${Date.now()}`
    const key = keyFor(session.extensionId, session.workspaceId)
    const listenerId = `cateapi-${key}`

    session.state = 'SPAWNING'
    session.lastError = null

    // --- CATE_API reverse channel (Phase 3C) -------------------------------
    // BEFORE start: stand up the reverse endpoint + open a 127.0.0.1 listener on
    // the daemon host. Inbound connections tunnel BACK over the pipe into the
    // endpoint's http server, which validates CATE_TOKEN and dispatches cate.*.
    const reverse = createCateApiReverse({
      extensionId: session.extensionId,
      workspaceId: session.workspaceId,
      token: session.token,
      runtime: session.runtime,
    })
    session.cateApi = reverse
    session.cateApiConns = new Map()

    const onConnection = (connId: string): void => {
      const duplex = reverse.feedConnection(connId)
      session.cateApiConns.set(connId, duplex)
    }
    const onData = (connId: string, b64: string): void => {
      const duplex = session.cateApiConns.get(connId)
      if (duplex) {
        try {
          const buf = Buffer.from(b64, 'base64')
          duplex.push(buf)
          // Credit the daemon's reverse-tunnel window for the bytes we delivered,
          // so it can resume the accepted socket if it had paused (mirror of the
          // forward path in serverTunnel.openTunnelDuplex).
          session.runtime.tunnel.ack(connId, buf.length)
        } catch { /* ended */ }
      }
    }
    const onClose = (connId: string): void => {
      const duplex = session.cateApiConns.get(connId)
      session.cateApiConns.delete(connId)
      if (duplex) { try { duplex.push(null) } catch { /* ended */ } }
    }

    let cateApiPort: number
    try {
      ;({ port: cateApiPort } = await session.runtime.tunnel.listen(listenerId, onConnection, onData, onClose))
    } catch (err) {
      this.teardownCateApi(session, listenerId)
      session.state = 'ERROR'
      session.lastError = `Failed to open CATE_API listener: ${err instanceof Error ? err.message : String(err)}`
      throw new Error(session.lastError)
    }

    const opts: ServerStartOptions = {
      id,
      // Tokenize the command on whitespace (e.g. "node server.js").
      command: server.command.split(/\s+/).filter(Boolean),
      cwd: extensionDir,
      env: {
        CATE_TOKEN: session.token,
        WORKSPACE_ROOT: session.cwd,
        // Phase 3C: the loopback URL (on the daemon host) the server uses to call
        // back into Cate's reverse API; the listener tunnels it back to main.
        CATE_API: `http://127.0.0.1:${cateApiPort}`,
      },
      portEnv: server.portEnv || DEFAULT_PORT_ENV,
      readyPath: server.readyPath || DEFAULT_READY_PATH,
      readyTimeoutMs: READY_TIMEOUT_MS,
    }

    const onOutput = (_id: string, _stream: 'stdout' | 'stderr', chunk: string): void => {
      session.outputRing = (session.outputRing + chunk).slice(-OUTPUT_RING_MAX)
    }
    const onExit = (_id: string, code: number | null, signal: string | null): void => {
      this.handleExit(session, code, signal)
    }

    try {
      const handle = await session.runtime.server.start(opts, onOutput, onExit)
      session.handle = handle
      session.state = 'READY'
      log.info(
        '[ext-server] READY %s pid=%d port=%d',
        keyFor(session.extensionId, session.workspaceId),
        handle.pid,
        handle.port,
      )
    } catch (err) {
      const base = err instanceof Error ? err.message : String(err)
      const tail = session.outputRing.trim() ? `\n${session.outputRing.trim().slice(-600)}` : ''
      session.handle = null
      this.teardownCateApi(session, listenerId)
      session.state = 'ERROR'
      session.lastError = `${base}${tail}`
      log.warn('[ext-server] start failed %s: %s', keyFor(session.extensionId, session.workspaceId), session.lastError)
      throw new Error(session.lastError)
    }
  }

  /** Stop the reverse CATE_API listener + endpoint for a session (idempotent). */
  private teardownCateApi(session: ServerSession, listenerId?: string): void {
    const id = listenerId ?? `cateapi-${keyFor(session.extensionId, session.workspaceId)}`
    try { session.runtime.tunnel.stopListen(id) } catch { /* already gone */ }
    if (session.cateApi) { try { session.cateApi.dispose() } catch { /* gone */ } }
    session.cateApi = null
    session.cateApiConns.clear()
  }

  /** Stop the running server (if any) and reset to IDLE. */
  private async stopServer(session: ServerSession): Promise<void> {
    const handle = session.handle
    session.handle = null
    if (handle) {
      session.state = 'STOPPING'
      try { session.runtime.server.stop(handle.id) } catch { /* already gone */ }
    }
    this.teardownCateApi(session)
    session.state = 'IDLE'
  }

  /**
   * Handle an unexpected server exit. While READY this is a crash: auto-restart
   * with a budget (MAX_RESTARTS per RESTART_WINDOW_MS) then give up to ERROR.
   * Exits during STOPPING/IDLE are expected and ignored. Runs OUTSIDE the lock
   * (it's a runtime callback), so the restart re-acquires it.
   */
  private handleExit(session: ServerSession, code: number | null, signal: string | null): void {
    if (session.state === 'STOPPING' || session.state === 'IDLE') return
    if (session.state !== 'READY' && session.state !== 'GRACE') return

    const key = keyFor(session.extensionId, session.workspaceId)
    session.handle = null
    // Tear down the (now-orphaned) reverse listener; a restart re-creates it.
    this.teardownCateApi(session)
    session.state = 'CRASHED'
    session.lastError = `Server process exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}).`
    log.warn('[ext-server] CRASHED %s: %s', key, session.lastError)

    // Prune the restart window, then decide.
    const now = Date.now()
    session.restartTimes = session.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS)
    if (session.restartTimes.length >= MAX_RESTARTS) {
      session.state = 'ERROR'
      const tail = session.outputRing.trim() ? `\n${session.outputRing.trim().slice(-600)}` : ''
      session.lastError = `Server crashed repeatedly; giving up.${tail}`
      log.warn('[ext-server] ERROR (restart budget exhausted) %s', key)
      return
    }

    session.restartTimes.push(now)
    void this.withLock(key, async () => {
      const s = this.sessions.get(key)
      // Only restart if the session still exists, still wants to run (has
      // panels), and is still in the crashed state.
      if (!s || s.state !== 'CRASHED' || s.panels.size === 0) return
      try {
        await this.startServer(s)
      } catch {
        // startServer already set ERROR + lastError.
      }
    })
  }
}

export const extensionServerManager = new ExtensionServerManager()
