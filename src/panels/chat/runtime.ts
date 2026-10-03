// What the daemon's composition root needs to register the chat panel type.
// Wiring: one `createChatBindings()` shared by every chat session and the
// agents service's t3 runner (`createT3Runner(agents, t3, bindings)`).

import type { PanelSessionClass, SessionKit } from '@panels/framework/runtime'
import type { PanelRecord } from '@workspace/document/contract'
import { chatDefinition } from './definition'
import { ChatSession, type ChatSessionDeps } from './session'

export { createChatBindings, type ChatBinding, type ChatBindings } from './parts/runtime/bindings'
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
