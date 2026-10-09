// The agents service core (architecture 10.4): hook ingestion, pid presence,
// change history, the runner registry and prompt context. Agents publish
// their notification events through the workspace's notifications.
// Runners (runners/terminal, runners/t3) plug into it.

import type { RelationRoleOf } from '@workspace/relations/contract'
import path from 'node:path'
import type { Logger } from '@kernel/log/contract'
import {
  activeAgentChanges,
  summarizeAgentChanges,
  type AgentChangesSnapshot,
  type AgentHookAgentState,
  type AgentHookConfig,
  type AgentSendResult,
  type AgentSessionChanges,
  type PanelAgentState,
} from '../contract'
import type { StoredAgentChange } from './changes/store'
import { createAgentHooks, type AgentHooks, type AgentHooksDeps } from './hooks/agentHooks'
import { createAgentPresenceTracker, type AgentPresenceTracker, type ProcTree } from './presence'
import { createRunnerRegistry, type RunnerRegistry } from './registry'
import type { NotificationEvent } from '@workspace/notifications/contract'
import { createAgentConversations, type AgentConversations } from './conversations'
import { createPromptContext, type AgentsDocument, type PromptContext } from './promptContext'

export interface TrustGate {
  isTrusted(): boolean
  /** Throws `RpcError('untrusted')`. */
  requireTrusted(): void
}

/** The workspace settings the agents service reads. */
export interface AgentsSettingsReader {
  agentHookInjection(): AgentHookConfig
  panelRelationsEnabled(): boolean
}

export interface AgentsCoreDeps {
  /** Canonical workspace root. */
  root: string
  /** `dataPaths(dataDir).agents`: holds `hooks/` and `changes/`. */
  agentsDir: string
  trust: TrustGate
  settings: AgentsSettingsReader
  document: AgentsDocument
  /** Canonicalizes a checkout (the root when omitted) and refuses anything but
   *  the root or one of its worktree checkouts. */
  resolveCheckout(cwd: string | undefined): Promise<string>
  /** Publishes a notification event (the workspace's notifications). */
  notify(event: NotificationEvent): void
  /** A fresh process-table snapshot (the terminal service's scanner). */
  snapshot(): Promise<ProcTree>
  /** A checkout's git status: now, then on every change (the repository's
   *  monitors), so recorded changes still in the checkout can be told. */
  watchStatus(cwd: string, listener: (status: { isRepo: boolean; files: readonly { path: string }[] }) => void): () => void
  /** Flushes editors connected to a panel before its prompt is sent. */
  flushConnected?(panelId: string): Promise<void>
  /** Each panel type's relation role, for prompt context. */
  relationRole: RelationRoleOf
  log?: Logger
  /** Tests: the host home dir and hook internals. */
  homeDir?: string
  hookOptions?: Partial<Pick<AgentHooksDeps, 'nodePath' | 'interruptPollMs' | 'sessionStores' | 'titleRetryDelaysMs' | 'externalPlugins'>>
  isAlive?: (pid: number) => boolean
}

export interface AgentsCore {
  readonly root: string
  readonly trust: TrustGate
  readonly settings: AgentsSettingsReader
  readonly document: AgentsDocument
  readonly hooks: AgentHooks
  readonly presence: AgentPresenceTracker
  readonly registry: RunnerRegistry
  readonly notifications: { publish(event: NotificationEvent): void }
  readonly conversations: AgentConversations
  readonly promptContext: PromptContext
  resolveCheckout(cwd: string | undefined): Promise<string>
  inspectHooks(cwd?: string): Promise<AgentHookAgentState[]>
  panel(panelId: string): PanelAgentState | null
  send(panelId: string, prompt: string): Promise<AgentSendResult>
  /** Stops the turn of the panel's agent. */
  interrupt(panelId: string): Promise<AgentSendResult>
  /** Panels whose agent is running a turn. */
  busy(): string[]
  /** Recorded agent edits in a checkout, each with the panels that showed
   *  its session; an unchanged revision omits records. */
  changes(cwd: string, knownRevision?: string): Promise<AgentChangesSnapshot>
  /** Per-turn summaries of the panel's current session's edits still changed
   *  in its checkout: now, then whenever they may have changed. Null while
   *  the panel has no session. */
  watchChanges(panelId: string, listener: (changes: AgentSessionChanges | null) => void): () => void
  dispose(): void
}

