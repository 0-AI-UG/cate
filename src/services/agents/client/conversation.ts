// An agent's chat as a client shows it: the panel's `agents.conversation`
// channel, mirrored across reconnects. The conversation carries the agent's
// state read with its messages, so a turn that ended arrives with its reply,
// and the prompts on their way to the agent as the runtime keeps them
// (queued, sending, failed); the last one read stays while the workspace
// reconnects. Prompts are sent, queued and withdrawn through the agents
// capability; this only shows what the runtime says.

import { mirrorChannel, subscribeRuntimes, tryRuntimeFor, type ChannelMirror } from '@kernel/rpc/client'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import {
  applyAgentConversationChange,
  agentTaskText,
  type AgentConversation,
} from '../contract'

export interface AgentChatHandle {
  /** Null until it was first read. */
  get(): AgentConversation | null
  subscribe(listener: () => void): () => void
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
  let conversation: AgentConversation | null = null
  let runtime: RuntimeProxy | null = null
  let mirror: ChannelMirror<AgentConversation> | null = null

  const take = (next: AgentConversation) => {
    conversation = shown(next)
    for (const listener of [...listeners]) {
      try { listener() } catch { /* isolate listeners */ }
    }
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
    get: () => conversation,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    release() {
      stopRuntimes()
      mirror?.dispose()
      mirror = null
      listeners.clear()
    },
  }
}
