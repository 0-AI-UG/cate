// Agent CLI → logo SVG URL. Source files live in /_logos at the repo root.
// Keys are the `displayName` strings set in src/main/ipc/shell.ts
// (AGENT_DEFINITIONS). Returns null for unknown agents — callers should
// fall back to the panel's default Phosphor icon.

import claudeLogo from '../assets/agentLogos/claude.svg?url'
import codexLogo from '../assets/agentLogos/codex.svg?url'
import antigravityLogo from '../assets/agentLogos/antigravity.svg?url'
import cursorLogo from '../assets/agentLogos/cursor.svg?url'
import opencodeLogo from '../assets/agentLogos/opencode.svg?url'
import piLogo from '../assets/agentLogos/pi.svg?url'

const LOGO_BY_DISPLAY_NAME: Record<string, string> = {
  'Claude Code': claudeLogo,
  'Codex': codexLogo,
  'Antigravity': antigravityLogo,
  'Cursor': cursorLogo,
  'OpenCode': opencodeLogo,
  'PI Agent': piLogo,
}

export function getAgentLogo(displayName: string | null | undefined): string | null {
  if (!displayName) return null
  return LOGO_BY_DISPLAY_NAME[displayName] ?? null
}
