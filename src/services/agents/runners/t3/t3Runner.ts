// The t3 runner: an agent driven by the T3 harness in a chat panel, observed
// through T3 orchestration (thread shells). Plugs into the t3 service for
// thread state, prompt dispatch and change capture on harness start, so t3
// never imports agents.

import {
  canT3ThreadReceivePrompt,
  t3ThreadActivity,
  type T3CheckoutParams,
  type T3ConversationMessage,
  type T3ShellEvent,
  type T3ShellSnapshot,
  type T3Thread,
} from '@services/t3/contract'
import {
  AGENT_DEFS,
  agentAttentionNotification,
  agentIdForT3Provider,
  type AgentSendResult,
  type AgentSession,
  type AgentStatus,
  type PanelAgentState,
} from '../../contract'
import type { AgentsRuntime } from '../../runtime/agentsRuntime'
import type { AgentRunnerImpl } from '../../runtime/registry'

/** The part of the t3 service the runner uses. */
export interface RunnerT3Service {
  watchThreadShells(listener: (event: T3ShellEvent) => void): () => void
  readConversation(params: T3CheckoutParams & { threadId: string }): Promise<T3ConversationMessage[] | null>
  startTurn(params: T3CheckoutParams & { threadId: string; text: string }): Promise<void>
  interruptTurn(params: T3CheckoutParams & { threadId: string }): Promise<void>
}

/** Which thread each chat panel shows (chat panel session state). */
export interface T3PanelBindings {
  /** The checkout and thread a chat panel shows; a fresh chat has no thread. */
  binding(panelId: string): { checkout: string; threadId?: string } | undefined
  panelIds(): Iterable<string>
  onChange(listener: (panelId: string) => void): () => void
  /** A fresh chat's first prompt goes through its page composer, which holds
   *  the provider and model choice. */
  sendFresh?(panelId: string, prompt: string): Promise<boolean>
}

export interface T3Runner extends AgentRunnerImpl {
  readonly kind: 't3'
  /** Env for a starting harness so it reports its edits (change capture). */
  changeCaptureEnv(harness: { id: string; checkout: string }): Promise<Record<string, string>>
  /** The harness stopped. */
  releaseChangeCapture(id: string): void
  dispose(): void
}

type Attention = 'permission' | 'input' | 'idle' | 'running'

function attention(thread: T3Thread | undefined, status: AgentStatus | undefined): Attention | undefined {
  if (!thread || !status) return undefined
  if (thread.hasPendingApprovals) return 'permission'
  if (thread.hasPendingUserInput || thread.hasActionableProposedPlan) return 'input'
  return status === 'running' ? 'running' : 'idle'
}

