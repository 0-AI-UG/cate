// =============================================================================
// Coding agents Cate recognizes — the single source of truth for the agents we
// detect running inside a terminal. Add a new agent HERE (id, display name, and
// the process name(s) its CLI runs as) and it flows everywhere that matters:
//   • detection — src/runtime/capabilities/process.ts matches a terminal's
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
  | 'cursor'
  | 'opencode'
  | 'pi'

export interface AgentDef {
  id: AgentId
  /** Label shown in panel titles / tooltips. */
  displayName: string
  /** The CLI command that launches this agent in a terminal — usually the same
   *  as the detected process name. Used by the Cate Agent orchestrator. */
  command: string
  /** True when a shell child process with this (already-lowercased) name means
   *  this agent is the one running in that terminal. */
  matchProcess: (procName: string) => boolean
}

export const AGENTS: readonly AgentDef[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    command: 'claude',
    matchProcess: (n) => n === 'claude' || n === 'claude-code' || n.startsWith('claude'),
  },
  { id: 'codex', displayName: 'Codex', command: 'codex', matchProcess: (n) => n === 'codex' },
  // The install script links ~/.local/bin/cursor-agent; the CLI keeps the
  // invoked name as its process title (comm is the full launcher path, which
  // the process scan basenames), so both spellings show up in the wild.
  {
    id: 'cursor',
    displayName: 'Cursor',
    command: 'cursor-agent',
    matchProcess: (n) => n === 'cursor-agent' || n === 'cursor',
  },
  { id: 'opencode', displayName: 'OpenCode', command: 'opencode', matchProcess: (n) => n === 'opencode' },
  // @earendil-works/pi-coding-agent — runs as the `pi` binary.
  { id: 'pi', displayName: 'PI Agent', command: 'pi', matchProcess: (n) => n === 'pi' },
]

/** The launch command for an agent id, or null if the id is unknown/empty. */
export function launchCommandForAgent(id: string): string | null {
  return AGENTS.find((a) => a.id === id)?.command ?? null
}

/** The agent whose process name matches, or null if none. Matching is
 *  case-insensitive (the name is lowercased before the rules run). */
export function matchAgentDef(procName: string): AgentDef | null {
  const lower = procName.toLowerCase()
  for (const a of AGENTS) {
    if (a.matchProcess(lower)) return a
  }
  return null
}

/** Display name of the agent whose process name matches, or null if none. */
export function matchAgentProcess(procName: string): string | null {
  return matchAgentDef(procName)?.displayName ?? null
}

// Session-resume argv per agent, used by terminal session-restore: the command
// typed into a restored terminal's shell to re-attach the agent to the session
// it was running at save time. Every resume contract here is pinned live by
// agentHookContracts.itest.ts. The session id is
// interpolated into a shell command line, so it is validated to be a bare
// token first (uuids / opencode ses_* ids; never quoting-sensitive).
const RESUME_ARGS: Record<AgentId, (sessionId: string) => string[]> = {
  'claude-code': (sid) => ['--resume', sid],
  codex: (sid) => ['resume', sid],
  // --resume ADOPTS an unknown id (fresh chat under that id, exit 0) rather
  // than failing — a stale stamp degrades to a fresh session, never a wrong one.
  cursor: (sid) => ['--resume', sid],
  // pi's --resume is an interactive picker; --session takes an exact id.
  pi: (sid) => ['--session', sid],
  opencode: (sid) => ['--session', sid],
}

// First char must be alphanumeric: session ids originate from hook posts any
// terminal process can forge, and a dash-led "id" (`--dangerously-skip-
// permissions`) would otherwise be joined into the resume command as a flag.
// Real ids are uuids / opencode `ses_*` — never dash-led.
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** The full shell command that resumes `sessionId` for `agentId`, or null when
 *  the agent id is unknown (or the id isn't a bare token). */
export function resumeCommandForAgent(agentId: string, sessionId: string): string | null {
  const def = AGENTS.find((a) => a.id === agentId)
  const args = RESUME_ARGS[agentId as AgentId] as ((sessionId: string) => string[]) | undefined
  if (!def || !args || !SAFE_SESSION_ID.test(sessionId)) return null
  return [def.command, ...args(sessionId)].join(' ')
}
