// =============================================================================
// CompanionManager — registry + connection lifecycle. LOCAL and remote hosts
// come online through the SAME path: `connect(id, transport, opts)` registers a
// DeferredCompanion synchronously (so resolve() works and the window paints
// before the daemon is online) and drives a CompanionTransport: bootstrap →
// launch → handshake → version-check → wrap in a RemoteCompanion. The LOCAL
// workspace is just `connect(LOCAL, localTransport, { install: true })`, kicked
// off at startup by `ensureLocalCompanion`. The only things that differ between
// local and remote are the `install` flag (local self-installs) and the
// auto-reconnect on a LOCAL drop — both expressed inside this one pipeline.
// `resolve` of an unknown id throws, which surfaces as a normal IPC error.
// =============================================================================

import log from '../logger'
import { LOCAL_COMPANION_ID, parseLocator, type CompanionId } from './locator'
import type { Companion } from './types'
import { CompanionRpcClient } from './rpcClient'
import { RemoteCompanion } from './RemoteCompanion'
import { DeferredCompanion } from './DeferredCompanion'
import { LocalSubprocessTransport } from './transports/localTransport'
import type { CompanionTransport, CompanionChannel } from './transports/transport'
import { COMPANION_VERSION } from '../../companion/version'
import { COMPANION_PROTOCOL_VERSION } from '../../companion/protocol'
import type { CompanionPhase } from '../../shared/types'

interface Connection {
  transport: CompanionTransport
  channel: CompanionChannel
  client: CompanionRpcClient
  companion: RemoteCompanion
}

export class CompanionManager {
  private readonly companions = new Map<CompanionId, Companion>()
  private readonly connections = new Map<CompanionId, Connection>()
  /** Dedupe concurrent connects to the same id (mirrors AgentManager.withLock). */
  private readonly connecting = new Map<CompanionId, Promise<Companion>>()
  private statusListener: ((id: CompanionId, state: CompanionPhase, message?: string) => void) | null = null
  /** The opts the LOCAL daemon was launched with, kept so a crash can be
   *  re-provisioned + relaunched identically. Set by ensureLocalCompanion. */
  private localOpts: { root: string; exclusions?: string[]; env?: NodeJS.ProcessEnv; idleSuspend?: boolean } | null = null
  /** Pending LOCAL auto-reconnect timer — guards against stacking reconnects on
   *  a crash loop (one backoff in flight at a time). */
  private localReconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** Last status emitted for the LOCAL companion, so a window that subscribes to
   *  COMPANION_STATUS after the startup connect already finished can still seed
   *  its loading blocker. Defaults to `connecting` — ensureLocalCompanion runs at
   *  every app launch, so LOCAL is always coming up until proven otherwise. */
  private lastLocalStatus: { phase: CompanionPhase; message?: string } = { phase: 'connecting' }

  constructor() {
    // The LOCAL workspace runs as the companion daemon subprocess. It's NOT
    // registered here — `ensureLocalCompanion` (called once at startup) provisions
    // and connects it, so resolve() works only once the daemon is online.
  }

