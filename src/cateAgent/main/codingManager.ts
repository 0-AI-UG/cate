// =============================================================================
// CodingManager — one pi session per panel, run THROUGH the runtime.
//
// pi is no longer spawned (or bundled) by the desktop app. The session resolves
// the workspace's runtime from its locator and drives pi via `runtime.agent`
// — local (in-process spawn from the on-demand pi tarball) or remote (pi on the
// daemon's host) identically. PiRpcClient speaks pi's `--mode rpc` JSONL over
// that channel. Provider credentials are seeded to the host's cate-agent dir via
// `runtime.file` (so they work on a remote host too).
//
// This file stays a thin glue layer: forward renderer commands to pi, forward
// pi's events back to the renderer.
// =============================================================================

import path from 'path'
import { type WebContents } from 'electron'
import log from '../../main/logger'
import { parseLocator } from '../../main/runtime/locator'
import { runtimes } from '../../main/runtime/runtimeManager'
import type { Runtime } from '../../main/runtime/types'
import { PiRpcClient } from './piRpcClient'

import type { PiImageContent } from './piRpcClient'
import type {
  CodingCreateOptions,
  CodingEventEnvelope,
  CodingExtensionUIResponse,
  CodingImageAttachment,
  CateAgentModelRef,
  CodingRpcState,
  CodingSessionStats,
  CodingSlashCommand,
  CodingThinkingLevel,
} from '../../shared/types'
import { CODING_EVENT, AUTH_CHANGED } from '../../shared/ipc-channels'
import { broadcastToAll } from '../../main/windowRegistry'
import { installSubagentExtension } from './installSubagents'
import { installPlanModeExtension } from './installPlanMode'
import { installAskUserExtension } from './installAskUser'
import { installCateAgentToolsExtension } from './installCateAgentTools'
import { installMcpAdapter } from './installMcpAdapter'
import { hostCodingDir, prepareCodingDir, watchWorkspaceAuth, pushSharedToWorkspace, type CodingDirVariant } from './codingDir'
import { mirrorModelsToWorkspace } from './customModels'
import { authManager, type AuthManager } from './authManager'
import { getSetting } from '../../main/settingsFile'
import { workspaceCateApi } from '../../main/extensions/workspaceCateApi'
import { KeyedLock } from '../../main/keyedLock'
import { agentMessageText, lastAssistantMessage } from '../../shared/agentMessages'

interface AgentSession {
  panelId: string
  /** The runtime hosting this session (local or remote). */
  runtime: Runtime
  /** Runtime-absolute workspace path (the locator's path part). */
  cwd: string
  /** Which per-workspace pi dir this session lives in (default vs isolated Cate Agent). */
  variant: CodingDirVariant
  client: PiRpcClient
  sender: WebContents
  unsubscribeEvents: () => void
  disposeExitWatcher: () => void
  disposeAuthWatcher: () => void
  modelRef: CateAgentModelRef | null
}

/** Convert renderer-side image attachments to pi's ImageContent shape. */
function toImageContent(images?: CodingImageAttachment[]): PiImageContent[] | undefined {
  if (!images || images.length === 0) return undefined
  return images.map((img) => ({ type: 'image', data: img.data, mimeType: img.mimeType }))
}

/** Result of one extension agent turn: the flattened `text` for convenience plus
 *  the raw assistant `message` (content blocks and all). */
export interface CodingTurnResult {
  text: string
  message: Record<string, unknown> | null
}

interface ExtSession {
  /** The handle returned to the extension — pi's own session file path, so the
   *  conversation can be resumed later with no Cate-side persistence. */
  handle: string
  /** The live pi session's panelId in `sessions`. */
  panelId: string
  extensionId: string
  /** A turn is in flight — one at a time per session. */
  busy: boolean
}

