// Agent CLI → logo SVG URL. The agent list (ids + display names) is the single
// source of truth in src/shared/agents.ts; this file just attaches the one thing
// that can't live there — the renderer-bundled SVG assets — keyed by agent id.
// Adding an agent is: add it to AGENTS, then add one line + its .svg here.
// Returns null for unknown agents — callers fall back to the panel's default
// Phosphor icon.

import type { AgentId } from '../../../shared/agents'
import claudeLogo from '../../assets/agentLogos/claude.svg?url'
import codexLogo from '../../assets/agentLogos/codex.svg?url'
import cursorLogo from '../../assets/agentLogos/cursor.svg?url'
import grokLogo from '../../assets/agentLogos/grok.svg?url'
import hermesLogo from '../../assets/agentLogos/hermes.svg?url'
import kiroLogo from '../../assets/agentLogos/kiro.svg?url'
import opencodeLogo from '../../assets/agentLogos/opencode.svg?url'

const LOGO_BY_ID: Partial<Record<AgentId, string>> = {
  'claude-code': claudeLogo,
  codex: codexLogo,
  cursor: cursorLogo,
  grok: grokLogo,
  hermes: hermesLogo,
  kiro: kiroLogo,
  opencode: opencodeLogo,
}

export function getAgentLogoById(id: AgentId | null | undefined): string | null {
  if (!id) return null
  return LOGO_BY_ID[id] ?? null
}