  /**
   * Bring the local workspace online by handing a local-host transport to the same
   * `connect()` every remote host uses, with `install: true` so the bundled tarball
   * self-extracts on first run. Call once at startup before the first local op.
   *
   * connect() registers a DeferredCompanion SYNCHRONOUSLY (so resolve(LOCAL) and
   * the window paint don't wait for the ~10s first-run tarball extraction) and
   * connects the daemon in the BACKGROUND. Early IPC ops queue behind the
   * deferred's `ready`, which resolves to the real RemoteCompanion once connected.
   *
   * This runs at app launch, so it must NEVER throw (that would break the launch);
   * the connect runs fire-and-forget. If no local tarball/target is available, it
   * logs + emits `unreachable` and connects nothing. If the background connect
   * fails, connect() drops the deferred and this emits `unreachable`, so every
   * local op fails with a clear error until fixed.
   */
  ensureLocalCompanion(opts: { root: string; exclusions?: string[]; env?: NodeJS.ProcessEnv; idleSuspend?: boolean }): void {
    // Remember the launch opts so a crash can re-provision + relaunch identically
    // (see the LOCAL auto-reconnect in doConnect's onClose handler).
    this.localOpts = opts
    // LOCAL comes online through the SAME public connect() as every remote/WSL
    // host — connect() registers a DeferredCompanion synchronously (so resolve(
    // LOCAL) and first paint don't wait for the daemon) and dedupes concurrent /
    // in-flight connects. So a live or in-flight LOCAL needs nothing here; the
    // auto-reconnect path deletes the entry before calling, so a present
    // non-deferred entry means LOCAL is already live.
    if (this.connecting.has(LOCAL_COMPANION_ID)) return
    const existing = this.companions.get(LOCAL_COMPANION_ID)
    if (existing && !(existing instanceof DeferredCompanion)) return
    const hint = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV
      ? ' In dev, build it first: `npm run companion:tarball`.'
      : ''
    const transport = LocalSubprocessTransport.forLocalHost({
      root: opts.root,
      id: LOCAL_COMPANION_ID,
      exclusions: opts.exclusions,
      env: opts.env,
      idleSuspend: opts.idleSuspend,
    })
    if (!transport) {
      const msg = `No local companion tarball/target available for this platform.${hint}`
      log.error('[companion] %s', msg)
      this.emitStatus(LOCAL_COMPANION_ID, 'unreachable', msg)
      return
    }

    // install:true — the local daemon self-installs (extracts the bundled tarball)
    // on first run; a remote host installs only on an explicit user action. That
    // flag is the ONLY thing distinguishing this from a remote connect. Fire-and-
    // forget: connect() already registered the deferred synchronously (so the
    // window paints), so we just log the eventual outcome. connect() drops the
    // deferred on failure, so resolve(LOCAL) then fails clearly until fixed.
    void this.connect(LOCAL_COMPANION_ID, transport, { install: true })
      .then(() => {
        log.info('[companion] local workspace running on the daemon tarball')
      })
      .catch((err) => {
        const detail = err instanceof Error ? err.message : String(err)
        log.error('[companion] local daemon failed to start: %s', detail)
        // doConnect already emitted a step-specific status (unreachable/missing);
        // re-emit unreachable with the local-specific hint for the UI.
        this.emitStatus(LOCAL_COMPANION_ID, 'unreachable', `Local companion failed to start: ${detail}${hint}`)
      })
  }

  /**
   * Re-provision + relaunch the LOCAL daemon after a crash, using the opts it was
   * started with. Backs off briefly to avoid a tight crash loop and never stacks
   * (one pending timer at a time; the `connecting` map dedupes the connect once it
   * fires). Emits `connecting` so the UI reflects the in-flight retry.
   */
  private scheduleLocalReconnect(): void {
    if (this.localReconnectTimer) return // a reconnect is already pending
    if (!this.localOpts) return // never came up; nothing to relaunch
    this.emitStatus(LOCAL_COMPANION_ID, 'connecting', 'Local companion crashed, reconnecting…')
    this.localReconnectTimer = setTimeout(() => {
      this.localReconnectTimer = null
      // ensureLocalCompanion short-circuits if LOCAL is already registered, never
      // throws, and re-emits its own status; localOpts is non-null here.
      void this.ensureLocalCompanion(this.localOpts!)
    }, 1000)
    if (this.localReconnectTimer.unref) this.localReconnectTimer.unref()
  }

  /** Wire a status sink (the IPC layer broadcasts these to the renderer). */
  setStatusListener(fn: (id: CompanionId, state: CompanionPhase, message?: string) => void): void {
    this.statusListener = fn
  }

  private emitStatus(id: CompanionId, state: CompanionPhase, message?: string): void {
    if (id === LOCAL_COMPANION_ID) this.lastLocalStatus = { phase: state, ...(message != null ? { message } : {}) }
    try { this.statusListener?.(id, state, message) } catch { /* listener must not break connect */ }
  }

  /** Last status emitted for the LOCAL companion. Seeds the renderer's startup
   *  loading blocker, since the local connect can finish (or fail) before a
   *  window subscribes to the COMPANION_STATUS broadcast. */
  localStatus(): { phase: CompanionPhase; message?: string } {
    return this.lastLocalStatus
  }

  /** Resolve a companion by id. Throws if it isn't registered/connected. */
  resolve(id: CompanionId): Companion {
    const companion = this.companions.get(id)
    if (!companion) {
      throw new Error(`No companion registered for id "${id}"`)
    }
    return companion
  }

