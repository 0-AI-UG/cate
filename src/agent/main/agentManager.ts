// =============================================================================
// AgentManager — one pi session per panel, run THROUGH the companion.
//
// pi is no longer spawned (or bundled) by the desktop app. The session resolves
// the workspace's companion from its locator and drives pi via `companion.agent`
// — local (in-process spawn from the on-demand pi tarball) or remote (pi on the
// daemon's host) identically. PiRpcClient speaks pi's `--mode rpc` JSONL over
// that channel. Provider credentials are seeded to the host's pi-agent dir via
// `companion.file` (so they work on a remote host too).
//
// This file stays a thin glue layer: forward renderer commands to pi, forward
// pi's events back to the renderer.
// =============================================================================

import path from 'path'
import { type WebContents } from 'electron'
import log from '../../main/logger'
import { parseLocator } from '../../main/companion/locator'
import { companions } from '../../main/companion/companionManager'
import type { Companion } from '../../main/companion/types'
import { PiRpcClient } from './piRpcClient'

import type { PiImageContent } from './piRpcClient'
import type {
  AgentCreateOptions,
  AgentEventEnvelope,
  AgentExtensionUIResponse,
  AgentImageAttachment,
  AgentModelRef,
  AgentRpcState,
  AgentSessionStats,
  AgentSlashCommand,
  AgentThinkingLevel,
} from '../../shared/types'
import { AGENT_EVENT, AUTH_CHANGED } from '../../shared/ipc-channels'
import { broadcastToAll } from '../../main/windowRegistry'
import { installSubagentExtension } from './installSubagents'
import { installPlanModeExtension } from './installPlanMode'
import { installAskUserExtension } from './installAskUser'
import { hostAgentDir, prepareAgentDir, watchWorkspaceAuth, pushSharedToWorkspace } from './agentDir'
import { mirrorModelsToWorkspace } from './customModels'
import type { AuthManager } from './authManager'

interface AgentSession {
  panelId: string
  /** The companion hosting this session (local or remote). */
  companion: Companion
  /** Companion-absolute workspace path (the locator's path part). */
  cwd: string
  client: PiRpcClient
  sender: WebContents
  unsubscribeEvents: () => void
  disposeExitWatcher: () => void
  disposeAuthWatcher: () => void
  modelRef: AgentModelRef | null
}

/** Convert renderer-side image attachments to pi's ImageContent shape. */
function toImageContent(images?: AgentImageAttachment[]): PiImageContent[] | undefined {
  if (!images || images.length === 0) return undefined
  return images.map((img) => ({ type: 'image', data: img.data, mimeType: img.mimeType }))
}

export class AgentManager {
  private sessions = new Map<string, AgentSession>()
  private locks = new Map<string, Promise<unknown>>()
  // `authManager` isn't read here anymore — pi reads credentials directly from
  // ~/.pi/agent/auth.json. We keep the reference around for symmetry with the
  // construction site and in case future hooks need it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private authManager: AuthManager

  constructor(authManager: AuthManager) {
    this.authManager = authManager
    // When the user changes credentials in cate's UI, mirror the shared
    // auth.json into every open workspace so their pi processes see it, then
    // tell every renderer so model pickers / provider status refresh without a
    // panel reload (the OAuth `done` event only reaches the window that started
    // the flow).
    authManager.setOnChange(() => { void this.handleAuthChanged() })
  }

  private async handleAuthChanged(): Promise<void> {
    // Mirror FIRST so a renderer re-querying available models sees pi pick up
    // the fresh credentials, then broadcast.
    await this.syncAuthToOpenSessions()
    broadcastToAll(AUTH_CHANGED)
  }

  /** Push the shared auth.json into every live session's workspace dir. */
  private async syncAuthToOpenSessions(): Promise<void> {
    await Promise.all(
      Array.from(this.sessions.values()).map((session) =>
        pushSharedToWorkspace(session.companion, session.cwd).catch((err) => {
          log.warn('[agentManager] auth sync failed for %s: %O', session.panelId, err)
        }),
      ),
    )
  }

