// Agent chats in the app (`agents.watch`): each follows a panel's agent
// conversation (`watchAgentChat`) and tells the app what changed as
// `conversation` view events: the agent's state, the pending and queued
// prompts, the messages from the first one that changed, so the app redraws
// only those, and where the steps show (`agentStepGroups`).

import { watchAgentChat, type AgentChat, type AgentChatHandle } from '@services/agents/client'
import { agentActivity, agentStepGroups, diffAgentConversation } from '@services/agents/contract'
import type { MobileBridge, MobileViewEvent } from '../contract'

export interface MobileConversations {
  watch(params: { viewId: string; workspaceId: string; panelId: string; pending?: string }): void
  unwatch(viewId: string): void
  /** The chat's prompt went out (`sent`) or did not go through. */
  sent(viewId: string, prompt: string): void
  unsent(viewId: string): void
  /** A prompt that goes out once the agent can take it. */
  queue(viewId: string, prompt: string): void
  unqueue(viewId: string): string | null
}

export function createMobileConversations(bridge: MobileBridge): MobileConversations {
  const watches = new Map<string, AgentChatHandle>()

  return {
    watch({ viewId, workspaceId, panelId, pending }) {
      watches.get(viewId)?.release()
      const handle = watchAgentChat(workspaceId, panelId)
      watches.set(viewId, handle)
      let shown: AgentChat = { conversation: null, pending: null, queued: null }
      let shownSteps = ''
      const emit = (event: MobileViewEvent) => {
        void bridge('view.event', { viewId, json: JSON.stringify(event) }).catch(() => {})
      }
      handle.subscribe(() => {
        const next = handle.get()
        const before = shown
        shown = next
        const prompts = next.pending !== before.pending || next.queued !== before.queued
        if (!next.conversation) {
          if (prompts) {
            emit({
              kind: 'conversation', status: null, canReceivePrompt: false, pending: next.pending, queued: next.queued,
              from: 0, messages: [], steps: null,
            })
          }
          return
        }
        const steps = { groups: agentStepGroups(next.conversation), activity: agentActivity(next.conversation) }
        const stepsJson = JSON.stringify(steps)
        const stepsChanged = stepsJson !== shownSteps
        shownSteps = stepsJson
        const change = before.conversation ? diffAgentConversation(before.conversation, next.conversation) : null
        if (before.conversation && !change && !prompts && !stepsChanged) return
        const from = before.conversation ? change?.from ?? next.conversation.messages.length : 0
        emit({
          kind: 'conversation',
          status: next.conversation.status,
          canReceivePrompt: next.conversation.canReceivePrompt,
          pending: next.pending,
          queued: next.queued,
          from,
          messages: next.conversation.messages.slice(from),
          steps: stepsChanged ? steps : null,
        })
      })
      if (pending) handle.sent(pending)
    },
    unwatch(viewId) {
      watches.get(viewId)?.release()
      watches.delete(viewId)
    },
    sent: (viewId, prompt) => watches.get(viewId)?.sent(prompt),
    unsent: (viewId) => watches.get(viewId)?.unsent(),
    queue: (viewId, prompt) => watches.get(viewId)?.queue(prompt),
    unqueue: (viewId) => watches.get(viewId)?.unqueue() ?? null,
  }
}