  has(id: CompanionId): boolean {
    return this.companions.has(id)
  }

  /** True only when a companion is FULLY connected (a live RemoteCompanion), not
   *  while a connect is still in flight (a DeferredCompanion is registered but the
   *  daemon isn't online yet). Backed by the connections map, which doConnect
   *  populates only at the final `connected` step. */
  isConnected(id: CompanionId): boolean {
    return this.connections.has(id)
  }

  /** Register (or replace) a companion. The local companion cannot be replaced. */
  register(companion: Companion): void {
    if (companion.id === LOCAL_COMPANION_ID) {
      throw new Error('The local companion is built in and cannot be replaced')
    }
    this.companions.set(companion.id, companion)
  }

  /** Remove a registered companion (no-op for the local companion). */
  unregister(id: CompanionId): void {
    if (id === LOCAL_COMPANION_ID) return
    this.companions.delete(id)
  }

  /**
   * TEST SEAM: register a stand-in LOCAL companion synchronously, without a
   * transport. In production the LOCAL workspace is provisioned by
   * `ensureLocalCompanion` (a daemon subprocess over a transport); unit tests
   * that exercise the fs/git IPC handlers directly use this to register an
   * in-process companion so `resolve(LOCAL_COMPANION_ID)` works. Not used by the
   * app at runtime.
   */
  registerLocalForTest(companion: Companion): void {
    this.companions.set(LOCAL_COMPANION_ID, companion)
  }

  /**
   * Establish (or reuse) a connection to a remote/WSL companion over `transport`.
   * Concurrent calls for the same id share one in-flight connect.
   *
   * `opts.install` controls what happens when the host is reachable but the
   * daemon isn't installed: a plain probe (install=false — reconnect / restore /
   * retry) STOPS at the `missing` phase; only an explicit install (install=true)
   * runs bootstrap. `opts.force` wipes any existing install first (clean
   * reinstall). The phase is driven entirely from here, step by step.
   */
  connect(
    id: CompanionId,
    transport: CompanionTransport,
    opts: { install?: boolean; force?: boolean } = {},
  ): Promise<Companion> {
    // Dedupe an in-flight connect FIRST, so concurrent callers share one attempt
    // AND the DeferredCompanion this connect registers below can't short-circuit
    // its own in-flight connect via the existing-entry check.
    const inFlight = this.connecting.get(id)
    if (inFlight) return inFlight
    // A DeferredCompanion is only ever registered for the duration of an in-flight
    // connect (deduped above), so any entry that ISN'T a deferred is a live
    // connection — reused as-is (reconnect / restore / retry).
    const existing = this.companions.get(id)
    if (existing && !(existing instanceof DeferredCompanion)) return Promise.resolve(existing)

    // Register a DeferredCompanion SYNCHRONOUSLY so resolve(id) works (and the
    // window can paint) the instant connect() is called — identically for LOCAL
    // and remote. Early ops queue behind `ready`, which settles with the connect
    // outcome below. The returned promise still resolves to the REAL companion
    // (or rejects), so awaiting callers get connect-completion semantics.
    let resolveReady!: (c: Companion) => void
    let rejectReady!: (err: unknown) => void
    const ready = new Promise<Companion>((res, rej) => { resolveReady = res; rejectReady = rej })
    // A bare `ready` must not emit an unhandled-rejection warning when no op was
    // queued before a failed connect (queued ops see the rejection themselves).
    ready.catch(() => {})
    this.companions.set(id, new DeferredCompanion(id, ready))

    const promise = this.doConnect(id, transport, opts)
      .then((real) => {
        // doConnect already replaced the deferred with the real companion.
        resolveReady(real)
        return real
      })
      .catch((err) => {
        // doConnect failed before registering the real companion, so the deferred
        // is still the registered entry. Drop it (guarding identity against a
        // concurrent replace) so resolve(id) fails clearly and a later connect
        // isn't short-circuited by a stale deferred.
        const cur = this.companions.get(id)
        if (cur instanceof DeferredCompanion) this.companions.delete(id)
        rejectReady(err)
        throw err
      })
      .finally(() => {
        this.connecting.delete(id)
      })
    this.connecting.set(id, promise)
    return promise
  }

