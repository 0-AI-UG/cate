// Agent logos: the bundled SVG of each agent, keyed by agent id. The table is
// total, so a new agent is a compile error until it has a logo.

import type { AgentId } from '@services/agents/contract'
import claudeLogo from './logos/claude.svg?url'
import codexLogo from './logos/codex.svg?url'
import cursorLogo from './logos/cursor.svg?url'
import grokLogo from './logos/grok.svg?url'
import hermesLogo from './logos/hermes.svg?url'
import kiroLogo from './logos/kiro.svg?url'
import opencodeLogo from './logos/opencode.svg?url'

const AGENT_LOGOS: Record<AgentId, string> = {
  'claude-code': claudeLogo,
  codex: codexLogo,
  cursor: cursorLogo,
  grok: grokLogo,
  hermes: hermesLogo,
  kiro: kiroLogo,
  opencode: opencodeLogo,
}

/** Logo URL of an agent; null without one (callers show the panel's icon). */
export function agentLogo(id: AgentId | null | undefined): string | null {
  return id ? AGENT_LOGOS[id] : null
}
