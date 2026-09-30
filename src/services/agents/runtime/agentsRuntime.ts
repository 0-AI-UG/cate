// The agents service core (architecture 10.4): hook ingestion, pid presence,
// change history, the runner registry, prompt context and notifications.
// Runners (runners/terminal, runners/t3) and missions plug into it.

import type { RelationRoleOf } from '@workspace/relations/contract'
import path from 'node:path'
import type { Logger } from '@kernel/log/contract'
import type { AgentHookAgentState, AgentHookConfig, AgentSendResult, PanelAgentState } from '../contract'
import { createAgentHooks, type AgentHooks, type AgentHooksDeps } from './hooks/agentHooks'
import { createAgentPresenceTracker, type AgentPresenceTracker, type ProcTree } from './presence'
import { createRunnerRegistry, type RunnerRegistry } from './registry'
import { createAgentNotifications, type AgentNotifications } from './notifications'
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

export interface AgentsRuntimeDeps {
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
  /** A fresh process-table snapshot (the terminal service's scanner). */
  snapshot(): Promise<ProcTree>
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

export interface AgentsRuntime {
  readonly root: string
  readonly trust: TrustGate
  readonly settings: AgentsSettingsReader
  readonly document: AgentsDocument
  readonly hooks: AgentHooks
  readonly presence: AgentPresenceTracker
  readonly registry: RunnerRegistry
  readonly notifications: AgentNotifications
  readonly promptContext: PromptContext
  resolveCheckout(cwd: string | undefined): Promise<string>
  inspectHooks(cwd?: string): Promise<AgentHookAgentState[]>
  panel(panelId: string): PanelAgentState | null
  send(panelId: string, prompt: string): Promise<AgentSendResult>
  /** Panels whose agent is running a turn. */
  busy(): string[]
  dispose(): void
}

export function createAgentsRuntime(deps: AgentsRuntimeDeps): AgentsRuntime {
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
  const registry = createRunnerRegistry()
  const notifications = createAgentNotifications()
  const promptContext = createPromptContext({
    document: deps.document,
    relationsEnabled: () => deps.settings.panelRelationsEnabled(),
    relationRole: deps.relationRole,
    flushConnected: deps.flushConnected,
  })

  return {
    root: deps.root,
    trust: deps.trust,
    settings: deps.settings,
    document: deps.document,
    hooks,
    presence,
    registry,
    notifications,
    promptContext,
    resolveCheckout: (cwd) => deps.resolveCheckout(cwd),
    async inspectHooks(cwd) {
      // Inspection runs the Hermes CLI for its plugin state.
      deps.trust.requireTrusted()
      return hooks.inspectWorkspace(await deps.resolveCheckout(cwd))
    },
    panel: (panelId) => registry.sessionFor(panelId),
    async send(panelId, prompt) {
      deps.trust.requireTrusted()
      const runner = registry.runnerFor(panelId)
      if (!runner) return { ok: false, error: 'agent-panel-not-found' }
      return runner.send(panelId, prompt)
    },
    busy: () => Object.values(registry.all()).filter((state) => state.status === 'running').map((state) => state.panelId),
    dispose() {
      hooks.dispose()
    },
  }
}
