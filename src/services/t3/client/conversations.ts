// A checkout's T3 conversations over the `t3` capability, for the
// conversation pill and menu.

import type { CapabilityProxy } from '@kernel/rpc/contract'
import type { T3Conversation, t3Capability } from '../contract'

export interface T3ConversationSource {
  /** Newest first. */
  list(): Promise<T3Conversation[]>
  rename(threadId: string, title: string): Promise<void>
  remove(threadId: string): Promise<void>
}

type T3Proxy = Pick<CapabilityProxy<typeof t3Capability>, 'conversations' | 'renameConversation' | 'deleteConversation'>

export function t3Conversations(t3: T3Proxy, checkout: string | undefined): T3ConversationSource {
  return {
    async list() {
      const threads = await t3.conversations({ checkout })
      return [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },
    rename: (threadId, title) => t3.renameConversation({ checkout, threadId, title }),
    remove: (threadId) => t3.deleteConversation({ checkout, threadId }),
  }
}

/** Normalizes harness-owned UI copy. Never for user content or configuration. */
export function t3ProductCopy(text: string): string {
  return text.replace(/\bT3(?: Code|Code)?\b/g, 'T3 Code')
}
