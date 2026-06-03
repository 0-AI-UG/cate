// =============================================================================
// CompanionManager — registry + connection lifecycle. The LOCAL workspace runs
// as the companion daemon subprocess, provisioned + connected at startup by
// `ensureLocalCompanion` (so resolve() works only once it's online). Remote
// (server / WSL) companions are established via a CompanionTransport: bootstrap
// → launch → handshake → version-check → wrap in a RemoteCompanion and register.
// `resolve` of an unknown id throws, which surfaces as a normal IPC error.
// =============================================================================

import log from '../logger'
import { LOCAL_COMPANION_ID, parseLocator, type CompanionId } from './locator'
import type { Companion } from './types'
import { CompanionRpcClient } from './rpcClient'
import { RemoteCompanion } from './RemoteCompanion'
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

  constructor() {
    // The LOCAL workspace runs as the companion daemon subprocess. It's NOT
    // registered here — `ensureLocalCompanion` (called once at startup) provisions
    // and connects it, so resolve() works only once the daemon is online.
  }

  /**
   * Bring the local workspace online: provision + launch the host-target companion
   * tarball as a local daemon, exactly like a remote host, and register it under
   * LOCAL_COMPANION_ID. Call once at startup before the first local workspace op.
   *
   * This runs at app launch, so it must NEVER throw (that would break the launch).
   * If no local tarball/target is available, or the connect fails, it logs and
   * emits an `unreachable` status, leaving LOCAL unregistered — every local op
   * then fails with a clear "No companion registered" error until it's fixed.
   */
  async ensureLocalCompanion(opts: { root: string; exclusions?: string[]; env?: NodeJS.ProcessEnv; idleSuspend?: boolean }): Promise<void> {
    if (this.companions.has(LOCAL_COMPANION_ID)) return
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
    try {
      await this.connect(LOCAL_COMPANION_ID, transport, { install: true })
      log.info('[companion] local workspace running on the daemon tarball')
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      log.error('[companion] local daemon failed to start: %s', detail)
      this.emitStatus(LOCAL_COMPANION_ID, 'unreachable', `Local companion failed to start: ${detail}${hint}`)
    }
  }

  /** Wire a status sink (the IPC layer broadcasts these to the renderer). */
  setStatusListener(fn: (id: CompanionId, state: CompanionPhase, message?: string) => void): void {
    this.statusListener = fn
  }

  private emitStatus(id: CompanionId, state: CompanionPhase, message?: string): void {
    try { this.statusListener?.(id, state, message) } catch { /* listener must not break connect */ }
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
    const existing = this.companions.get(id)
    if (existing) return Promise.resolve(existing)

    const inFlight = this.connecting.get(id)
    if (inFlight) return inFlight

    const promise = this.doConnect(id, transport, opts).finally(() => {
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
      const detail = stderr.trim() ? ` — daemon output: ${stderr.trim().slice(-600)}` : ''
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
    channel.onClose(() => {
      client.dispose('Companion connection closed')
      // Only report a *drop* if this is still the live connection. An
      // intentional teardown (disposeConnection during reinstall/remove)
      // removes it first and drives the phase itself — a late close event from
      // the killed channel must not clobber that back to 'disconnected'.
      if (this.connections.get(id) !== conn) return
      this.connections.delete(id)
      this.companions.delete(id)
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

  /** Re-assert the `connected` phase for an already-registered companion. Used
   *  by the ensure short-circuit so a renderer that missed the original
   *  broadcast (e.g. a window opened after the connect) still learns it's live —
   *  keeps the phase main-driven instead of having the client assume it. */
  reportConnected(id: CompanionId): void {
    if (this.companions.has(id)) this.emitStatus(id, 'connected')
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

  /** Tear down every remote connection (app quit). */
  async disposeAll(): Promise<void> {
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
