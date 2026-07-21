// =============================================================================
// Coding agents Cate recognizes — THE canonical registry. Everything Cate knows
// about an agent CLI is declared here (or in a table this file's AgentId keys),
// so adding an agent is one entry plus whatever the compiler then demands.
//
// Declared inline on each AgentDef:
//   • detection — src/runtime/capabilities/process.ts matches a terminal's
//     child process name against `matchProcess` to label/decorate the panel.
//   • resume — `resumeArgs`, the argv that re-attaches a restored terminal to
//     the session it had open (null when the CLI cannot resume by id).
//   • skills — `skills`, where this agent reads project skills from and how
//     they are laid out (null when Cate installs no skills for it).
//     src/shared/skills.ts and src/skills/main/targets.ts DERIVE from it.
//
// Keyed by AgentId elsewhere, each a TOTAL Record<AgentId, …> so a new id is a
// COMPILE ERROR until it is filled in — that is the forget-proofing, do not
// loosen these to Partial:
//   • hooks — AGENT_HOOK_SPECS in src/shared/agentHooks.ts (injection channel +
//     payload normalizer).
//   • resumability — RESUMABLE_FROM_SESSION_START in
//     src/main/ipc/agentSessionStamps.ts.
// The one table that CANNOT be exhaustive is the logo map
// (src/renderer/lib/agent/agentLogos.ts): it is renderer-only because it
// imports SVG assets, and a missing logo degrades to a default icon rather than
// breaking. agentRegistry.test.ts asserts the coverage the compiler can't.
//
// Pure data + functions so BOTH the electron-free daemon (which bundles this via
// esbuild) and the renderer can import it — keep it free of any electron / asset
// / renderer imports. (The SkillTargetId import is type-only, so it is erased —
// no runtime cycle with skills.ts, which imports AGENTS from here.)
// =============================================================================

import type { SkillTargetId } from './skills'

export type AgentId =
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'grok'
  | 'opencode'
  | 'pi'

/** Where one agent reads project skills from, and how they are written.
 *  Cate follows the open Agent Skills standard (a `SKILL.md` folder), so an
 *  agent's whole skills integration is its base dir plus a layout flag. */
export interface AgentSkillTarget {
  /** Stable id, PERSISTED in each workspace's `.cate/skills.json`. Renaming one
   *  orphans every recorded install, so these never change — which is why the
   *  id is spelled out here instead of reusing AgentId (pi's is 'pi-native'). */
  targetId: SkillTargetId
  /** Workspace-relative segments of the skills root (e.g. ['.claude','skills']).
   *  The FIRST segment doubles as the agent's tool dir — its presence in a repo
   *  is the "this agent is used here" signal the install matrix reads. */
  baseSegments: readonly string[]
  /** `folder` = `<base>/<name>/SKILL.md` (+ bundled files); `flat` = `<base>/<name>.md`. */
  layout: 'folder' | 'flat'
  bundledResources: boolean
  /** The standard requires frontmatter `name` to equal the dir name. We always
   *  satisfy this (dir = name = slug), so it's informational. */
  nameMatchesDir: boolean
  /** Label in the skills UI, when it differs from the agent's displayName. */
  label?: string
  /** Path not yet fully verified against the tool's current docs. */
  beta?: boolean
}

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
  /** Argv (after `command`) that re-attaches to `sessionId` on a terminal
   *  restore, or null when this CLI cannot resume by id. Every contract here is
   *  pinned live by agentHookContracts.itest.ts. */
  resumeArgs: ((sessionId: string) => string[]) | null
  /** Project-skills integration, or null when Cate installs no skills for this
   *  agent. Verified against each CLI's own docs — see the per-agent notes. */
  skills: AgentSkillTarget | null
}

/** Shared shape of every agent's skills dir: `<base>/<name>/SKILL.md` with
 *  bundled scripts/references alongside. Only the base dir actually differs. */
const folderSkills = (
  targetId: SkillTargetId,
  baseSegments: readonly string[],
  extra: Partial<AgentSkillTarget> = {},
): AgentSkillTarget => ({
  targetId,
  baseSegments,
  layout: 'folder',
  bundledResources: true,
  nameMatchesDir: false,
  ...extra,
})