export function createT3Runner(agents: AgentsRuntime, t3: RunnerT3Service, bindings: T3PanelBindings): T3Runner {
  const { hooks, document, notifications, promptContext } = agents
  /** Latest shell snapshot per checkout. */
  const shells = new Map<string, T3ShellSnapshot>()
  const listeners = new Set<(panelId: string) => void>()

  const threadOf = (panelId: string): { checkout: string; threadId?: string; thread?: T3Thread; connected: boolean } | undefined => {
    const binding = bindings.binding(panelId)
    if (!binding) return undefined
    const shell = shells.get(binding.checkout)
    return {
      ...binding,
      thread: binding.threadId ? shell?.threads[binding.threadId] : undefined,
      connected: shell?.connected === true,
    }
  }

  const agentOf = (thread: T3Thread | undefined) => {
    const provider = thread?.session?.providerName
    return provider ? agentIdForT3Provider(provider) : null
  }

  const state = (panelId: string): PanelAgentState | null => {
    const bound = threadOf(panelId)
    if (!bound || (!bound.connected && !bound.thread)) return null
    const status: AgentStatus = bound.thread ? t3ThreadActivity(bound.thread) : 'notRunning'
    const agentId = agentOf(bound.thread)
    const worktreeId = document.panel(panelId)?.worktreeId
    // A bound thread must be in the snapshot so its state is known; a panel
    // with no thread is a fresh chat whose first prompt creates one.
    const canReceivePrompt = bound.connected && (bound.threadId
      ? !!bound.thread && canT3ThreadReceivePrompt(bound.thread)
      : true)
    const session: AgentSession | null = bound.threadId
      ? { agentId, runner: 't3', sessionId: bound.threadId, cwd: bound.checkout, ...(worktreeId ? { worktreeId } : {}) }
      : null
    return {
      panelId,
      runner: 't3',
      agentId,
      // Like a terminal, name the agent CLI running the conversation; T3
      // itself is the fallback until the thread's provider is known.
      agentName: agentId ? AGENT_DEFS[agentId].displayName : 'T3 Code',
      status,
      present: bound.connected,
      canReceivePrompt,
      session,
    }
  }

  const notify = (panelId: string): void => {
    for (const listener of listeners) listener(panelId)
  }

  const onShells = (event: T3ShellEvent): void => {
    if (event.kind !== 'snapshot') return
    const { snapshot } = event
    const previous = shells.get(snapshot.checkout)
    if (previous && previous.sequence > snapshot.sequence) return
    const before = new Map<string, { thread?: T3Thread; status?: AgentStatus }>()
    for (const panelId of bindings.panelIds()) {
      const bound = threadOf(panelId)
      if (bound?.checkout !== snapshot.checkout) continue
      before.set(panelId, { thread: bound.thread, status: bound.thread ? t3ThreadActivity(bound.thread) : undefined })
    }
    shells.set(snapshot.checkout, snapshot)
    for (const [panelId, was] of before) {
      const bound = threadOf(panelId)
      const thread = bound?.thread
      notify(panelId)
      if (!thread || thread === was.thread) continue
      if (thread.title && thread.title !== was.thread?.title) document.setTitleFromAgent(panelId, thread.title)
      const from = attention(was.thread, was.status)
      const to = attention(thread, t3ThreadActivity(thread))
      if (!from || from === to || !(to === 'permission' || to === 'input' || (to === 'idle' && from === 'running'))) continue
      const agentId = agentOf(thread)
      notifications.publish(agentAttentionNotification({
        panelId,
        agentName: agentId ? AGENT_DEFS[agentId].displayName : 'T3 Code',
        ...(to === 'permission' ? { permission: 'Waiting for your approval.' } : {}),
      }))
    }
  }

  const offShells = t3.watchThreadShells(onShells)
  const offBindings = bindings.onChange(notify)

  return {
    kind: 't3',
    state,
    panelIds: () => bindings.panelIds(),
    async send(panelId, prompt): Promise<AgentSendResult> {
      const bound = threadOf(panelId)
      if (!bound || !bound.connected || (bound.threadId && !bound.thread)) return { ok: false, error: 'agent-not-running' }
      if (bound.thread && !canT3ThreadReceivePrompt(bound.thread)) return { ok: false, error: 'agent-busy' }
      if (!bound.threadId) {
        const sent = await bindings.sendFresh?.(panelId, prompt).catch(() => false)
        return sent ? { ok: true } : { ok: false, error: 'agent-panel-unavailable' }
      }
      let context: string | null
      try {
        context = await promptContext.prepareForSend(panelId, agentOf(bound.thread))
      } catch {
        return { ok: false, error: 'editor-sync-failed' }
      }
      try {
        await t3.startTurn({ checkout: bound.checkout, threadId: bound.threadId, text: context ? `${prompt}\n\n${context}` : prompt })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error && err.message === 'agent-busy' ? 'agent-busy' : 'agent-panel-unavailable' }
      }
    },
    async interrupt(panelId): Promise<AgentSendResult> {
      const bound = threadOf(panelId)
      if (!bound?.threadId || !bound.connected) return { ok: false, error: 'agent-not-running' }
      try {
        await t3.interruptTurn({ checkout: bound.checkout, threadId: bound.threadId })
        return { ok: true }
      } catch {
        return { ok: false, error: 'agent-panel-unavailable' }
      }
    },
    async conversation(panelId) {
      const session = state(panelId)?.session
      if (!session) return null
      const messages = await t3.readConversation({ checkout: session.cwd, threadId: session.sessionId })
      return messages ? { session, messages } : null
    },
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async changeCaptureEnv(harness) {
      hooks.registerChangeSource(harness.id, { cwd: harness.checkout, kind: 't3' })
      const endpoint = await hooks.endpoint()
      return {
        CATE_CHANGES_ENDPOINT: endpoint.url,
        CATE_CHANGES_TOKEN: endpoint.tokenFor(harness.id),
        CATE_CHANGES_SOURCE: harness.id,
      }
    },
    releaseChangeCapture(id) {
      hooks.unregisterChangeSource(id)
    },
    dispose() {
      offShells()
      offBindings()
    },
  }
}