  /** Raised when a probe (install=false) finds the host reachable but the daemon
   *  not installed. Carries the `missing` phase; the IPC layer treats it as a
   *  non-error outcome (the user installs explicitly). */
  static readonly NotInstalled = class extends Error {
    constructor() { super('Companion is not installed on the host') }
  }

  /** launch → attach reader → await hello. Caller checks versions. Captures
   *  daemon stderr and a pre-handshake exit so failures carry a real reason
   *  (not just a 10s timeout). The install-state probe and bootstrap run
   *  separately in doConnect so each step maps to its own phase. */
  private async launchAndHandshake(
    transport: CompanionTransport,
  ): Promise<{ channel: CompanionChannel; client: CompanionRpcClient; hello: Awaited<CompanionRpcClient['ready']> }> {
    const channel = await transport.launch()
    const client = new CompanionRpcClient((line) => channel.write(line))
    channel.onData((chunk) => client.handleChunk(chunk))

    let stderr = ''
    channel.onStderr?.((chunk) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
      if (stderr.length > 8192) stderr = stderr.slice(-8192)
    })
    // If the daemon dies before the handshake (node missing, node-pty missing,
    // crash), reject immediately instead of waiting out the hello timeout.
    channel.onClose(({ code }) => client.dispose(`companion process exited (code ${code ?? 'unknown'})`))

