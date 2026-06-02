// =============================================================================
// CompanionManager — registry + connection lifecycle. The local companion is
// always present. Remote (server / WSL) companions are established via a
// CompanionTransport: bootstrap → launch → handshake → version-check → wrap in
// a RemoteCompanion and register. `resolve` of an unknown id throws, which
// surfaces as a normal IPC error.
// =============================================================================

import log from '../logger'
import { LOCAL_COMPANION_ID, type CompanionId } from './locator'
import type { Companion } from './types'
import { localCompanion } from './LocalCompanion'
import { CompanionRpcClient } from './rpcClient'
import { RemoteCompanion } from './RemoteCompanion'
import type { CompanionTransport, CompanionChannel } from './transports/transport'
import { COMPANION_VERSION } from '../../companion/version'
import { COMPANION_PROTOCOL_VERSION } from '../../companion/protocol'

interface Connection {
  transport: CompanionTransport
  channel: CompanionChannel
  client: CompanionRpcClient
  companion: RemoteCompanion
}

export type CompanionConnState = 'connecting' | 'connected' | 'error' | 'disconnected'

export class CompanionManager {
  private readonly companions = new Map<CompanionId, Companion>()
  private readonly connections = new Map<CompanionId, Connection>()
  /** Dedupe concurrent connects to the same id (mirrors AgentManager.withLock). */
  private readonly connecting = new Map<CompanionId, Promise<Companion>>()
  private statusListener: ((id: CompanionId, state: CompanionConnState, message?: string) => void) | null = null

  constructor() {
    this.companions.set(LOCAL_COMPANION_ID, localCompanion)
  }

  /** Wire a status sink (the IPC layer broadcasts these to the renderer). */
  setStatusListener(fn: (id: CompanionId, state: CompanionConnState, message?: string) => void): void {
    this.statusListener = fn
  }

  private emitStatus(id: CompanionId, state: CompanionConnState, message?: string): void {
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
   * Establish (or reuse) a connection to a remote/WSL companion over `transport`.
   * Concurrent calls for the same id share one in-flight connect.
   */
  connect(id: CompanionId, transport: CompanionTransport): Promise<Companion> {
    if (id === LOCAL_COMPANION_ID) {
      throw new Error('The local companion does not connect over a transport')
    }
    const existing = this.companions.get(id)
    if (existing) return Promise.resolve(existing)

    const inFlight = this.connecting.get(id)
    if (inFlight) return inFlight

    const promise = this.doConnect(id, transport).finally(() => {
      this.connecting.delete(id)
    })
    this.connecting.set(id, promise)
    return promise
  }

  /** bootstrap → launch → attach reader → await hello. Caller checks versions.
   *  Captures daemon stderr and a pre-handshake exit so failures carry a real
   *  reason (not just a 10s timeout). */
  private async launchOnce(
    transport: CompanionTransport,
  ): Promise<{ channel: CompanionChannel; client: CompanionRpcClient; hello: Awaited<CompanionRpcClient['ready']> }> {
    await transport.bootstrap(COMPANION_VERSION)
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

  private async doConnect(id: CompanionId, transport: CompanionTransport): Promise<Companion> {
    this.emitStatus(id, 'connecting')
    let attempt: Awaited<ReturnType<CompanionManager['launchOnce']>>
    try {
      attempt = await this.launchOnce(transport)
    } catch (err) {
      await transport.dispose().catch(() => {})
      this.emitStatus(id, 'error', err instanceof Error ? err.message : String(err))
      throw err
    }

    // Protocol mismatch is wire-incompatible — never self-heals.
    if (attempt.hello.protocolVersion !== COMPANION_PROTOCOL_VERSION) {
      attempt.client.dispose()
      attempt.channel.kill()
      await transport.dispose().catch(() => {})
      const msg = `Companion protocol mismatch (daemon ${attempt.hello.protocolVersion}, client ${COMPANION_PROTOCOL_VERSION})`
      this.emitStatus(id, 'error', msg)
      throw new Error(msg)
    }

    // Version mismatch → auto-upgrade: tear down, re-bootstrap (re-pushes the
    // correct-version bundle for ssh/wsl), relaunch once.
    if (attempt.hello.companionVersion !== COMPANION_VERSION) {
      log.info('[companion] %s version %s != %s; re-bootstrapping', id, attempt.hello.companionVersion, COMPANION_VERSION)
      attempt.client.dispose('upgrading')
      attempt.channel.kill()
      try {
        attempt = await this.launchOnce(transport)
      } catch (err) {
        await transport.dispose().catch(() => {})
        this.emitStatus(id, 'error', err instanceof Error ? err.message : String(err))
        throw err
      }
      if (attempt.hello.companionVersion !== COMPANION_VERSION) {
        attempt.client.dispose()
        attempt.channel.kill()
        await transport.dispose().catch(() => {})
        const msg = `Companion version mismatch after upgrade (daemon ${attempt.hello.companionVersion}, client ${COMPANION_VERSION})`
        this.emitStatus(id, 'error', msg)
        throw new Error(msg)
      }
    }

    const { channel, client, hello } = attempt
    channel.onClose(() => {
      client.dispose('Companion connection closed')
      this.connections.delete(id)
      this.companions.delete(id)
      this.emitStatus(id, 'disconnected')
    })
    const companion = new RemoteCompanion(id, client)
    this.companions.set(id, companion)
    this.connections.set(id, { transport, channel, client, companion })
    log.info('[companion] connected %s (%s) node=%s', id, transport.kind, hello.node.version)
    this.emitStatus(id, 'connected')
    return companion
  }

  /** Ids of currently-connected remote/WSL companions. */
  connectedIds(): CompanionId[] {
    return [...this.connections.keys()]
  }

  /**
   * Air-gapped pi fallback: push the pi tarball to a connected remote companion's
   * host over its transport (SFTP for ssh, /mnt copy for wsl). Called by the
   * agent layer when the daemon's own `agent.ensurePi` fails to download pi.
   * After this resolves the caller re-invokes `agent.ensurePi` to extract it.
   * Returns false if there's no connection or the transport can't push (local).
   */
  async pushPi(id: CompanionId, appVersion: string, piVersion: string): Promise<boolean> {
    const conn = this.connections.get(id)
    if (!conn || !conn.transport.pushPi) return false
    await conn.transport.pushPi(appVersion, piVersion)
    return true
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

  /** Tear down every remote connection (app quit). */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disposeConnection(id)))
  }
}

/** Process-wide singleton used by the IPC handlers. */
export const companions = new CompanionManager()