export const AGENTS: readonly AgentDef[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    command: 'claude',
    matchProcess: (n) => n === 'claude' || n === 'claude-code' || n.startsWith('claude'),
    resumeArgs: (sid) => ['--resume', sid],
    // claude is the standard's origin: it REQUIRES frontmatter name === dir name.
    skills: folderSkills('claude-code', ['.claude', 'skills'], { nameMatchesDir: true }),
  },
  {
    id: 'codex',
    displayName: 'Codex',
    command: 'codex',
    matchProcess: (n) => n === 'codex',
    resumeArgs: (sid) => ['resume', sid],
    skills: folderSkills('codex', ['.codex', 'skills']),
  },
  // The install script links ~/.local/bin/cursor-agent; the CLI keeps the
  // invoked name as its process title (comm is the full launcher path, which
  // the process scan basenames), so both spellings show up in the wild.
  {
    id: 'cursor',
    displayName: 'Cursor',
    command: 'cursor-agent',
    matchProcess: (n) => n === 'cursor-agent' || n === 'cursor',
    // --resume ADOPTS an unknown id (fresh chat under that id, exit 0) rather
    // than failing — a stale stamp degrades to a fresh session, never a wrong one.
    resumeArgs: (sid) => ['--resume', sid],
    // Per cursor's own bundled create-skill skill: personal ~/.cursor/skills,
    // project .cursor/skills. (~/.cursor/skills-cursor is cursor's internal
    // built-ins dir and is explicitly off-limits — we never write there.)
    skills: folderSkills('cursor', ['.cursor', 'skills']),
  },
  // xAI's Grok Build. The npm launcher (@xai-official/grok) execs a versioned
  // binary out of ~/.grok/bin — the process scan basenames it, so the
  // versioned spelling shows up alongside the plain one.
  {
    id: 'grok',
    displayName: 'Grok',
    command: 'grok',
    matchProcess: (n) => n === 'grok' || /^grok-\d/.test(n),
    // --resume ERRORS on an id with no session on disk (pinned live), so a stale
    // stamp falls back to a plain shell instead of silently opening a fresh chat.
    resumeArgs: (sid) => ['--resume', sid],
    // grok reads .grok/skills, .agents/skills, .claude/skills AND .cursor/skills
    // (verified live via `grok inspect --json`). We install to its OWN dir: the
    // compat dirs belong to the agents that own them, and grok dedupes by name
    // with .grok winning, so a skill installed for both lands once.
    skills: folderSkills('grok', ['.grok', 'skills']),
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    command: 'opencode',
    matchProcess: (n) => n === 'opencode',
    resumeArgs: (sid) => ['--session', sid],
    skills: folderSkills('opencode', ['.opencode', 'skills']),
  },
  // @earendil-works/pi-coding-agent — runs as the `pi` binary.
  {
    id: 'pi',
    displayName: 'PI Agent',
    command: 'pi',
    matchProcess: (n) => n === 'pi',
    // pi's --resume is an interactive picker; --session takes an exact id.
    resumeArgs: (sid) => ['--session', sid],
    // `.agents/skills` is the cross-tool shared location pi (and others) read,
    // so pi's target id is 'pi-native' rather than the dir-derived name.
    skills: folderSkills('pi-native', ['.agents', 'skills'], { label: 'Pi' }),
  },
]

/** The agent whose skills target this is, or null for a non-agent target
 *  (Cate's own `cate-agent`). */
export function agentForSkillTarget(targetId: SkillTargetId): AgentDef | null {
  return AGENTS.find((a) => a.skills?.targetId === targetId) ?? null
}

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

// Session-resume (AgentDef.resumeArgs) builds the command typed into a restored
// terminal's shell to re-attach the agent to the session it was running at save
// time. The session id is interpolated into a shell command line, so it is
// validated to be a bare token first (uuids / opencode ses_* ids; never
// quoting-sensitive).
//
// First char must be alphanumeric: session ids originate from hook posts any
// terminal process can forge, and a dash-led "id" (`--dangerously-skip-
// permissions`) would otherwise be joined into the resume command as a flag.
// Real ids are uuids / opencode `ses_*` — never dash-led.
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** The full shell command that resumes `sessionId` for `agentId`, or null when
 *  the agent is unknown / can't resume by id (or the id isn't a bare token). */
export function resumeCommandForAgent(agentId: string, sessionId: string): string | null {
  const def = AGENTS.find((a) => a.id === agentId)
  if (!def?.resumeArgs || !SAFE_SESSION_ID.test(sessionId)) return null
  return [def.command, ...def.resumeArgs(sessionId)].join(' ')
}