    try {
      const hello = await client.ready
      return { channel, client, hello }
    } catch (err) {
      const base = err instanceof Error ? err.message : String(err)
      const detail = stderr.trim() ? `. Daemon output: ${stderr.trim().slice(-600)}` : ''
      throw new Error(`${base}${detail}`)
    }
  }

  /**
   * The probe pipeline. Each step maps a failure to a canonical phase, so the
   * renderer never has to guess which state we're in — the first failing step
   * IS the state:
   *   1. reach host + check install   → fail = `unreachable`
   *   2. not installed                → `missing` (probe), or install when asked
   *   3. launch + handshake           → fail = `unreachable`
   *   4. protocol/version sane        → mismatch = `missing` (reinstall needed)
   *   5. all pass                     → `connected`
   */
  private async doConnect(
    id: CompanionId,
    transport: CompanionTransport,
    { install = false, force = false }: { install?: boolean; force?: boolean },
  ): Promise<Companion> {
    // Step 1: reach the host and probe whether the daemon is installed. A
    // transport without isInstalled (local subprocess / in-proc fakes) is
    // treated as always-installed.
    this.emitStatus(id, 'connecting')
    let installed: boolean
    try {
      installed = transport.isInstalled ? await transport.isInstalled(COMPANION_VERSION) : true
    } catch (err) {
      await transport.dispose().catch(() => {})
      this.emitStatus(id, 'unreachable', err instanceof Error ? err.message : String(err))
      throw err
    }

    // Step 2: install only when explicitly asked. A plain probe stops at
    // `missing` — the user installs from there (delete → missing → Install).
    if (force || !installed) {
      if (!install) {
        await transport.dispose().catch(() => {})
        this.emitStatus(id, 'missing', 'The companion daemon is not installed on the host.')
        throw new CompanionManager.NotInstalled()
      }
      this.emitStatus(id, 'installing')
      try {
        await transport.bootstrap(COMPANION_VERSION, force)
      } catch (err) {
        await transport.dispose().catch(() => {})
        this.emitStatus(id, 'missing', err instanceof Error ? err.message : String(err))
        throw err
      }
      this.emitStatus(id, 'connecting') // installing → back to connecting for launch
    }

    // Step 3: launch + handshake. (Still 'connecting' from step 1 when we didn't
    // install, so no redundant re-emit here.)
    let attempt: Awaited<ReturnType<CompanionManager['launchAndHandshake']>>
    try {
      attempt = await this.launchAndHandshake(transport)
    } catch (err) {
      await transport.dispose().catch(() => {})
      this.emitStatus(id, 'unreachable', err instanceof Error ? err.message : String(err))
      throw err
    }

    // Step 4: protocol/version sanity. A mismatch means the installed bundle is
    // wrong — surface `missing` so the user reinstalls (no silent auto-upgrade).
    if (
      attempt.hello.protocolVersion !== COMPANION_PROTOCOL_VERSION ||
      attempt.hello.companionVersion !== COMPANION_VERSION
    ) {
      attempt.client.dispose()
      attempt.channel.kill()
      await transport.dispose().catch(() => {})
      const msg =
        attempt.hello.protocolVersion !== COMPANION_PROTOCOL_VERSION
          ? `Companion protocol mismatch (daemon ${attempt.hello.protocolVersion}, client ${COMPANION_PROTOCOL_VERSION})`
          : `Companion version mismatch (daemon ${attempt.hello.companionVersion}, client ${COMPANION_VERSION})`
      this.emitStatus(id, 'missing', msg)
      throw new Error(msg)
    }

    // Step 5: connected.
    const { channel, client, hello } = attempt
    const companion = new RemoteCompanion(id, client)
    const conn: Connection = { transport, channel, client, companion }
    channel.onClose(({ code }) => {
      client.dispose('Companion connection closed')
      // A *live* drop is the interesting one; an intentional teardown already
      // logged its own reason. Always record the close (with exit/disconnect
      // code) so a reconnect loop is visible in main.log — previously only
      // `connected` was logged, so a flapping connection looked healthy. The
      // `live=` flag tells a reader whether this was the active transport.
      log.info('[companion] disconnected %s (%s) code=%s live=%s', id, transport.kind, code ?? 'unknown', this.connections.get(id) === conn)
      // Only report a *drop* if this is still the live connection. An
      // intentional teardown (disposeConnection during reinstall/remove)
      // removes it first and drives the phase itself — a late close event from
      // the killed channel must not clobber that back to 'disconnected'.
      if (this.connections.get(id) !== conn) return
      this.connections.delete(id)
      this.companions.delete(id)
      // The LOCAL workspace runs as a daemon subprocess. A remote drop is the
      // user's to reconnect, but a LOCAL crash leaves the whole workspace dead
      // (resolve(LOCAL) throws) until app restart — so auto-reconnect it. The
      // intentional-teardown case already returned above (disposeConnection
      // deletes the connection first), so reaching here for LOCAL means a real
      // crash.
      if (id === LOCAL_COMPANION_ID) {
        this.scheduleLocalReconnect()
        return
      }
      this.emitStatus(id, 'disconnected')
    })
    this.companions.set(id, companion)
    this.connections.set(id, conn)
    log.info('[companion] connected %s (%s) node=%s', id, transport.kind, hello.node.version)
    this.emitStatus(id, 'connected')
    return companion
  }

  /** Ids of currently-connected remote/WSL companions. */
  connectedIds(): CompanionId[] {
    return [...this.connections.keys()]
  }

  /** Ids of every registered companion (LOCAL deferred/real + any remote/WSL).
   *  Used to fan window-close grant clears out to every host. */
  registeredIds(): CompanionId[] {
    return [...this.companions.keys()]
  }

  /** Re-assert the `connected` phase for an already-registered companion. Used
   *  by the ensure short-circuit so a renderer that missed the original
   *  broadcast (e.g. a window opened after the connect) still learns it's live —
   *  keeps the phase main-driven instead of having the client assume it. */
  reportConnected(id: CompanionId): void {
    if (this.companions.has(id)) this.emitStatus(id, 'connected')
  }

  /** Emit a phase for an id that has no in-flight connect — used by the IPC layer
   *  when a connect can't even be ATTEMPTED (e.g. the SSH key file is missing or
   *  an unsupported format), so the renderer shows the real reason instead of a
   *  bare "failed to connect". doConnect owns the phase once a connect starts. */
  report(id: CompanionId, phase: CompanionPhase, message?: string): void {
    this.emitStatus(id, phase, message)
  }

  /** Tear down a remote connection and unregister it. */
  async disposeConnection(id: CompanionId): Promise<void> {
    const conn = this.connections.get(id)
    if (!conn) return
    this.connections.delete(id)
    this.companions.delete(id)
    conn.client.dispose('Companion disposed')
    try { conn.channel.kill() } catch { /* ignore */ }
    await conn.transport.dispose().catch(() => {})
  }

  /**
   * Literally delete the companion: stop any running daemon, then remove its
   * install from the host over a fresh transport (rm -rf ~/.cate/companion).
   * Drives the phase to `missing` on success so the next state is the clean
   * "needs install" — the user reinstalls from there. Emits `unreachable` if the
   * host can't be reached to remove it. The transport is disposed either way.
   */
  async deleteInstall(id: CompanionId, transport: CompanionTransport): Promise<void> {
    await this.disposeConnection(id)
    try {
      if (transport.uninstall) await transport.uninstall()
      this.emitStatus(id, 'missing', 'Companion deleted. Click Install to set it up again.')
    } catch (err) {
      this.emitStatus(id, 'unreachable', err instanceof Error ? err.message : String(err))
      throw err
    } finally {
      await transport.dispose().catch(() => {})
    }
  }

  /** Tear down every connection (app quit). Cancels any pending LOCAL reconnect
   *  so a quit during a crash backoff doesn't relaunch the daemon. */
  async disposeAll(): Promise<void> {
    if (this.localReconnectTimer) {
      clearTimeout(this.localReconnectTimer)
      this.localReconnectTimer = null
    }
    await Promise.all([...this.connections.keys()].map((id) => this.disposeConnection(id)))
  }
}

