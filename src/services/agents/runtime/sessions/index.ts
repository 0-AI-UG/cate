import type { AgentSessionStores } from './types'
import { claudeSessionStore } from './claude'
import { codexSessionStore } from './codex'
import { cursorSessionStore } from './cursor'
import { grokSessionStore } from './grok'
import { hermesSessionStore } from './hermes'
import { kiroSessionStore } from './kiro'
import { openCodeSessionStore } from './opencode'

/** CLI-specific session persistence behind one exhaustive runtime lookup. */
export const AGENT_SESSION_STORES: AgentSessionStores = {
  'claude-code': claudeSessionStore,
  codex: codexSessionStore,
  cursor: cursorSessionStore,
  grok: grokSessionStore,
  hermes: hermesSessionStore,
  kiro: kiroSessionStore,
  opencode: openCodeSessionStore,
}

export { createAgentTitleTracker } from './tracker'
