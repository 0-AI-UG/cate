import path from 'node:path'
import type { AgentSessionContext, AgentSessionStores } from '../sessions/types'
import { findInWorkspaceBuckets } from '../sessions/storeFiles'

/** Native Grok logins keep their normal home. API provider launches share only a
 * separate transcript root; each launch configuration has its own config files. */
export function withManagedAgentStores(stores: AgentSessionStores, agentsDir: string): AgentSessionStores {
  const root = path.join(agentsDir, 'grok-sessions')
  const base = stores.grok
  const contextFor = async (context: AgentSessionContext): Promise<AgentSessionContext> => {
    if (context.session.transcriptPath) return context
    const transcriptPath = await findInWorkspaceBuckets(root, context.session.sessionId, path.join(context.session.sessionId, 'updates.jsonl'))
    return transcriptPath ? { ...context, session: { ...context.session, transcriptPath } } : context
  }
  const source = base.usage.source
  return { ...stores, grok: {
    ...base,
    title: async (context) => base.title(await contextFor(context)),
    conversation: async (context) => base.conversation(await contextFor(context)),
    files: async (context) => base.files?.(await contextFor(context)) ?? [],
    usage: { ...base.usage, source: source.kind === 'transcripts' ? { ...source, additionalRoots: () => [root] } : source },
  } }
}
