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
    return this.withLock(key, () => this.ensureServerLocked(extensionId, workspaceId))
  }

  /** ensureServer's body WITHOUT acquiring the lock — so joinPanel can register a
   *  panel and ensure the server under ONE lock acquisition (no gap for a
   *  disable→stopForExtension to interleave between the two). Always called under
   *  withLock(key). */
  private async ensureServerLocked(extensionId: string, workspaceId: string): Promise<ServerEndpoint> {
    const session = this.getOrCreateSession(extensionId, workspaceId)
    // Reuse a live server — including a straggler that lands during GRACE (the
    // 30s window after the last panel left, where the handle is still up). Without
    // this, a GRACE-window request would fall through to startServer and spawn a
    // SECOND child, overwriting handle/cateApi and orphaning the first process.
    const live = this.reuseLiveServer(session)
    if (live) return live
    await this.startServer(session)
    if (!session.handle) {
      throw new Error(session.lastError ?? 'Extension server failed to start')
    }
    return { runtime: session.runtime, port: session.handle.port, token: session.token }
  }

  /** If the session already holds a live server (READY, or GRACE within the 30s
   *  window), cancel any pending grace timer, transition GRACE→READY, and return
   *  the live endpoint — reusing the server instead of spawning a second one.
   *  Returns null when there is no live handle to reuse (IDLE / SPAWNING /
   *  STOPPING / CRASHED / ERROR). Shared by ensureServerLocked and joinPanel. */
  private reuseLiveServer(session: ServerSession): ServerEndpoint | null {
    if (!session.handle || (session.state !== 'READY' && session.state !== 'GRACE')) {
      return null
    }
    if (session.graceTimer) {
      clearTimeout(session.graceTimer)
      session.graceTimer = null
    }
    session.state = 'READY'
    return { runtime: session.runtime, port: session.handle.port, token: session.token }
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
    // Cancel grace, register the panel, AND ensure the server all under ONE lock
    // acquisition: a disable→stopForExtension (which takes the same lock) can no
    // longer interleave between register and ensure and leave a spawned server for
    // a now-disabled extension.
    return this.withLock(key, async () => {
      const session = this.getOrCreateSession(extensionId, workspaceId)
      session.panels.add(panelId)
      session.owners.set(panelId, sender)
      // ensureServerLocked reuses a live server (cancelling any grace timer +
      // GRACE→READY) or spawns one — no separate grace handling needed here.
      return this.ensureServerLocked(extensionId, workspaceId)
    })
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
      // Snapshot owners before iterating — leavePanel() deletes from the same map.
      for (const [panelId, sender] of [...session.owners]) {
        if (sender.id === wcId) {
          this.leavePanel(session.extensionId, session.workspaceId, panelId)
        }
      }
    }
  }

  /**
   * Shared teardown loop for stopForExtension / disposeForRuntime / disposeAll:
   * select every session matching `predicate`, then per session under the
   * per-key lock cancel any pending grace timer, tear the server down, and drop
   * the session from the map.
   *
   * `opts.stopRpc` selects HOW the server is torn down:
   *  - true  → issue the runtime stop RPC via stopServer() (STOPPING → stop →
   *            teardownCateApi → IDLE). For a live runtime we still own.
   *  - false → the runtime has already DISCONNECTED, so its child processes are
   *            gone with the transport and a stop RPC would only reject. Release
   *            local state only: teardownCateApi (fire-and-forget, safe against a
   *            dead runtime) + drop the stale handle + reset to IDLE.
   *
   * (Grace-timer handling is unified to always clear AND null the timer. The
   * old stopForExtension/disposeAll only cleared it, but they delete the session
   * in the same tick so the un-nulled field was unobservable — nulling matches
   * disposeForRuntime and is strictly more complete.)
   */
  private async disposeSessions(
    predicate: (session: ServerSession, key: string) => boolean,
    opts: { stopRpc: boolean; onDisposed?: (key: string) => void },
  ): Promise<void> {
    const keys = [...this.sessions.entries()]
      .filter(([key, session]) => predicate(session, key))
      .map(([key]) => key)
    await Promise.all(
      keys.map((key) =>
        this.withLock(key, async () => {
          const session = this.sessions.get(key)
          if (!session) return
          if (session.graceTimer) { clearTimeout(session.graceTimer); session.graceTimer = null }
          if (opts.stopRpc) {
            await this.stopServer(session)
          } else {
            // teardownCateApi's tunnel.stopListen is fire-and-forget (swallows
            // its own rejection), so it's safe against a dead runtime — it just
            // frees the main-side reverse endpoint + inbound duplexes.
            this.teardownCateApi(session)
            session.handle = null
            session.state = 'IDLE'
          }
          this.sessions.delete(key)
          opts.onDisposed?.(key)
        }),
      ),
    )
  }

  /**
   * Stop ALL servers for one extension, across every workspace. Sessions are
   * keyed `"${extensionId} ${workspaceId}"`, so we match on the session's
   * `extensionId` field (not the key string). Called when the extension's
   * bytes/enable-state change (disable, uninstall, update, reinstall) so a
   * stale or now-disabled process isn't left running. Takes the per-key lock,
   * clears any grace timer, stops the server (RPC), and drops the session.
   */
  async stopForExtension(extensionId: string): Promise<void> {
    await this.disposeSessions((session) => session.extensionId === extensionId, { stopRpc: true })
  }

  /**
   * Release every session bound to a runtime that has just DISCONNECTED (a live
   * transport drop — crash / network / daemon exit). The daemon and its child
   * server processes are already gone WITH the transport, so there is nothing to
   * stop over RPC — talking to the dead runtime (runtime.server.stop) would only
   * reject. We just release the local state under the per-key lock: cancel the
   * grace timer, tear down the (now-dead) CATE_API reverse endpoint, drop the
   * stale handle, and DELETE the session so the next joinPanel/ensureServer
   * rebuilds it fresh against the reconnected runtime (instead of short-
   * circuiting on the READY+handle guard and handing back a dead port → 502).
   * Sessions are keyed `"${extensionId} ${workspaceId}"`, so we match on the
   * session's `runtime.id`. Same teardown as disposeAll, minus the stop RPC.
   */
  async disposeForRuntime(runtimeId: string): Promise<void> {
    await this.disposeSessions((session) => session.runtime.id === runtimeId, {
      stopRpc: false,
      onDisposed: (key) => log.info('[ext-server] runtime %s disconnected, dropped %s', runtimeId, key),
    })
  }

  /** Stop every server (app quit). The daemon already kills its children on
   *  transport close, so this is best-effort belt-and-suspenders. */
  async disposeAll(): Promise<void> {
    await this.disposeSessions(() => true, { stopRpc: true })
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
    // Defensive: never spawn over a live handle. A caller holding a running
    // server (READY, or a straggler during GRACE) should have reused it via
    // reuseLiveServer; if we still got here with a live handle, reuse it rather
    // than orphaning the process and double-listening the CATE_API listenerId.
    if (session.handle && (session.state === 'READY' || session.state === 'GRACE')) {
      if (session.graceTimer) { clearTimeout(session.graceTimer); session.graceTimer = null }
      session.state = 'READY'
      return
    }

    // Re-check enable state under the lock: a disable() may have landed after this
    // panel joined (its stopForExtension serializes on the same lock). Bail before
    // spawning so a disabled extension is never left with a running server that no
    // leavePanel would ever stop.
    if (!extensionManager.isEnabled(session.extensionId)) {
      session.state = 'IDLE'
      session.lastError = 'Extension is disabled'
      throw new Error(session.lastError)
    }

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
    // ensureProvisioned places the extension's bytes ON this session's runtime
    // host (local OR remote) and returns the host-absolute dir, so the daemon can
    // see them and `cwd` is valid wherever the workspace lives.
    let extensionDir: string
    try {
      extensionDir = await extensionManager.ensureProvisioned(session.extensionId, session.runtime)
    } catch (err) {
      session.state = 'ERROR'
      session.lastError = `Failed to provision extension to host: ${err instanceof Error ? err.message : String(err)}`
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
        // Force the server to bind loopback only (security hygiene: extension
        // servers must never be reachable from the network — the proxy reaches
        // them over a tunnel, not a public socket). HOST is the conventional bind
        // var; servers honoring it stay on 127.0.0.1. See docs/extensions.md.
        HOST: '127.0.0.1',
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
