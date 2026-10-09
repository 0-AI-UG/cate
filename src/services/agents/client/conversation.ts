// An agent's chat as a client shows it: the panel's `agents.conversation`
// channel, mirrored across reconnects, and the prompt this client sent until
// the conversation has it. The conversation carries the agent's state read
// with its messages, so a turn that ended arrives with its reply; the last
// one read stays while the workspace reconnects.

import { mirrorChannel, subscribeRuntimes, tryRuntimeFor, type ChannelMirror } from '@kernel/rpc/client'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import {
  applyAgentConversationChange,
  agentTaskText,
  type AgentConversation,
} from '../contract'

export interface AgentChat {
  /** Null until it was first read. */
  conversation: AgentConversation | null
  /** A prompt sent from here that the conversation does not show yet. */
  pending: string | null
}

export interface AgentChatHandle {
  get(): AgentChat
  subscribe(listener: () => void): () => void
  /** A prompt went out: it shows as pending until the conversation has it. */
  sent(prompt: string): void
  /** The prompt did not go through. */
  unsent(): void
  release(): void
}

/** A task's first prompt reads as the person wrote it. */
function shown(conversation: AgentConversation): AgentConversation {
  if (!conversation.messages.some((message) => message.role === 'user' && message.text !== agentTaskText(message.text))) return conversation
  return {
    ...conversation,
    messages: conversation.messages.map((message) => message.role === 'user' ? { ...message, text: agentTaskText(message.text) } : message),
  }
}

export function watchAgentChat(workspaceId: string, panelId: string): AgentChatHandle {
  const listeners = new Set<() => void>()
  let chat: AgentChat = { conversation: null, pending: null }
  /** Messages there were when the pending prompt went out. */
  let pendingFrom = 0
  let runtime: RuntimeProxy | null = null
  let mirror: ChannelMirror<AgentConversation> | null = null

  const notify = () => {
    for (const listener of [...listeners]) {
      try { listener() } catch { /* isolate listeners */ }
    }
  }

  const take = (conversation: AgentConversation) => {
    const next = shown(conversation)
    const pending = chat.pending
    const arrived = pending !== null && next.messages.slice(pendingFrom).some((message) => message.role === 'user' && message.text.includes(pending))
    chat = { conversation: next, pending: arrived ? null : pending }
    notify()
  }

  const connect = () => {
    const next = tryRuntimeFor(workspaceId)
    if (next === runtime && (mirror || !next)) return
    mirror?.dispose()
    mirror = null
    runtime = next
    if (!next) return
    mirror = mirrorChannel(
      () => next.agents.conversation({ panelId }, { resume: true }),
      applyAgentConversationChange,
    )
    mirror.subscribe((state) => { if (state) take(state.snapshot) })
  }
  const stopRuntimes = subscribeRuntimes(connect)
  connect()

  return {
    get: () => chat,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    sent(prompt) {
      pendingFrom = chat.conversation?.messages.length ?? 0
      chat = { ...chat, pending: prompt }
      notify()
    },
    unsent() {
      if (chat.pending === null) return
      chat = { ...chat, pending: null }
      notify()
    },
    release() {
      stopRuntimes()
      mirror?.dispose()
      mirror = null
      listeners.clear()
    },
  }
}
