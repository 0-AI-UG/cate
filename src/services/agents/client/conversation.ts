// An agent's chat as a client shows it: the panel's `agents.conversation`
// channel, mirrored across reconnects, and the prompt this client sent until
// the conversation has it. The conversation carries the agent's state read
// with its messages, so a turn that ended arrives with its reply; the last
// one read stays while the workspace reconnects. A prompt queued while the
// agent works goes out once the agent is at its prompt again.

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
  /** A prompt waiting for the agent to be at its prompt. */
  queued: string | null
}

export interface AgentChatHandle {
  get(): AgentChat
  subscribe(listener: () => void): () => void
  /** A prompt went out: it shows as pending until the conversation has it. */
  sent(prompt: string): void
  /** The prompt did not go through. */
  unsent(): void
  /** Sends `prompt` once the agent can take it (replacing one queued). */
  queue(prompt: string): void
  /** Takes the queued prompt back; null when none waits. */
  unqueue(): string | null
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
  let chat: AgentChat = { conversation: null, pending: null, queued: null }
  /** Messages there were when the pending prompt went out. */
  let pendingFrom = 0
  let runtime: RuntimeProxy | null = null
  let mirror: ChannelMirror<AgentConversation> | null = null

  const notify = () => {
    for (const listener of [...listeners]) {
      try { listener() } catch { /* isolate listeners */ }
    }
  }

  const sent = (prompt: string) => {
    pendingFrom = chat.conversation?.messages.length ?? 0
    chat = { ...chat, pending: prompt }
    notify()
  }

  /** The queued prompt goes out when the agent can take it; back in the
   *  queue when it did not go through. */
  const flush = () => {
    const prompt = chat.queued
    if (prompt === null || !runtime || chat.pending !== null || !chat.conversation?.canReceivePrompt) return
    const target = runtime
    chat = { ...chat, queued: null }
    sent(prompt)
    target.agents.send({ panelId, prompt }).catch(() => {
      chat = { ...chat, pending: chat.pending === prompt ? null : chat.pending, queued: chat.queued ?? prompt }
      notify()
    })
  }

  const take = (conversation: AgentConversation) => {
    const next = shown(conversation)
    const pending = chat.pending
    const arrived = pending !== null && next.messages.slice(pendingFrom).some((message) => message.role === 'user' && message.text.includes(pending))
    chat = { ...chat, conversation: next, pending: arrived ? null : pending }
    notify()
    flush()
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
    sent,
    unsent() {
      if (chat.pending === null) return
      chat = { ...chat, pending: null }
      notify()
    },
    queue(prompt) {
      chat = { ...chat, queued: prompt }
      notify()
      flush()
    },
    unqueue() {
      const prompt = chat.queued
      if (prompt === null) return null
      chat = { ...chat, queued: null }
      notify()
      return prompt
    },
    release() {
      stopRuntimes()
      mirror?.dispose()
      mirror = null
      listeners.clear()
    },
  }
}
