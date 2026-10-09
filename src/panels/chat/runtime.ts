// What the daemon's composition root needs to register the chat panel type,
// and the chat threads the agents service's t3 runner reads
// (`createT3Runner(agents, t3, createChatThreads(...))`).

import type { PanelSessionClass, SessionKit } from '@panels/framework/runtime'
import type { PanelRecord } from '@workspace/document/contract'
import { chatDefinition } from './definition'
import { ChatSession, type ChatSessionDeps } from './session'

export { createChatThreads, type ChatThreads, type ChatThreadsDeps } from './parts/runtime/threads'
export { ChatSession, type ChatSessionDeps, type ChatT3Service, type ChatChangesFeed } from './session'
export { chatDefinition }

/** The registry entry: `registry.register(entry.definition, entry.session)`. */
export function chatPanel(deps: ChatSessionDeps): { definition: typeof chatDefinition; session: PanelSessionClass } {
  class BoundChatSession extends ChatSession {
    constructor(kit: SessionKit, record: PanelRecord) {
      super(kit, record, deps)
    }
  }
  return { definition: chatDefinition, session: BoundChatSession as unknown as PanelSessionClass }
}
