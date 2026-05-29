// =============================================================================
// AgentManager — one pi `RpcClient` subprocess per panel.
//
// We do not run the agent in-process anymore. Instead we spawn pi-coding-agent
// as a long-lived child via its built-in `--mode rpc` protocol and let pi own
// the agent loop, tools, system prompt, sessions, and extensions. Credentials
// flow through ~/.pi/agent/auth.json (written by AuthManager).
//
// This file is intentionally a thin glue layer: it forwards renderer commands
// to pi over RPC and forwards pi's events back to the renderer. Anything
// agent-shaped that wants changing belongs upstream in pi.
// =============================================================================

import fs from 'fs'
import path from 'path'
import { app, type WebContents } from 'electron'
import { RpcClient } from '@earendil-works/pi-coding-agent'
import log from '../../main/logger'
import { getShellEnv } from '../../main/shellEnv'
import { createNodeShim } from './nodeShim'

// Structural alias for pi-ai's ImageContent — pi-ai doesn't expose a `.` export
// so we duplicate the minimal shape here. Pi reads `{type, data, mimeType}`.
interface ImageContent {
  type: 'image'
  data: string
  mimeType: string
}
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
import { AGENT_EVENT } from '../../shared/ipc-channels'
import { installSubagentExtension } from './installSubagents'
import { installPlanModeExtension } from './installPlanMode'
import { agentDirFor, prepareAgentDir, watchWorkspaceAuth, pushSharedToWorkspace } from './agentDir'
import type { AuthManager } from './authManager'

function resolvePiCliPath(): string {
  return path.join(
    app.getAppPath(),
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'dist',
    'cli.js',
  )
}

// RpcClient hardcodes `spawn("node", ...)`, so `node` must be on PATH.
//
// In production we MUST use Electron's own binary (with ELECTRON_RUN_AS_NODE=1)
// because it has built-in asar support — a regular system `node` can't resolve
// modules from inside the asar archive. In dev we fall back to the system node
// only if one exists; otherwise we shim Electron the same way.
let fallbackNodeDir: string | null = null

function nodeExistsOnPath(env: Record<string, string>): boolean {
  const pathVar = env.PATH || env.Path || ''
  if (!pathVar) return false
  const sep = process.platform === 'win32' ? ';' : ':'
  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK)
      return true
    } catch { /* not here */ }
  }
  return false
}

function ensureElectronNodeShim(): string {
  if (fallbackNodeDir) return fallbackNodeDir
  const dir = path.join(app.getPath('temp'), 'cate-node-shim')
  createNodeShim(dir, process.execPath)
  log.info('[agentManager] created node shim in %s (platform=%s)', dir, process.platform)
  fallbackNodeDir = dir
  return dir
}

function buildAgentEnv(cwd: string): Record<string, string> {
  const env = { ...getShellEnv() }
  // Scope pi's entire config (extensions, sessions, settings, auth) to this
  // workspace instead of the user's global ~/.pi/agent.
  env.PI_CODING_AGENT_DIR = agentDirFor(cwd)
  const needsShim = app.isPackaged || !nodeExistsOnPath(env)
  if (needsShim) {
    const shimDir = ensureElectronNodeShim()
    const sep = process.platform === 'win32' ? ';' : ':'
    env.PATH = shimDir + sep + (env.PATH || '')
    env.ELECTRON_RUN_AS_NODE = '1'
    log.info('[agentManager] using Electron as node (packaged=%s)', app.isPackaged)
  }
  return env
}

interface AgentSession {
  panelId: string
  cwd: string
  client: RpcClient
  sender: WebContents
  unsubscribeEvents: () => void
  disposeAuthWatcher: () => void
  modelRef: AgentModelRef | null
}

/** Convert renderer-side image attachments to pi's ImageContent shape. */
function toImageContent(images?: AgentImageAttachment[]): ImageContent[] | undefined {
  if (!images || images.length === 0) return undefined
  return images.map((img) => ({
    type: 'image',
    data: img.data,
    mimeType: img.mimeType,
  })) as unknown as ImageContent[]
}

/** Write a raw line to pi's stdin via the (private) child process handle on
 *  RpcClient. Used for the extension UI sub-protocol — RpcClient does not
 *  expose a typed method for `extension_ui_response`. */
