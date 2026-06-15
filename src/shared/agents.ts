// =============================================================================
// Coding agents Cate recognizes — the single source of truth for the agents we
// detect running inside a terminal. Add a new agent HERE (id, display name, and
// the process name(s) its CLI runs as) and it flows everywhere that matters:
//   • detection — src/companion/capabilities/process.ts matches a terminal's
//     child process name against `matchProcess` to label/decorate the panel.
//   • logo — src/renderer/lib/agent/agentLogos.ts maps this `id` to an SVG. That
//     file holds the one unavoidable renderer-only asset import; adding an agent
//     there is a single line (+ dropping the .svg). The display-name lookup is
//     derived from this list, so there's no second name table to keep in sync.
//
// Pure data + functions so BOTH the electron-free daemon (which bundles this via
// esbuild) and the renderer can import it — keep it free of any electron / asset
// / renderer imports.
//
// NOTE: skill-install targets are a SEPARATE list (SKILL_TARGETS in
// src/shared/skills.ts) — related but intentionally not merged: it also covers
// Cate itself and omits agents we can't install skills into, so the membership
// and id scheme differ.
// =============================================================================

export type AgentId =
  | 'claude-code'
  | 'codex'
  | 'antigravity'
  | 'cursor'
  | 'opencode'
  | 'pi'

export interface AgentDef {
  id: AgentId
  /** Label shown in panel titles / tooltips. */
  displayName: string
  /** True when a shell child process with this (already-lowercased) name means
   *  this agent is the one running in that terminal. */
  matchProcess: (procName: string) => boolean
}

export const AGENTS: readonly AgentDef[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    matchProcess: (n) => n === 'claude' || n === 'claude-code' || n.startsWith('claude'),
  },
  { id: 'codex', displayName: 'Codex', matchProcess: (n) => n === 'codex' },
  // Antigravity's CLI installs as `agy` (`antigravity` is the GUI IDE).
  { id: 'antigravity', displayName: 'Antigravity', matchProcess: (n) => n === 'agy' },
  { id: 'cursor', displayName: 'Cursor', matchProcess: (n) => n === 'cursor' || n === 'cursor-agent' },
  { id: 'opencode', displayName: 'OpenCode', matchProcess: (n) => n === 'opencode' },
  // @earendil-works/pi-coding-agent — runs as the `pi` binary.
  { id: 'pi', displayName: 'PI Agent', matchProcess: (n) => n === 'pi' },
]

/** Display name of the agent whose process name matches, or null if none.
 *  Matching is case-insensitive (the name is lowercased before the rules run). */
export function matchAgentProcess(procName: string): string | null {
  const lower = procName.toLowerCase()
  for (const a of AGENTS) {
    if (a.matchProcess(lower)) return a.displayName
  }
  return null
}