export function createAgentsCore(deps: AgentsCoreDeps): AgentsCore {
  const presence = createAgentPresenceTracker({ snapshot: deps.snapshot, isAlive: deps.isAlive })
  const hooks = createAgentHooks({
    hooksDir: path.join(deps.agentsDir, 'hooks'),
    changesDir: path.join(deps.agentsDir, 'changes'),
    homeDir: deps.homeDir,
    ...deps.hookOptions,
    onPost: ({ terminalId, agentId, pid, sourceStartedAt }) =>
      presence.notePost(terminalId, agentId, pid, sourceStartedAt),
    onChangeError: (error) => deps.log?.warn('could not save a reported agent edit', error),
  })
  const notifications = { publish: (event: NotificationEvent) => deps.notify(event) }
  const promptContext = createPromptContext({
    document: deps.document,
    relationsEnabled: () => deps.settings.panelRelationsEnabled(),
    relationRole: deps.relationRole,
    flushConnected: deps.flushConnected,
  })
  const registry = createRunnerRegistry({ contextSentAt: (panelId) => promptContext.sentAt(panelId) })
  promptContext.onSent((panelId) => registry.refresh(panelId))
  const conversations = createAgentConversations({ registry })

  const resolve = (record: StoredAgentChange) => {
    const { source: _source, sourceId: _sourceId, panelId: _panelId, panelIds: _panelIds, ...rest } = record
    return { ...rest, panelIds: registry.changePanels(record) }
  }
  const changes = async (cwd: string, knownRevision?: string): Promise<AgentChangesSnapshot> => {
    const snapshot = await hooks.readChanges(await deps.resolveCheckout(cwd), knownRevision)
    return snapshot.records ? { revision: snapshot.revision, records: snapshot.records.map(resolve) } : { revision: snapshot.revision }
  }

  const watchChanges = (panelId: string, listener: (changes: AgentSessionChanges | null) => void): (() => void) => {
    let stopped = false
    let session: { sessionId: string; cwd: string } | null = null
    let stopStatus: (() => void) | undefined
    let revision: string | undefined
    let records: StoredAgentChange[] = []
    let pending = Promise.resolve()
    const read = (status: { isRepo: boolean; files: readonly { path: string }[] }, current: { sessionId: string; cwd: string }) => {
      pending = pending.then(async () => {
        try {
          const snapshot = await hooks.readChanges(await deps.resolveCheckout(current.cwd), revision)
          if (snapshot.records) records = snapshot.records
          revision = snapshot.revision
        } catch {
          return
        }
        if (stopped || session !== current) return
        const mine = activeAgentChanges(records, { isRepo: status.isRepo, statusFiles: status.files })
          .filter((record) => (record.sessionId === current.sessionId || record.parentSessionId === current.sessionId)
            && registry.changePanels(record).includes(panelId))
        const turns = [...new Set(mine.map((record) => record.turnId))]
        listener({
          sessionId: current.sessionId,
          turns: Object.fromEntries(turns.map((turnId) => [turnId, summarizeAgentChanges(mine.filter((record) => record.turnId === turnId))])),
        })
      })
    }
    // Follows the panel's session; a new one starts from a fresh read.
    const follow = () => {
      const next = registry.sessionFor(panelId)?.session ?? null
      if (next?.sessionId === session?.sessionId && next?.cwd === session?.cwd) return
      stopStatus?.()
      stopStatus = undefined
      revision = undefined
      records = []
      session = next ? { sessionId: next.sessionId, cwd: next.cwd } : null
      listener(null)
      const current = session
      if (current) stopStatus = deps.watchStatus(current.cwd, (status) => read(status, current))
    }
    const offRegistry = registry.subscribe((change) => { if (panelId in change) follow() })
    follow()
    return () => {
      stopped = true
      offRegistry()
      stopStatus?.()
    }
  }

  return {
    root: deps.root,
    trust: deps.trust,
    settings: deps.settings,
    document: deps.document,
    hooks,
    presence,
    registry,
    notifications,
    conversations,
    promptContext,
    resolveCheckout: (cwd) => deps.resolveCheckout(cwd),
    async inspectHooks(cwd) {
      // Inspection runs the Hermes CLI for its plugin state.
      deps.trust.requireTrusted()
      return hooks.inspectWorkspace(await deps.resolveCheckout(cwd), { approvals: true })
    },
    panel: (panelId) => registry.sessionFor(panelId),
    async send(panelId, prompt) {
      deps.trust.requireTrusted()
      const runner = registry.runnerFor(panelId)
      if (!runner) return { ok: false, error: 'agent-panel-not-found' }
      return runner.send(panelId, prompt)
    },
    async interrupt(panelId) {
      deps.trust.requireTrusted()
      const runner = registry.runnerFor(panelId)
      if (!runner) return { ok: false, error: 'agent-panel-not-found' }
      return runner.interrupt(panelId)
    },
    busy: () => Object.values(registry.all()).filter((state) => state.status === 'running').map((state) => state.panelId),
    changes,
    watchChanges,
    dispose() {
      conversations.dispose()
      hooks.dispose()
    },
  }
}
