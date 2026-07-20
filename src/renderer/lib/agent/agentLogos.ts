// Agent CLI → logo SVG URL. The agent list (ids + display names) is the single
// source of truth in src/shared/agents.ts; this file just attaches the one thing
// that can't live there — the renderer-bundled SVG assets — keyed by agent id.
// The display-name lookup callers use is derived from AGENTS, so adding an agent
// is: add it to AGENTS, then add one line + its .svg here. Returns null for
// unknown agents — callers fall back to the panel's default Phosphor icon.

import { AGENTS, type AgentId } from '../../../shared/agents'
import claudeLogo from '../../assets/agentLogos/claude.svg?url'
import codexLogo from '../../assets/agentLogos/codex.svg?url'
import cursorLogo from '../../assets/agentLogos/cursor.svg?url'
import opencodeLogo from '../../assets/agentLogos/opencode.svg?url'
import piLogo from '../../assets/agentLogos/pi.svg?url'

const LOGO_BY_ID: Partial<Record<AgentId, string>> = {
  'claude-code': claudeLogo,
  codex: codexLogo,
  cursor: cursorLogo,
  opencode: opencodeLogo,
  pi: piLogo,
}

// displayName → logo, derived from the shared list so the names never drift.
const LOGO_BY_DISPLAY_NAME: Record<string, string> = Object.fromEntries(
  AGENTS.flatMap((a) => {
    const logo = LOGO_BY_ID[a.id]
    return logo ? [[a.displayName, logo] as const] : []
  }),
)

export function getAgentLogo(displayName: string | null | undefined): string | null {
  if (!displayName) return null
  return LOGO_BY_DISPLAY_NAME[displayName] ?? null
}

export function getAgentLogoById(id: AgentId | null | undefined): string | null {
  if (!id) return null
  return LOGO_BY_ID[id] ?? null
}
