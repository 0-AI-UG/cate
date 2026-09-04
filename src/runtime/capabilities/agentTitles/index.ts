import type { AgentTitleResolvers } from './types'
import { resolveClaudeTitle } from './claude'
import { resolveCodexTitle } from './codex'
import { resolveCursorTitle } from './cursor'
import { resolveGrokTitle } from './grok'
import { resolveKiroTitle } from './kiro'
import { resolveOpenCodeTitle } from './opencode'
import { resolvePiTitle } from './pi'

/** CLI-specific persistence contracts behind one exhaustive runtime lookup. */
export const AGENT_TITLE_RESOLVERS: AgentTitleResolvers = {
  'claude-code': resolveClaudeTitle,
  codex: resolveCodexTitle,
  cursor: resolveCursorTitle,
  grok: resolveGrokTitle,
  kiro: resolveKiroTitle,
  opencode: resolveOpenCodeTitle,
  pi: resolvePiTitle,
}

export { createAgentTitleTracker } from './tracker'