  /** Re-mirror the shared models.json into every open workspace, so the custom
   *  OpenAI provider edited in cate's UI reaches live pi processes (picked up
   *  on their next model-list fetch). */
  syncCustomModelsToOpenSessions(): void {
    for (const session of this.sessions.values()) {
      void mirrorModelsToWorkspace(session.companion, session.cwd).catch((err) => {
        log.warn('[agentManager] models sync failed for %s: %O', session.panelId, err)
      })
    }
  }

  private withLock<T>(panelId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(panelId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.locks.set(panelId, next.catch(() => undefined))
    return next
  }

  async create(opts: AgentCreateOptions, sender: WebContents): Promise<void> {
    return this.withLock(opts.panelId, async () => {
      if (this.sessions.has(opts.panelId)) {
        log.info('[agentManager] disposing existing session for %s before re-create', opts.panelId)
        await this.disposeInternal(opts.panelId)
      }

      // Resolve the workspace's companion from its locator (throws if a remote
      // companion isn't connected — surfaced as a start error).
      const { companionId, path: cwd } = parseLocator(opts.cwd)
      const companion = companions.resolve(companionId)

      // Seed the host's <cwd>/.cate/pi-agent: auth.json + models.json via the
      // companion (so it lands on the remote host too), plus Cate's bundled
      // extensions (subagent, plan-mode, ask-user). PI_CODING_AGENT_DIR points
      // pi at that dir.
      await prepareAgentDir(companion, cwd)
      await mirrorModelsToWorkspace(companion, cwd)
      await installSubagentExtension(companion, cwd)
      await installPlanModeExtension(companion, cwd)
      await installAskUserExtension(companion, cwd)

      const extraArgs: string[] = []
      if (opts.sessionFile) extraArgs.push('--session', opts.sessionFile)

      const client = new PiRpcClient(companion, {
        cwd,
        provider: opts.model?.provider,
        model: opts.model?.model,
        args: extraArgs.length > 0 ? extraArgs : undefined,
        env: { PI_CODING_AGENT_DIR: hostAgentDir(companionId, cwd) },
      })

      // Ensure pi is present on the host BEFORE start. pi ships in the companion
      // tarball (remote) or is resolved/extracted client-side (local), so on a
      // provisioned host this is a quick verify.
      await companion.agent.ensurePi()

      try {
        await client.start()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn('[agentManager] failed to start pi for %s: %s', opts.panelId, message)
        this.sendErrorEvent(sender, opts.panelId, `Failed to start pi: ${message}`)
        throw err
      }

      const unsubscribeEvents = client.onEvent((event) => {
        try {
          if (sender.isDestroyed()) return
          const envelope: AgentEventEnvelope = {
            panelId: opts.panelId,
            event: event as unknown as AgentEventEnvelope['event'],
          }
          sender.send(AGENT_EVENT, envelope)
        } catch (err) {
          log.warn('[agentManager] failed to forward event: %O', err)
        }
      })

      // If pi exits UNEXPECTEDLY (crash on launch, killed, etc.), surface its
      // exit code + stderr to the panel instead of letting every subsequent RPC
      // hang for 30s. stop()/dispose set a flag so a clean shutdown stays quiet.
      const disposeExitWatcher = client.onExit((code, stderr) => {
        const reason = stderr ? `\n${stderr}` : ''
        log.warn('[agentManager] pi exited unexpectedly panel=%s code=%s%s', opts.panelId, code, reason)
        this.sendErrorEvent(sender, opts.panelId, `Agent process exited (code ${code}).${reason}`)
      })

      // Watch the host's auth.json so OAuth token refreshes written by pi
      // propagate back to the shared file.
      const disposeAuthWatcher = watchWorkspaceAuth(companion, cwd)

      this.sessions.set(opts.panelId, {
        panelId: opts.panelId,
        companion,
        cwd,
        client,
        sender,
        unsubscribeEvents,
        disposeExitWatcher,
        disposeAuthWatcher,
        modelRef: opts.model ?? null,
      })
      log.info(
        '[agentManager] started pi panel=%s model=%s/%s sessionFile=%s',
        opts.panelId,
        opts.model?.provider ?? '(default)',
        opts.model?.model ?? '(default)',
        opts.sessionFile ?? '(none)',
      )

      // Readiness probe: RpcClient.start() returns after spawn but pi may still
      // be loading + migrating the session jsonl before its stdin loop is ready
      // to accept RPCs. Issue a cheap get_state and wait (with a generous cap)
      // for it to resolve — if it never does we still proceed (best-effort).
      // This prevents the first burst of getForkMessages / getSessionStats /
      // getState calls from queueing against an unresponsive pi and timing out
      // 30s later.
      const readinessTimeoutMs = 5000
      try {
        await Promise.race([
          (async () => {
            try {
              await client.getState()
            } catch (err) {
              log.warn(
                '[agentManager] readiness probe getState rejected for %s: %O',
                opts.panelId,
                err,
              )
            }
          })(),
          new Promise<void>((resolve) => setTimeout(resolve, readinessTimeoutMs)),
        ])
      } catch (err) {
        log.warn('[agentManager] readiness probe failed for %s: %O', opts.panelId, err)
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Prompting / steering
  // ---------------------------------------------------------------------------

  async prompt(panelId: string, text: string, images?: AgentImageAttachment[]): Promise<void> {
    const session = this.requireSession(panelId)
    try {
      await session.client.prompt(text, toImageContent(images))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('[agentManager] prompt failed for %s: %s', panelId, message)
      this.sendErrorEvent(session.sender, panelId, message)
    }
  }

  async steer(panelId: string, text: string, images?: AgentImageAttachment[]): Promise<void> {
    const session = this.requireSession(panelId)
    await session.client.steer(text, toImageContent(images))
  }

  async interrupt(panelId: string): Promise<void> {
    const session = this.sessions.get(panelId)
    if (!session) return
    try { await session.client.abort() }
    catch (err) { log.warn('[agentManager] interrupt failed for %s: %O', panelId, err) }
  }

  async dispose(panelId: string): Promise<void> {
    return this.withLock(panelId, () => this.disposeInternal(panelId))
  }

  private async disposeInternal(panelId: string): Promise<void> {
    const session = this.sessions.get(panelId)
    if (!session) return
    try { session.unsubscribeEvents() } catch { /* noop */ }
    try { session.disposeExitWatcher() } catch { /* noop */ }
    try { session.disposeAuthWatcher() } catch { /* noop */ }
    // Reject any in-flight requests so their promises don't hang once pi is gone.
    try { session.client.rejectAllPending('Pi session disposed') } catch { /* noop */ }
    try { await session.client.stop() } catch { /* noop */ }
    this.sessions.delete(panelId)
    log.info('[agentManager] disposed session panel=%s', panelId)
  }

  // ---------------------------------------------------------------------------
  // Model / thinking
  // ---------------------------------------------------------------------------

  async setModel(panelId: string, modelRef: AgentModelRef): Promise<void> {
    const session = this.requireSession(panelId)
    try {
      await session.client.setModel(modelRef.provider, modelRef.model)
      session.modelRef = modelRef
      log.info('[agentManager] panel=%s model -> %s/%s', panelId, modelRef.provider, modelRef.model)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('[agentManager] setModel failed for %s: %s', panelId, message)
      throw err
    }
  }

  async setThinkingLevel(panelId: string, level: AgentThinkingLevel): Promise<void> {
    const session = this.requireSession(panelId)
    await session.client.setThinkingLevel(level)
  }


  // ---------------------------------------------------------------------------
  // Compaction / retry
  // ---------------------------------------------------------------------------

  async compact(panelId: string, customInstructions?: string): Promise<unknown> {
    const session = this.requireSession(panelId)
    return session.client.compact(customInstructions)
  }

  async setAutoCompaction(panelId: string, enabled: boolean): Promise<void> {
    const session = this.requireSession(panelId)
    await session.client.setAutoCompaction(enabled)
  }

  async abortRetry(panelId: string): Promise<void> {
    const session = this.requireSession(panelId)
    await session.client.abortRetry()
  }

  // ---------------------------------------------------------------------------
  // Session / fork / clone
  // ---------------------------------------------------------------------------

  async getState(panelId: string): Promise<AgentRpcState | null> {
    const session = this.sessions.get(panelId)
    if (!session) return null
    try {
      return (await session.client.getState()) as unknown as AgentRpcState
    } catch (err) {
      log.warn('[agentManager] getState failed for %s: %O', panelId, err)
      return null
    }
  }

  async getSessionStats(panelId: string): Promise<AgentSessionStats | null> {
    const session = this.sessions.get(panelId)
    if (!session) return null
    try {
      return (await session.client.getSessionStats()) as unknown as AgentSessionStats
    } catch (err) {
      log.warn('[agentManager] getSessionStats failed for %s: %O', panelId, err)
      return null
    }
  }

  async fork(panelId: string, entryId: string): Promise<{ text: string; cancelled: boolean }> {
    const session = this.requireSession(panelId)
    return session.client.fork(entryId)
  }

  async getForkMessages(panelId: string): Promise<Array<{ entryId: string; text: string }>> {
    const session = this.sessions.get(panelId)
    if (!session) return []
    try {
      return await session.client.getForkMessages()
    } catch (err) {
      log.warn('[agentManager] getForkMessages failed for %s: %O', panelId, err)
      return []
    }
  }


  // ---------------------------------------------------------------------------
  // Commands (skills / prompts / extensions)
  // ---------------------------------------------------------------------------

  async getCommands(panelId: string): Promise<AgentSlashCommand[]> {
    const session = this.sessions.get(panelId)
    if (!session) return []
    try {
      const commands = await session.client.getCommands()
      const homeAgent = hostAgentDir(session.companion.id, session.cwd) + path.sep
      return commands.map((c) => {
        const filePath = (c as { sourceInfo?: { path?: string; scope?: 'user' | 'project' | 'temporary' } }).sourceInfo?.path
        const scope = (c as { sourceInfo?: { scope?: 'user' | 'project' | 'temporary' } }).sourceInfo?.scope
        const editable = !!filePath && filePath.startsWith(homeAgent)
        return {
          name: c.name,
          description: c.description,
          source: c.source,
          path: filePath,
          scope,
          editable,
        }
      })
    } catch (err) {
      log.warn('[agentManager] getCommands failed for %s: %O', panelId, err)
      return []
    }
  }

  // ---------------------------------------------------------------------------
  // Extension UI sub-protocol — reply to dialog requests by writing the raw
  // response JSON back to pi's stdin.
  // ---------------------------------------------------------------------------

  uiResponse(panelId: string, response: AgentExtensionUIResponse): void {
    const session = this.sessions.get(panelId)
    if (!session) return
    try {
      session.client.writeRaw({ type: 'extension_ui_response', ...response })
    } catch (err) {
      log.warn('[agentManager] uiResponse failed for %s: %O', panelId, err)
    }
  }

  /** Drop sessions whose sender WebContents has gone away. */
  disposeForWebContents(wcId: number): void {
    for (const [panelId, session] of this.sessions) {
      if (session.sender.id === wcId) {
        void this.dispose(panelId)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireSession(panelId: string): AgentSession {
    const session = this.sessions.get(panelId)
    if (!session) throw new Error(`No agent session for panel ${panelId}`)
    return session
  }

  private sendErrorEvent(sender: WebContents, panelId: string, message: string): void {
    try {
      if (sender.isDestroyed()) return
      const envelope: AgentEventEnvelope = {
        panelId,
        event: { type: 'error', message },
      }
      sender.send(AGENT_EVENT, envelope)
    } catch { /* noop */ }
  }
}
