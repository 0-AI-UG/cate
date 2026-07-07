// =============================================================================
// WorkspaceCateApiManager — a per-workspace CATE_API loopback endpoint for
// FIRST-PARTY callers (interactive terminals + the pi agent), so a `cate` CLI
// run inside them can reach Cate's dispatch core.
//
// This is the terminal/agent sibling of ExtensionServerManager's CATE_API
// reverse channel: it stands up the SAME reverse tunnel via the shared
// createCateApiReverse + bindReverseTunnel helpers, but with no server child to
// spawn and no panel/grace lifecycle — one endpoint per workspace, minted on
// first use and cached. The env vars CATE_API/CATE_TOKEN are injected into terminal/agent
// child processes; a POST to CATE_API with `Authorization: Bearer CATE_TOKEN`
// and body {method,args} dispatches cate.* (see cateApiReverse.ts).
//
// Sessions are first-party (caller:'first-party'): they skip the
// extension-enabled gate and the browser consent prompt, and use GRANTED_SCOPES
// instead of a manifest.
//
// THE GATE: ensureEndpoint() returns null when the `cliEnabled` setting is off.
// A null return means no listener is opened and no env is injected — the CLI is
// unreachable. This is fail-closed: the setting is the only switch.
// =============================================================================

import { randomBytes } from 'crypto'
import log from '../logger'
import { parseLocator } from '../runtime/locator'
import { runtimes } from '../runtime/runtimeManager'
import type { Runtime } from '../runtime/types'
import { getWorkspaceInfo } from '../workspaceManager'
import { getSetting } from '../settingsFile'
import { createCateApiReverse, bindReverseTunnel, type ReverseTunnelBinding } from './cateApiReverse'
import { KeyedLock } from '../keyedLock'

/** Sentinel extensionId for the first-party terminal/agent CATE_API session.
 *  It is NOT a real extension — createCateApiReverse only uses it for logging
 *  when caller==='first-party'. */
const FIRST_PARTY_ID = 'terminal'

/**
 * Scopes granted to a first-party CATE_API caller (interactive terminals + the
 * pi agent). Used INSTEAD of a manifest by createCateApiReverse when
 * caller==='first-party'. MUST include 'browser' (the whole point of the
 * feature). Deliberately EXCLUDES:
 *  - 'storage' — extension-storage is keyed by extensionId; a shared terminal
 *    endpoint has no extension identity, so it would be meaningless/ambiguous.
 *  - 'agent'   — cate.agent.* would let a terminal drive the very agent that may
 *    have spawned it (recursion), which we don't want first-party terminals to do.
 */
export const GRANTED_SCOPES: readonly string[] = [
  'browser',
  'workspace.read',
  'theme',
  'ui',
  'editor',
  'canvas',
  'panel',
]

export interface WorkspaceCateApiEndpoint {
  port: number
  token: string
}

interface WorkspaceSession {
  workspaceId: string
  runtime: Runtime
  /** Per-workspace bearer the child injects on every CATE_API request. */
  token: string
  /** Loopback port bound on the runtime host that the child POSTs to. */
  port: number
  /** Reverse tunnel binding (endpoint + listener + inbound duplexes). */
  binding: ReverseTunnelBinding
}

export class WorkspaceCateApiManager {
  private sessions = new Map<string, WorkspaceSession>()
  /** Serialize per-workspace so two concurrent terminal spawns don't both mint a
   *  listener (double-listen). */
  private locks = new KeyedLock()

  /**
   * Ensure a CATE_API endpoint exists for `workspaceId` and return {port,token}.
   * Returns null when the CLI setting is disabled (the gate — no listener, no
   * env), or when standing up the listener fails (fail-soft: the terminal/agent
   * still spawns, just without CATE_API). Cached per workspace across calls.
   */
  async ensureEndpoint(workspaceId: string): Promise<WorkspaceCateApiEndpoint | null> {
    // THE GATE. Read fresh every call so toggling the setting takes effect on the
    // next spawn with no restart. Fail closed on anything but an explicit true.
    if (getSetting('cliEnabled') !== true) return null
    return this.locks.run(workspaceId, () => this.ensureEndpointLocked(workspaceId))
  }

  private async ensureEndpointLocked(workspaceId: string): Promise<WorkspaceCateApiEndpoint | null> {
    const existing = this.sessions.get(workspaceId)
    if (existing) return { port: existing.port, token: existing.token }

    const info = getWorkspaceInfo(workspaceId)
    const { runtimeId } = parseLocator(info?.rootPath ?? '')

    const token = randomBytes(32).toString('base64url')
    const listenerId = `cateapi-terminal-${workspaceId}`

    // Fail-soft: resolving the runtime (throws when it's unregistered mid
    // disconnect/reconnect) or opening the listener can fail. On either, dispose
    // whatever we stood up and return null so the terminal/agent still spawns,
    // just without CATE_API.
    let runtime: Runtime
    let binding: ReverseTunnelBinding
    let reverse: ReturnType<typeof createCateApiReverse> | undefined
    try {
      // Resolve the runtime from the workspace locator (mirror ExtensionServerManager).
      // No workspace info / no root falls back to the local runtime.
      runtime = runtimes.resolve(runtimeId)
      reverse = createCateApiReverse({
        extensionId: FIRST_PARTY_ID,
        workspaceId,
        token,
        runtime,
        caller: 'first-party',
        grantedScopes: [...GRANTED_SCOPES],
      })
      binding = await bindReverseTunnel(runtime, reverse, listenerId)
    } catch (err) {
      try { reverse?.dispose() } catch { /* gone */ }
      log.warn('[workspace-cateapi] failed to open listener for %s: %O', workspaceId, err)
      return null
    }

    this.sessions.set(workspaceId, { workspaceId, runtime, token, port: binding.port, binding })
    log.info('[workspace-cateapi] endpoint up ws=%s port=%d', workspaceId, binding.port)
    return { port: binding.port, token }
  }

  /** Tear down + drop one workspace's endpoint. */
  disposeForWorkspace(workspaceId: string): void {
    const session = this.sessions.get(workspaceId)
    if (!session) return
    this.teardown(session)
    this.sessions.delete(workspaceId)
  }

  /** Release every endpoint bound to a runtime that just DISCONNECTED (its
   *  listener is dead with the transport). The next ensureEndpoint rebuilds
   *  against the reconnected runtime. Mirrors ExtensionServerManager.disposeForRuntime. */
  disposeForRuntime(runtimeId: string): void {
    for (const [workspaceId, session] of [...this.sessions]) {
      if (session.runtime.id === runtimeId) {
        this.teardown(session)
        this.sessions.delete(workspaceId)
        log.info('[workspace-cateapi] runtime %s disconnected, dropped ws=%s', runtimeId, workspaceId)
      }
    }
  }

  /** Tear down every endpoint (app quit). */
  disposeAll(): void {
    for (const session of this.sessions.values()) this.teardown(session)
    this.sessions.clear()
  }

  private teardown(session: WorkspaceSession): void {
    session.binding.dispose()
  }
}

export const workspaceCateApi = new WorkspaceCateApiManager()