/** Process-wide singleton used by the IPC handlers. */
export const companions = new CompanionManager()

/**
 * Forward a persistent per-window file grant to the companion that OWNS the
 * granted path. The main process keeps its own grant maps (for its own path
 * checks), but the owning companion (the LOCAL daemon, or a remote/WSL one) runs
 * its own authoritative check against its OWN grant map, so a Save-As / restored
 * grant must be mirrored there too. Decodes the locator's host-absolute path and
 * forwards only when the companion is registered. Best-effort: a rejected RPC
 * never breaks the dialog / restore flow. Mirrors workspaceManager.forwardAllowedRoot.
 */
/**
 * Decode a cwd/path-bearing locator and resolve its target companion in one hop.
 * Shared by the fs/git IPC routers (filesystem.ts's `fileCompanionFor`, git.ts's
 * `vcsFor`), which both did the identical parse+resolve before building their
 * host-specific view (`.vcs` vs the whole companion) on top. Returns the resolved
 * companion plus the decoded path and the companion id (needed to re-encode any
 * path handed back to the renderer).
 */
export function resolveLocator(locator: string): { companion: Companion; path: string; companionId: string } {
  const { companionId, path } = parseLocator(locator)
  return { companion: companions.resolve(companionId), path, companionId }
}

export function forwardFileGrant(rawPath: string, ownerWindowId: number): void {
  const { companionId, path } = parseLocator(rawPath)
  if (!path || !companions.has(companionId)) return
  companions.resolve(companionId).grantFileAccess(path, ownerWindowId).catch(() => { /* best-effort */ })
}

/** Forward a one-shot scoped write allowance to the owning companion. See
 *  forwardFileGrant for the rationale; same best-effort, decode-first contract. */
export function forwardScopedWriteAllowance(rawPath: string, ownerWindowId: number): void {
  const { companionId, path } = parseLocator(rawPath)
  if (!path || !companions.has(companionId)) return
  companions.resolve(companionId).registerScopedWriteAllowance(path, ownerWindowId).catch(() => { /* best-effort */ })
}

/**
 * On window close, drop that window's per-window grants on EVERY registered
 * companion — additions are forwarded per-companion (by the path's owner), but a
 * close has only a window id, no locator, so we can't know which companions
 * accumulated grants for it. Forwarding to all is cheap and keeps the daemons
 * from leaking stale per-window grants. Best-effort: a rejected RPC never breaks
 * window teardown. Mirrors pathValidation.clearFileGrantsForWindow.
 */
export function forwardClearFileGrantsForWindow(windowId: number): void {
  forwardToAll((c) => c.clearFileGrantsForWindow(windowId))
}

/** Forward a per-window scoped-write-allowance clear to all companions. See
 *  forwardClearFileGrantsForWindow for the rationale. Mirrors
 *  pathValidation.clearScopedWriteAllowancesForWindow. */
export function forwardClearScopedWriteAllowancesForWindow(windowId: number): void {
  forwardToAll((c) => c.clearScopedWriteAllowancesForWindow(windowId))
}

/** Run a best-effort RPC against every registered companion. A single
 *  companion's rejection is swallowed per-call so it never aborts the others. */
function forwardToAll(fn: (companion: Companion) => Promise<unknown>): void {
  for (const id of companions.registeredIds()) {
    fn(companions.resolve(id)).catch(() => { /* best-effort */ })
  }
}
