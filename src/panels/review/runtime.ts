// What the daemon's composition root needs to register the review type.

import type { PanelRecord } from '@workspace/document/contract'
import type { PanelSessionClass, SessionKit } from '@panels/framework/runtime'
import definition from './definition'
import { ReviewSession, type ReviewSessionDeps } from './session'

export { definition as reviewDefinition }
export {
  ReviewSession,
  type ReviewAgentRunInfo,
  type ReviewAgents,
  type ReviewFiles,
  type ReviewRepository,
  type ReviewSessionDeps,
} from './session'

/** The registry entry: `registry.register(entry.definition, entry.session)`. */
export function reviewPanel(deps: ReviewSessionDeps): { definition: typeof definition; session: PanelSessionClass } {
  class BoundReviewSession extends ReviewSession {
    constructor(kit: SessionKit, record: PanelRecord) {
      super(kit, record, deps)
    }
  }
  return { definition, session: BoundReviewSession as unknown as PanelSessionClass }
}