export class CodingManager {
  private sessions = new Map<string, AgentSession>()
  private locks = new KeyedLock()
  // Used to resolve the default model for extension-initiated background runs
  // (see openForExtension) and for the auth-change mirror hook below.
  private authManager: AuthManager
  // Live extension agent sessions, keyed by handle (pi's session file). pi owns
  // all conversation state on disk; Cate keeps only this in-memory handle->client
  // routing, exactly like a panel. One live session per extension is the cap
  // against runaway loops (see openForExtension).
  private readonly extSessions = new Map<string, ExtSession>()
  private extRunSeq = 0

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
    await this.syncConfigToOpenSessions('auth', (session) =>
      pushSharedToWorkspace(session.runtime, session.cwd, session.variant),
    )
    broadcastToAll(AUTH_CHANGED)
  }

  private async syncConfigToOpenSessions(
    label: 'auth' | 'models',
    sync: (session: AgentSession) => Promise<void>,
  ): Promise<void> {
    await Promise.all(
      Array.from(this.sessions.values()).map((session) =>
        sync(session).catch((err) => {
          log.warn('[codingManager] %s sync failed for %s: %O', label, session.panelId, err)
        }),
      ),
    )
  }

  /** Re-mirror the shared models.json into every open workspace, so the custom
   *  OpenAI provider edited in cate's UI reaches live pi processes (picked up
   *  on their next model-list fetch). */
  async syncCustomModelsToOpenSessions(): Promise<void> {
    await this.syncConfigToOpenSessions('models', (session) =>
      mirrorModelsToWorkspace(session.runtime, session.cwd, session.variant),
    )
    broadcastToAll(AUTH_CHANGED)
  }

  async create(opts: CodingCreateOptions, sender: WebContents): Promise<void> {
    return this.locks.run(opts.panelId, async () => {
      if (this.sessions.has(opts.panelId)) {
        // Idempotent per agentKey: a second create for a key that already has a
        // live pi (two panels resolving the same durable coding chat, or a create
        // racing an in-flight one) is a no-op ADOPTION — never kill and respawn.
        // Respawning here would strand the first panel's freshly-started pi and
        // interrupt any in-flight turn. serialized by locks.run, so this check is
        // race-free against a concurrent create for the same key.
        log.info('[codingManager] adopting existing session for %s (create is a no-op)', opts.panelId)
        return
      }

      // Resolve the workspace's runtime from its locator (throws if a remote
      // runtime isn't connected — surfaced as a start error).
      const { runtimeId, path: cwd } = parseLocator(opts.cwd)
      const runtime = runtimes.resolve(runtimeId)

      // The Cate Agent's headless sessions live in an ISOLATED per-workspace pi
      // dir (.cate/cate-agent-loop) so their transcripts never show up in — or get
      // resumed by — the agent panel's session list. Normal panels use the
      // default dir. Either way auth.json + models.json are seeded via the
      // runtime (so it lands on a remote host too) and PI_CODING_AGENT_DIR
      // points pi at the chosen dir.
      const variant: CodingDirVariant = opts.agentDir === 'cateAgent' ? 'cateAgent' : 'default'
      await prepareCodingDir(runtime, cwd, variant)
      await mirrorModelsToWorkspace(runtime, cwd, variant)
      if (variant === 'cateAgent') {
        // The Cate Agent only needs its own tool surface — not the user-facing
        // subagent / plan-mode / ask-user extensions.
        await installCateAgentToolsExtension(runtime, cwd, 'cateAgent')
      } else {
        await installSubagentExtension(runtime, cwd)
        await installPlanModeExtension(runtime, cwd)
        await installAskUserExtension(runtime, cwd)
        // Register pi-mcp-adapter in <cwd>/.cate/cate-agent/settings.json so pi
        // auto-installs + loads it on session start (MCP driven by <cwd>/.pi/mcp.json).
        await installMcpAdapter(runtime, cwd)
      }


      const extraArgs: string[] = []
      if (opts.sessionFile) extraArgs.push('--session', opts.sessionFile)

      // opts.env (e.g. CATE_AGENT_ROLE) is merged first but must never clobber
      // PI_CODING_AGENT_DIR, which points pi at the workspace agent dir.
      const env: Record<string, string> = {
        ...(opts.env ?? {}),
        PI_CODING_AGENT_DIR: hostCodingDir(runtimeId, cwd, variant),
      }

      // First-party CATE_API endpoint: give pi CATE_API/CATE_TOKEN so a `cate`
      // CLI run from a tool can reach the dispatch core. Null when the CLI
      // setting is disabled (the gate) — then nothing is injected (fail closed).
      const cateApi = await workspaceCateApi.ensureEndpoint(opts.workspaceId)
      if (cateApi) {
        env.CATE_API = `http://127.0.0.1:${cateApi.port}`
        env.CATE_TOKEN = cateApi.token
      }

      const client = new PiRpcClient(runtime, {
        cwd,
        provider: opts.model?.provider,
        model: opts.model?.model,
        args: extraArgs.length > 0 ? extraArgs : undefined,
        env,
      })

      // Ensure pi is present on the host BEFORE start. pi ships in the runtime
      // tarball (remote) or is resolved/extracted client-side (local), so on a
      // provisioned host this is a quick verify.
      await runtime.agent.ensurePi()

      try {
        await client.start()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn('[codingManager] failed to start pi for %s: %s', opts.panelId, message)
        this.sendErrorEvent(sender, opts.panelId, `Failed to start pi: ${message}`)
        throw err
      }

      const unsubscribeEvents = client.onEvent((event) => {
        try {
          if (sender.isDestroyed()) return
          const envelope: CodingEventEnvelope = {
            panelId: opts.panelId,
            event: event as unknown as CodingEventEnvelope['event'],
          }
          sender.send(CODING_EVENT, envelope)
        } catch (err) {
          log.warn('[codingManager] failed to forward event: %O', err)
        }
      })

      // If pi exits UNEXPECTEDLY (crash on launch, killed, etc.), surface its
      // exit code + stderr to the panel instead of letting every subsequent RPC
      // hang for 30s. stop()/dispose set a flag so a clean shutdown stays quiet.
      const disposeExitWatcher = client.onExit((code, stderr) => {
        const reason = stderr ? `\n${stderr}` : ''
        log.warn('[codingManager] pi exited unexpectedly panel=%s code=%s%s', opts.panelId, code, reason)
        this.sendErrorEvent(sender, opts.panelId, `Agent process exited (code ${code}).${reason}`)
      })

      // Watch the host's auth.json so OAuth token refreshes written by pi
      // propagate back to the shared file.
      const disposeAuthWatcher = watchWorkspaceAuth(runtime, cwd, variant)

      this.sessions.set(opts.panelId, {
        panelId: opts.panelId,
        runtime,
        cwd,
        variant,
        client,
        sender,
        unsubscribeEvents,
        disposeExitWatcher,
        disposeAuthWatcher,
        modelRef: opts.model ?? null,
      })
      log.info(
        '[codingManager] started pi panel=%s model=%s/%s sessionFile=%s',
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
                '[codingManager] readiness probe getState rejected for %s: %O',
                opts.panelId,
                err,
              )
            }
          })(),
          new Promise<void>((resolve) => setTimeout(resolve, readinessTimeoutMs)),
        ])
      } catch (err) {
        log.warn('[codingManager] readiness probe failed for %s: %O', opts.panelId, err)
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Prompting / steering
  // ---------------------------------------------------------------------------

  async prompt(panelId: string, text: string, images?: CodingImageAttachment[]): Promise<void> {
    const session = this.requireSession(panelId)
    try {
      await session.client.prompt(text, toImageContent(images))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('[codingManager] prompt failed for %s: %s', panelId, message)
      this.sendErrorEvent(session.sender, panelId, message)
    }
  }

  async steer(panelId: string, text: string, images?: CodingImageAttachment[]): Promise<void> {
    const session = this.requireSession(panelId)
    await session.client.steer(text, toImageContent(images))
  }

  async interrupt(panelId: string): Promise<void> {
    const session = this.sessions.get(panelId)
    if (!session) return
    try { await session.client.abort() }
    catch (err) { log.warn('[codingManager] interrupt failed for %s: %O', panelId, err) }
  }

  async dispose(panelId: string): Promise<void> {
    return this.locks.run(panelId, () => this.disposeInternal(panelId))
  }

  // ---------------------------------------------------------------------------
  // Extension agent sessions (cate.agent.open / send / dispose, and run sugar)
  //
  // An enabled extension drives a real pi session the same way a panel does:
  // Cate holds the live client in `sessions` and forwards its events to the
  // active window; pi owns ALL conversation state on its session jsonl. The
  // handle returned to the extension IS that jsonl path, so a conversation can
  // be resumed later with nothing persisted on Cate's side. Turn-based: each
  // `send` runs one turn and returns the final assistant message. One live
  // session per extension, one in-flight turn per session — the anti-runaway cap.
  // ---------------------------------------------------------------------------

  /** Open (or resume) a persistent agent session for an extension. Returns the
   *  handle (pi's session file) to pass to `sendForExtension`. */
  async openForExtension(opts: {
    workspaceId: string
    locator: string
    extensionId: string
    sender: WebContents
    resume?: string
  }): Promise<{ sessionId: string }> {
    for (const s of this.extSessions.values()) {
      // One live session per extension — the anti-runaway cap. Checked first, so
      // an extension re-opening its OWN live handle sees 'agent-busy', not the
      // ownership error below.
      if (s.extensionId === opts.extensionId) throw new Error('agent-busy')
      // The workspace's .cate/cate-agent dir is shared across its extensions, so a
      // `resume` handle can name a session live under a DIFFERENT extension.
      // Refuse it — overwriting the routing entry would strand that extension's
      // pi child (leak) and fork both onto one jsonl.
      if (opts.resume && s.handle === opts.resume) {
        throw new Error('session-owned-by-another-extension')
      }
    }
    const panelId = `ext-${opts.extensionId}-${++this.extRunSeq}`
    const model = await this.resolveDefaultModel()
    await this.create(
      {
        panelId,
        workspaceId: opts.workspaceId,
        cwd: opts.locator,
        model: model ?? undefined,
        sessionFile: opts.resume,
      },
      opts.sender,
    )
    const session = this.sessions.get(panelId)
    if (!session) throw new Error('agent-failed')
    // The handle is pi's session file: known up-front on resume, else read back
    // from pi (it assigns one for a fresh session). Fall back to the panelId so
    // the session is still routable this run even if the path can't be read.
    let handle = opts.resume ?? ''
    if (!handle) {
      try {
        const state = (await session.client.getState()) as { sessionFile?: string } | null
        handle = state?.sessionFile ?? ''
      } catch { /* fall through */ }
    }
    if (!handle) handle = panelId
    this.extSessions.set(handle, { handle, panelId, extensionId: opts.extensionId, busy: false })
    log.info('[codingManager] ext session open ext=%s handle=%s', opts.extensionId, handle)
    return { sessionId: handle }
  }

  /** Run one turn on an open extension session and return the final assistant
   *  message. The session must belong to `extensionId`. */
  async sendForExtension(opts: {
    extensionId: string
    sessionId: string
    text: string
  }): Promise<CodingTurnResult> {
    const ext = this.extSessions.get(opts.sessionId)
    if (!ext || ext.extensionId !== opts.extensionId) throw new Error('no-session')
    if (ext.busy) throw new Error('agent-busy')
    const session = this.sessions.get(ext.panelId)
    if (!session) { this.extSessions.delete(opts.sessionId); throw new Error('no-session') }
    ext.busy = true
    try {
      const result = await this.runTurn(session, opts.text)
      log.info('[codingManager] ext session turn ext=%s chars=%d', opts.extensionId, result.text.length)
      return result
    } finally {
      ext.busy = false
    }
  }

  /** Tear down an open extension session's live client. pi's jsonl stays on disk,
   *  so the same handle can be re-opened later via `resume`. */
  async disposeForExtension(opts: { extensionId: string; sessionId: string }): Promise<void> {
    const ext = this.extSessions.get(opts.sessionId)
    if (!ext || ext.extensionId !== opts.extensionId) return
    this.extSessions.delete(opts.sessionId)
    await this.dispose(ext.panelId)
  }

  /** Abort the in-flight turn of this extension's session (best effort). */
  async cancelForExtension(extensionId: string): Promise<void> {
    for (const ext of this.extSessions.values()) {
      if (ext.extensionId === extensionId) await this.interrupt(ext.panelId)
    }
  }

  /** The NON-streaming turn runner used by extension sessions: send the prompt
   *  and resolve with the final assistant message once pi emits its terminal
   *  `agent_end`. That event carries the full `messages` list, so the answer is
   *  read straight off it — the panel's streaming path (events forwarded to the
   *  renderer and accumulated there) is entirely separate and untouched.
   *
   *  pi also emits an `agent_end` flagged `willRetry: true` for a turn it is
   *  about to auto-retry — its last assistant message is the empty error, so we
   *  skip it and wait for the terminal one. Rejects on an agent error event or
   *  an unexpected pi exit. */
  private runTurn(session: AgentSession, text: string): Promise<CodingTurnResult> {
    return new Promise<CodingTurnResult>((resolve, reject) => {
      let settled = false
      let offEvent = () => {}
      let offExit = () => {}
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        try { offEvent() } catch { /* noop */ }
        try { offExit() } catch { /* noop */ }
        fn()
      }
      offEvent = session.client.onEvent((ev) => {
        const e = ev as { type?: string; willRetry?: boolean; messages?: unknown; message?: string } | null
        if (e?.type === 'agent_end') {
          // A retry turn follows — not the terminal end of the run.
          if (e.willRetry === true) return
          const message = lastAssistantMessage(e.messages)
          // A turn can end on a non-retryable error (unsupported model, auth, bad
          // request): pi sets stopReason 'error' + an errorMessage on an empty
          // assistant message. Surface it, don't hand back silent empty text.
          if (message && message.stopReason === 'error') {
            const reason = typeof message.errorMessage === 'string' ? message.errorMessage : 'agent error'
            settle(() => reject(new Error(reason)))
            return
          }
          settle(() => resolve({ text: agentMessageText(message), message }))
        } else if (e?.type === 'error') {
          settle(() => reject(new Error(e.message || 'agent error')))
        }
      })
      offExit = session.client.onExit((code) => settle(() => reject(new Error(`agent exited (code ${code})`))))
      session.client.prompt(text).catch((err) =>
        settle(() => reject(err instanceof Error ? err : new Error(String(err)))),
      )
    })
  }

  /** The user's configured default agent model, or the first available one;
   *  null when no provider is connected (pi then falls back to its own default). */
  private async resolveDefaultModel(): Promise<CateAgentModelRef | null> {
    const pref = getSetting('agentDefaultModel')
    if (pref && pref.provider && pref.model) return pref
    try {
      const models = await this.authManager.listAvailableModels()
      if (models.length > 0) return { provider: models[0].provider, model: models[0].id }
    } catch { /* fall through to null */ }
    return null
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
    // Drop any extension handle that routed to this session (e.g. the owning
    // window went away) so a stale handle can't outlive its client.
    for (const [handle, ext] of this.extSessions) {
      if (ext.panelId === panelId) this.extSessions.delete(handle)
    }
    log.info('[codingManager] disposed session panel=%s', panelId)
  }

  // ---------------------------------------------------------------------------
  // Model / thinking
  // ---------------------------------------------------------------------------

  async setModel(panelId: string, modelRef: CateAgentModelRef): Promise<void> {
    const session = this.requireSession(panelId)
    try {
      await session.client.setModel(modelRef.provider, modelRef.model)
      session.modelRef = modelRef
      log.info('[codingManager] panel=%s model -> %s/%s', panelId, modelRef.provider, modelRef.model)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('[codingManager] setModel failed for %s: %s', panelId, message)
      throw err
    }
  }

  async setThinkingLevel(panelId: string, level: CodingThinkingLevel): Promise<void> {
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

  async getState(panelId: string): Promise<CodingRpcState | null> {
    const session = this.sessions.get(panelId)
    if (!session) return null
    try {
      return (await session.client.getState()) as unknown as CodingRpcState
    } catch (err) {
      log.warn('[codingManager] getState failed for %s: %O', panelId, err)
      return null
    }
  }

  async getSessionStats(panelId: string): Promise<CodingSessionStats | null> {
    const session = this.sessions.get(panelId)
    if (!session) return null
    try {
      return (await session.client.getSessionStats()) as unknown as CodingSessionStats
    } catch (err) {
      log.warn('[codingManager] getSessionStats failed for %s: %O', panelId, err)
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
      log.warn('[codingManager] getForkMessages failed for %s: %O', panelId, err)
      return []
    }
  }


  // ---------------------------------------------------------------------------
  // Commands (skills / prompts / extensions)
  // ---------------------------------------------------------------------------

  async getCommands(panelId: string): Promise<CodingSlashCommand[]> {
    const session = this.sessions.get(panelId)
    if (!session) return []
    try {
      const commands = await session.client.getCommands()
      const homeAgent = hostCodingDir(session.runtime.id, session.cwd) + path.sep
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
      log.warn('[codingManager] getCommands failed for %s: %O', panelId, err)
      return []
    }
  }

  // ---------------------------------------------------------------------------
  // Extension UI sub-protocol — reply to dialog requests by writing the raw
  // response JSON back to pi's stdin.
  // ---------------------------------------------------------------------------

  uiResponse(panelId: string, response: CodingExtensionUIResponse): void {
    const session = this.sessions.get(panelId)
    if (!session) return
    try {
      session.client.writeRaw({ type: 'extension_ui_response', ...response })
    } catch (err) {
      log.warn('[codingManager] uiResponse failed for %s: %O', panelId, err)
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
      const envelope: CodingEventEnvelope = {
        panelId,
        event: { type: 'error', message },
      }
      sender.send(CODING_EVENT, envelope)
    } catch { /* noop */ }
  }
}

// Single shared instance — one pi agent manager per app (main process).
export const codingManager = new CodingManager(authManager)
