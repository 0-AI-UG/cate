// The agents service core (architecture 10.3): hook ingestion, pid presence,
// change history, prompt context, the terminal agents (terminal.ts), the
// panel states over them and the prompts on their way to them (prompts.ts). Agents publish their notification events through
// the workspace's notifications.

import type { RelationRoleOf } from '@workspace/relations/contract'
import path from 'node:path'
import type { Logger } from '@kernel/log/contract'
import type {
  AgentChangesSnapshot,
  AgentConversationMessage,
  AgentPrompt,
  AgentHookAgentState,
  AgentHookConfig,
  AgentSendResult,
  AgentSession,
  AgentStep,
  PanelAgentState,
  UsageModelPriceOverride,
} from '../contract'
import type { StoredAgentChange } from './changes/store'
import { createAgentHooks, type AgentHooks, type AgentHooksDeps } from './hooks/agentHooks'
import { createAgentPresenceTracker, type AgentPresenceTracker, type ProcTree } from './presence'
import { createAgentPanels, type AgentPanels, type AgentPanelSource } from './panels'
import type { NotificationEvent } from '@workspace/notifications/contract'
import { createAgentConversations, type AgentConversations } from './conversations'
import { createAgentPrompts, type AgentPrompts } from './prompts'
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
  usagePriceOverrides(): Readonly<Record<string, UsageModelPriceOverride>>
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
  /** Flushes editors connected to a panel before its prompt is sent. */
  flushConnected?(panelId: string): Promise<void>
  /** Each panel type's relation role, for prompt context. */
  relationRole: RelationRoleOf
  log?: Logger
  /** Tests: the host home dir and hook internals. */
  homeDir?: string
  hookOptions?: Partial<Pick<AgentHooksDeps, 'nodePath' | 'interruptPollMs' | 'sessionStores' | 'titleRetryDelaysMs'>>
  isAlive?: (pid: number) => boolean
}

/** What the terminal agents (terminal.ts) are built from. */
export interface AgentsBase {
  readonly root: string
  readonly settings: AgentsSettingsReader
  readonly document: AgentsDocument
  readonly hooks: AgentHooks
  readonly presence: AgentPresenceTracker
  readonly notifications: { publish(event: NotificationEvent): void }
  readonly promptContext: PromptContext
}

/** What the core asks of the terminal agents. */
export interface AgentTerminals extends AgentPanelSource {
  /** Submits a prompt as the user would, with files that go with it. */
  send(panelId: string, prompt: string, attachments?: readonly string[]): Promise<AgentSendResult>
  /** Stops the agent's turn as the person would (Esc, Ctrl-C). */
  interrupt(panelId: string): Promise<AgentSendResult>
  conversation(panelId: string): Promise<{ session: AgentSession; messages: AgentConversationMessage[] } | null>
  /** Changes whenever the conversation may have (the session store's file
   *  times), or null when it cannot tell, so it is read on every look. */
  conversationStamp(panelId: string): Promise<string | null>
  /** A panel's agent completed a tool call (its hooks reported it). */
  onStep(listener: (panelId: string, step: AgentStep) => void): () => void
  dispose(): void
}

export interface AgentsCore extends AgentsBase {
  readonly trust: TrustGate
  readonly terminals: AgentTerminals
  readonly panels: AgentPanels
  readonly conversations: AgentConversations
  readonly prompts: AgentPrompts
  resolveCheckout(cwd: string | undefined): Promise<string>
  inspectHooks(cwd?: string): Promise<AgentHookAgentState[]>
  panel(panelId: string): PanelAgentState | null
  /** Hands a prompt to the panel's prompts (prompts.ts): it goes out once
   *  the agent can take one. The caller checked that an agent is there. */
  send(panelId: string, prompt: string, attachments?: readonly string[]): AgentPrompt
  /** Takes back a queued or failed prompt; null when there is none. */
  withdraw(panelId: string, promptId: string): { prompt: string; attachments: string[] } | null
  /** Stops the turn of the panel's agent. */
  interrupt(panelId: string): Promise<AgentSendResult>
  /** Panels whose agent is running a turn. */
  busy(): string[]
  /** Panels an agent is present in, busy or not. */
  hosting(): string[]
  /** Recorded agent edits in a checkout, each with the panels that showed
   *  its session; an unchanged revision omits records. */
  changes(cwd: string, knownRevision?: string): Promise<AgentChangesSnapshot>
  dispose(): void
}

export function createAgentsCore(deps: AgentsCoreDeps, createTerminals: (base: AgentsBase) => AgentTerminals): AgentsCore {
  const presence = createAgentPresenceTracker({ snapshot: deps.snapshot, isAlive: deps.isAlive })
  const hooks = createAgentHooks({
    hooksDir: path.join(deps.agentsDir, 'hooks'),
    changesDir: path.join(deps.agentsDir, 'changes'),
    homeDir: deps.homeDir,
    ...deps.hookOptions,
    onPost: ({ terminalId, agentId, pid }) =>
      presence.notePost(terminalId, agentId, pid),
    onChangeError: (error) => deps.log?.warn('could not save a reported agent edit', error),
  })
  const notifications = { publish: (event: NotificationEvent) => deps.notify(event) }
  const promptContext = createPromptContext({
    document: deps.document,
    relationsEnabled: () => deps.settings.panelRelationsEnabled(),
    relationRole: deps.relationRole,
    flushConnected: deps.flushConnected,
  })
  const base: AgentsBase = { root: deps.root, settings: deps.settings, document: deps.document, hooks, presence, notifications, promptContext }
  const terminals = createTerminals(base)
  const panels = createAgentPanels(terminals, { contextSentAt: (panelId) => promptContext.sentAt(panelId) })
  promptContext.onSent((panelId) => panels.refresh(panelId))
  const prompts = createAgentPrompts({ panels, terminals })
  const conversations = createAgentConversations({ panels, terminals, prompts })

  const resolve = ({ terminalId: _terminalId, panelId, ...rest }: StoredAgentChange) => ({ ...rest, panelIds: panelId ? [panelId] : [] })
  const changes = async (cwd: string, knownRevision?: string): Promise<AgentChangesSnapshot> => {
    const snapshot = await hooks.readChanges(await deps.resolveCheckout(cwd), knownRevision)
    return snapshot.records ? { revision: snapshot.revision, records: snapshot.records.map(resolve) } : { revision: snapshot.revision }
  }

  return {
    ...base,
    trust: deps.trust,
    terminals,
    panels,
    conversations,
    prompts,
    resolveCheckout: (cwd) => deps.resolveCheckout(cwd),
    async inspectHooks(cwd) {
      deps.trust.requireTrusted()
      return hooks.inspectWorkspace(await deps.resolveCheckout(cwd), { approvals: true })
    },
    panel: (panelId) => panels.state(panelId),
    send(panelId, prompt, attachments) {
      deps.trust.requireTrusted()
      return prompts.send(panelId, prompt, attachments)
    },
    withdraw(panelId, promptId) {
      deps.trust.requireTrusted()
      return prompts.withdraw(panelId, promptId)
    },
    async interrupt(panelId) {
      deps.trust.requireTrusted()
      if (!panels.state(panelId)) return { ok: false, error: 'agent-panel-not-found' }
      return terminals.interrupt(panelId)
    },
    busy: () => Object.values(panels.all()).filter((state) => state.status === 'running').map((state) => state.panelId),
    hosting: () => Object.values(panels.all()).filter((state) => state.present).map((state) => state.panelId),
    changes,
    dispose() {
      conversations.dispose()
      prompts.dispose()
      panels.dispose()
      terminals.dispose()
      hooks.dispose()
    },
  }
}
