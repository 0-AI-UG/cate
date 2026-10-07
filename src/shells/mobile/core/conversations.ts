// Agent chats in the app (`agents.watch`): each follows a panel's agent
// conversation (`watchAgentChat`) and tells the app what changed as
// `conversation` view events: the agent's state, the pending prompt, and the
// messages from the first one that changed, so the app redraws only those.

import { watchAgentChat, type AgentChat, type AgentChatHandle } from '@services/agents/client'
import { diffAgentConversation } from '@services/agents/contract'
import type { MobileBridge, MobileViewEvent } from '../contract'

export interface MobileConversations {
  watch(params: { viewId: string; workspaceId: string; panelId: string; pending?: string }): void
  unwatch(viewId: string): void
  /** The chat's prompt went out (`sent`) or did not go through. */
  sent(viewId: string, prompt: string): void
  unsent(viewId: string): void
}

export function createMobileConversations(bridge: MobileBridge): MobileConversations {
  const watches = new Map<string, AgentChatHandle>()

  return {
    watch({ viewId, workspaceId, panelId, pending }) {
      watches.get(viewId)?.release()
      const handle = watchAgentChat(workspaceId, panelId)
      watches.set(viewId, handle)
      let shown: AgentChat = { conversation: null, pending: null }
      const emit = (event: MobileViewEvent) => {
        void bridge('view.event', { viewId, json: JSON.stringify(event) }).catch(() => {})
      }
      handle.subscribe(() => {
        const next = handle.get()
        const before = shown
        shown = next
        if (!next.conversation) {
          if (next.pending !== before.pending) emit({ kind: 'conversation', status: null, canReceivePrompt: false, pending: next.pending, from: 0, messages: [] })
          return
        }
        const change = before.conversation ? diffAgentConversation(before.conversation, next.conversation) : null
        if (before.conversation && !change && next.pending === before.pending) return
        const from = before.conversation ? change?.from ?? next.conversation.messages.length : 0
        emit({
          kind: 'conversation',
          status: next.conversation.status,
          canReceivePrompt: next.conversation.canReceivePrompt,
          pending: next.pending,
          from,
          messages: next.conversation.messages.slice(from),
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
  }
}