function writeRawToClient(client: RpcClient, obj: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = (client as any).process as { stdin?: { write: (s: string) => void } } | null
  const stdin = proc?.stdin
  if (!stdin) throw new Error('Pi RPC stdin not available')
  stdin.write(JSON.stringify(obj) + '\n')
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
    // auth.json into every open workspace so their pi processes see it.
    authManager.setOnChange(() => this.syncAuthToOpenSessions())
  }

  /** Push the shared auth.json into every live session's workspace dir. */
  private syncAuthToOpenSessions(): void {
    for (const session of this.sessions.values()) {
      void pushSharedToWorkspace(session.cwd).catch((err) => {
        log.warn('[agentManager] auth sync failed for %s: %O', session.panelId, err)
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

      // Create <cwd>/.cate/pi-agent, seed its auth.json from the shared file,
      // and drop pi's official subagent + plan-mode extensions in so they are
      // auto-discovered the first time pi spins up in this workspace.
      await prepareAgentDir(opts.cwd)
      await installSubagentExtension(opts.cwd)
      await installPlanModeExtension(opts.cwd)

      const extraArgs: string[] = []
      if (opts.sessionFile) extraArgs.push('--session', opts.sessionFile)

      const client = new RpcClient({
        cliPath: resolvePiCliPath(),
        cwd: opts.cwd,
        provider: opts.model?.provider,
        model: opts.model?.model,
        args: extraArgs.length > 0 ? extraArgs : undefined,
        env: buildAgentEnv(opts.cwd),
      })

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

      // Watch this workspace's auth.json so OAuth token refreshes written by pi
      // propagate back to the shared file.
      const disposeAuthWatcher = watchWorkspaceAuth(opts.cwd)

      this.sessions.set(opts.panelId, {
        panelId: opts.panelId,
        cwd: opts.cwd,
        client,
        sender,
        unsubscribeEvents,
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

  async followUp(panelId: string, text: string, images?: AgentImageAttachment[]): Promise<void> {
    const session = this.requireSession(panelId)
    await session.client.followUp(text, toImageContent(images))
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
    try { session.disposeAuthWatcher() } catch { /* noop */ }
    // RpcClient.pendingRequests is a Map<string, { resolve, reject }>. When we
    // kill the child, those promises will never resolve — so reject them now.
    const pending = (session.client as unknown as {
      pendingRequests?: Map<string, { reject: (err: Error) => void }>
    }).pendingRequests
    if (pending) {
      const err = new Error('Pi session disposed')
      for (const { reject } of pending.values()) {
        try { reject(err) } catch { /* noop */ }
      }
      pending.clear()
    }
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

  async getAvailableModels(
    panelId: string,
  ): Promise<Array<{ provider: string; id: string; contextWindow: number; reasoning: boolean }>> {
    const session = this.sessions.get(panelId)
    if (!session) return []
    try {
      return await session.client.getAvailableModels()
    } catch (err) {
      log.warn('[agentManager] getAvailableModels failed for %s: %O', panelId, err)
      return []
    }
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

  async setAutoRetry(panelId: string, enabled: boolean): Promise<void> {
    const session = this.requireSession(panelId)
    await session.client.setAutoRetry(enabled)
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

  async exportHtml(panelId: string, outputPath?: string): Promise<{ path: string }> {
    const session = this.requireSession(panelId)
    return session.client.exportHtml(outputPath)
  }

  async newSession(panelId: string, parentSession?: string): Promise<{ cancelled: boolean }> {
    const session = this.requireSession(panelId)
    return session.client.newSession(parentSession)
  }

  async switchSession(panelId: string, sessionPath: string): Promise<{ cancelled: boolean }> {
    const session = this.requireSession(panelId)
    return session.client.switchSession(sessionPath)
  }

  async fork(panelId: string, entryId: string): Promise<{ text: string; cancelled: boolean }> {
    const session = this.requireSession(panelId)
    return session.client.fork(entryId)
  }

  async clone(panelId: string): Promise<{ cancelled: boolean }> {
    const session = this.requireSession(panelId)
    return session.client.clone()
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

  async getLastAssistantText(panelId: string): Promise<string | null> {
    const session = this.sessions.get(panelId)
    if (!session) return null
    try {
      return await session.client.getLastAssistantText()
    } catch (err) {
      log.warn('[agentManager] getLastAssistantText failed for %s: %O', panelId, err)
      return null
    }
  }

  async setSessionName(panelId: string, name: string): Promise<void> {
    const session = this.requireSession(panelId)
    await session.client.setSessionName(name)
  }

  async getMessages(panelId: string): Promise<unknown[]> {
    const session = this.sessions.get(panelId)
    if (!session) return []
    try {
      return (await session.client.getMessages()) as unknown as unknown[]
    } catch (err) {
      log.warn('[agentManager] getMessages failed for %s: %O', panelId, err)
      return []
    }
  }

  // ---------------------------------------------------------------------------
  // Queue modes
  // ---------------------------------------------------------------------------

  async setSteeringMode(panelId: string, mode: 'all' | 'one-at-a-time'): Promise<void> {
    const session = this.requireSession(panelId)
    await session.client.setSteeringMode(mode)
  }

  async setFollowUpMode(panelId: string, mode: 'all' | 'one-at-a-time'): Promise<void> {
    const session = this.requireSession(panelId)
    await session.client.setFollowUpMode(mode)
  }

  // ---------------------------------------------------------------------------
  // Bash
  // ---------------------------------------------------------------------------

  async bash(panelId: string, command: string): Promise<unknown> {
    const session = this.requireSession(panelId)
    return session.client.bash(command)
  }

  async abortBash(panelId: string): Promise<void> {
    const session = this.requireSession(panelId)
    await session.client.abortBash()
  }

  // ---------------------------------------------------------------------------
  // Commands (skills / prompts / extensions)
  // ---------------------------------------------------------------------------

  async getCommands(panelId: string): Promise<AgentSlashCommand[]> {
    const session = this.sessions.get(panelId)
    if (!session) return []
    try {
      const commands = await session.client.getCommands()
      const homeAgent = agentDirFor(session.cwd) + path.sep
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
      writeRawToClient(session.client, { type: 'extension_ui_response', ...response })
    } catch (err) {
      log.warn('[agentManager] uiResponse failed for %s: %O', panelId, err)
    }
  }

  /** Tool gating is pi's responsibility now — this remains a no-op so the IPC
   *  surface stays compatible with the renderer until we wire up real
   *  preflight via pi's extension hooks. */
  async toolDecision(
    panelId: string,
    toolCallId: string,
    decision: 'allow' | 'deny',
    reason?: string,
  ): Promise<void> {
    log.debug(
      '[agentManager] tool decision (no-op) panel=%s tool=%s decision=%s reason=%s',
      panelId, toolCallId, decision, reason ?? '',
    )
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
