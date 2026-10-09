// The agent registry (architecture 2, 10.4): everything Cate knows about an
// agent CLI is declared here or in a table keyed by AgentId. Every such table
// is a total Record<AgentId, ...> (null where an agent has no entry), so a new
// agent is a compile error until every table has it. Do not loosen them to
// Partial.
//
// Declared on each AgentDef:
//   - runners.terminal: the CLI in a PTY. Its command, hook spec (hooks.ts),
//     resume argv, where its session store lives and how a started agent is
//     launched.
//   - runners.t3: the T3 provider of the same agent, for the agents T3 has one.
//   - matchProcess / hookProcess: identity verification of a hook post's pid.
//   - promptContextHook / promptGuidance: how relation context reaches a turn.
//   - skills: where the agent reads project skills.
//
// The one table that cannot live here is the logo map (ui, it imports assets).

import type { SkillTargetId } from '@workspace/skills/contract'
import { AGENT_HOOK_SPECS, type AgentHookSpec } from './hooks'
import { t3ProviderNamed, type T3ProviderId } from '@services/t3/contract'

export type AgentId =
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'grok'
  | 'hermes'
  | 'kiro'
  | 'opencode'

/** Where one agent reads project skills from, and how they are written.
 *  Cate follows the open Agent Skills standard (a `SKILL.md` folder), so an
 *  agent's whole skills integration is its base dir plus a layout flag. */
export interface AgentSkillTarget {
  /** Stable id, persisted in each workspace's `.cate/skills.json`. Renaming
   *  one orphans every recorded install, so these never change. */
  targetId: SkillTargetId
  /** Workspace-relative segments of the skills root (e.g. ['.claude','skills']).
   *  The first segment doubles as the agent's tool dir: its presence in a repo
   *  is the "this agent is used here" signal. */
  baseSegments: readonly string[]
  /** Additional roots that consume the same installed bundle. */
  mirrorBaseSegments?: readonly (readonly string[])[]
  /** `folder` = `<base>/<name>/SKILL.md` (+ bundled files); `flat` = `<base>/<name>.md`. */
  layout: 'folder' | 'flat'
  bundledResources: boolean
  /** The standard requires frontmatter `name` to equal the dir name. */
  nameMatchesDir: boolean
  /** Label in the skills UI, when it differs from the agent's displayName. */
  label?: string
  /** Path not yet fully verified against the tool's current docs. */
  beta?: boolean
}


export type AgentInterruptKey = 'escape' | 'ctrl-c'

/** What each interrupt key types into the PTY. */
export const AGENT_INTERRUPT_INPUT: Record<AgentInterruptKey, string> = { escape: '\x1b', 'ctrl-c': '\x03' }

export interface TerminalRunnerDef {
  /** The CLI command that launches this agent, usually its process name. */
  command: string
  /** Hook injection, payload normalization and interrupt handling. */
  hooks: AgentHookSpec
  resume: {
    /** Argv (after `command`) that re-attaches to `sessionId` on a terminal
     *  restore, or null when this CLI cannot resume by id. */
    args: ((sessionId: string, context?: { profile?: string }) => string[] | null) | null
    /** Whether a session is resumable when its session-start hook arrives.
     *  False when the CLI announces an id before persisting anything, so the
     *  session is only stamped from its first turn event. */
    fromSessionStart: boolean
  }
  /** Where the CLI persists its sessions, relative to the runtime host's home.
   *  The reader for it is `AGENT_SESSION_STORES` in the runtime. */
  sessionStore: string
  /** Shell-free argv that starts the CLI on its first prompt. */
  promptArgs: (prompt: string) => string[]
  /** The keys, pressed in order, that stop the CLI's turn and keep it at its
   *  prompt (verified by the live interrupt scenario). */
  interruptKeys: readonly AgentInterruptKey[]
}

export interface T3RunnerDef {
  providerId: T3ProviderId
}

export interface AgentDef {
  id: AgentId
  /** Label shown in panel titles and tooltips. */
  displayName: string
  runners: {
    terminal: TerminalRunnerDef
    t3?: T3RunnerDef
  }
  /** True when a process with this (lowercased) name is this agent. */
  matchProcess: (procName: string) => boolean
  /** In-process hooks prove identity from the authenticated posting pid even
   *  when the interpreter hides the CLI name in `ps comm`. */
  hookProcess?: 'self'
  /** Native post-submit extension point that adds relation context without
   *  touching PTY input: the turn-start hook response as JSON
   *  `additionalContext` or plain text, or an in-process plugin that fetches it
   *  from the hook endpoint's /prompt-context. */
  promptContextHook: 'additional-context' | 'plain-text' | 'endpoint' | null
  /** Extra guidance appended to relation context for this agent. */
  promptGuidance: string | null
  /** Project-skills integration, or null when Cate installs none. */
  skills: AgentSkillTarget | null
}

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

/** Declaration order is the canonical registry order (driver agent pick). */
export const AGENT_DEFS: Record<AgentId, AgentDef> = {
  'claude-code': {
    id: 'claude-code',
    displayName: 'Claude Code',
    runners: {
      terminal: {
        command: 'claude',
        hooks: AGENT_HOOK_SPECS['claude-code'],
        // Claude announces an id before its transcript exists.
        resume: { args: (sid) => ['--resume', sid], fromSessionStart: false },
        sessionStore: '.claude/projects',
        promptArgs: (prompt) => [prompt],
        interruptKeys: ['escape'],
      },
      t3: { providerId: 'claude' },
    },
    matchProcess: (n) => n === 'claude' || n === 'claude-code',
    promptContextHook: 'additional-context',
    promptGuidance: null,
    // claude is the standard's origin: it requires frontmatter name === dir name.
    skills: folderSkills('claude-code', ['.claude', 'skills'], { nameMatchesDir: true }),
  },
  codex: {
    id: 'codex',
    displayName: 'Codex',
    runners: {
      terminal: {
        command: 'codex',
        hooks: AGENT_HOOK_SPECS.codex,
        resume: { args: (sid) => ['resume', sid], fromSessionStart: true },
        sessionStore: '.codex/sessions',
        promptArgs: (prompt) => [prompt],
        interruptKeys: ['ctrl-c'],
      },
      t3: { providerId: 'codex' },
    },
    matchProcess: (n) => n === 'codex',
    promptContextHook: 'additional-context',
    promptGuidance: [
      '<cate-execution-guidance agent="codex">',
      'Run Cate CLI commands (`cate ...`) outside the Codex sandbox (request escalated execution), because the sandbox cannot reach Cate\'s local `CATE_API` control endpoint.',
      '</cate-execution-guidance>',
    ].join('\n'),
    skills: folderSkills('codex', ['.codex', 'skills']),
  },
  // The install script links ~/.local/bin/cursor-agent; the CLI keeps the
  // invoked name as its process title, so both spellings show up.
  cursor: {
    id: 'cursor',
    displayName: 'Cursor',
    runners: {
      terminal: {
        command: 'cursor-agent',
        hooks: AGENT_HOOK_SPECS.cursor,
        // --resume adopts an unknown id (fresh chat under that id), so a stale
        // stamp degrades to a fresh session, never a wrong one.
        resume: { args: (sid) => ['--resume', sid], fromSessionStart: true },
        sessionStore: '.cursor/chats',
        promptArgs: (prompt) => [prompt],
        interruptKeys: ['escape'],
      },
      t3: { providerId: 'cursor' },
    },
    matchProcess: (n) => n === 'cursor-agent' || n === 'cursor',
    promptContextHook: null,
    promptGuidance: null,
    // ~/.cursor/skills-cursor is cursor's internal built-ins dir; never written.
    skills: folderSkills('cursor', ['.cursor', 'skills']),
  },
  // xAI's Grok Build. The npm launcher execs a versioned binary out of
  // ~/.grok/bin, so the versioned spelling shows up alongside the plain one.
  grok: {
    id: 'grok',
    displayName: 'Grok',
    runners: {
      terminal: {
        command: 'grok',
        hooks: AGENT_HOOK_SPECS.grok,
        // --resume errors on an unknown id, so a stale stamp falls back to a
        // plain shell. SessionStart is deferred to the first prompt, so the
        // session is on disk when its id arrives.
        resume: { args: (sid) => ['--resume', sid], fromSessionStart: true },
        sessionStore: '.grok/sessions',
        promptArgs: (prompt) => [prompt],
        interruptKeys: ['ctrl-c'],
      },
      t3: { providerId: 'grok' },
    },
    matchProcess: (n) => n === 'grok' || /^grok-\d/.test(n),
    promptContextHook: null,
    promptGuidance: null,
    // grok also reads other agents' skill dirs; install only into its own.
    skills: folderSkills('grok', ['.grok', 'skills']),
  },
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    runners: {
      terminal: {
        command: 'opencode',
        hooks: AGENT_HOOK_SPECS.opencode,
        resume: { args: (sid) => ['--session', sid], fromSessionStart: true },
        sessionStore: '.local/share/opencode/opencode.db',
        // Seed the persistent TUI instead of the one-shot `run` command so the
        // agent can take follow-up prompts on the same PTY.
        promptArgs: (prompt) => ['--prompt', prompt],
        interruptKeys: ['escape', 'escape'],
      },
      t3: { providerId: 'opencode' },
    },
    matchProcess: (n) => n === 'opencode',
    promptContextHook: 'endpoint',
    promptGuidance: null,
    skills: folderSkills('opencode', ['.opencode', 'skills']),
  },
  hermes: {
    id: 'hermes',
    displayName: 'Hermes',
    runners: {
      terminal: {
        command: 'hermes',
        hooks: AGENT_HOOK_SPECS.hermes,
        // Profiles have independent session stores, so an exact resume carries
        // the profile. `custom` names a HERMES_HOME Cate cannot reproduce.
        // Hermes creates the record before its first persisted user turn.
        resume: {
          args: (sid, context) => context?.profile && context.profile !== 'custom'
            ? ['--profile', context.profile, 'chat', '--resume', sid]
            : null,
          fromSessionStart: false,
        },
        sessionStore: '.hermes/state.db',
        // Hermes >=0.21 keeps `chat -q` interactive when attached to a PTY.
        promptArgs: (prompt) => ['chat', '-q', prompt],
        interruptKeys: ['ctrl-c'],
      },
    },
    matchProcess: (n) => n === 'hermes' || n === 'hermes.exe',
    hookProcess: 'self',
    promptContextHook: 'plain-text',
    promptGuidance: null,
    skills: folderSkills('hermes', ['.hermes', 'skills']),
  },
  // Kiro CLI with its v3 engine: standalone workspace hooks require it, so it
  // is selected explicitly for fresh and resumed sessions.
  kiro: {
    id: 'kiro',
    displayName: 'Kiro',
    runners: {
      terminal: {
        command: 'kiro-cli',
        hooks: AGENT_HOOK_SPECS.kiro,
        // Sessions are saved on each turn; agentSpawn precedes the first one.
        resume: { args: (sid) => ['chat', '--v3', '--resume-id', sid], fromSessionStart: false },
        sessionStore: '.kiro/sessions',
        promptArgs: (prompt) => ['chat', '--v3', prompt],
        interruptKeys: ['ctrl-c'],
      },
    },
    matchProcess: (n) => n === 'kiro-cli',
    promptContextHook: 'plain-text',
    promptGuidance: null,
    skills: folderSkills('kiro', ['.kiro', 'skills'], { nameMatchesDir: true }),
  },
}

export const AGENTS: readonly AgentDef[] = Object.values(AGENT_DEFS)

/** Agents with a T3 provider. */
export const T3_AGENTS = AGENTS.filter((agent): agent is AgentDef & { runners: { t3: T3RunnerDef } } =>
  !!agent.runners.t3)

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AGENT_DEFS, value)
}

export function agentDef(id: string | null | undefined): AgentDef | null {
  return isAgentId(id) ? AGENT_DEFS[id] : null
}

export function agentDisplayName(id: AgentId): string {
  return AGENT_DEFS[id].displayName
}

/** The agent whose skills target this is, or null for a non-agent target. */
export function agentForSkillTarget(targetId: SkillTargetId): AgentDef | null {
  return AGENTS.find((a) => a.skills?.targetId === targetId) ?? null
}

/** The repo-local config folder whose presence gates 'auto' injection for one
 *  agent (`.claude`, `.codex`, ...). Project-file hooks derive it from their
 *  first file; an external plugin uses the agent's skills dir. */
export function agentHookFolder(agentId: AgentId): string | null {
  const rel = AGENT_HOOK_SPECS[agentId].projectFiles?.[0]?.relPath
  if (rel) return rel.split('/')[0]
  return AGENT_DEFS[agentId].skills?.baseSegments[0] ?? null
}

/** Recognize the bare agent command at the start of a shell line. Paths are
 *  accepted (`/opt/bin/codex`); compound shell programs are not guessed at. */
export function agentForLaunchCommand(commandLine: string): AgentDef | null {
  const first = commandLine.trim().match(/^("[^"]+"|'[^']+'|[^\s]+)/)?.[1]
  if (!first) return null
  const quoted =
    (first.startsWith('"') && first.endsWith('"')) ||
    (first.startsWith("'") && first.endsWith("'"))
  const unquoted = quoted ? first.slice(1, -1) : first
  const command = unquoted.replace(/\\/g, '/').split('/').pop() ?? ''
  return AGENTS.find((agent) => agent.runners.terminal.command === command) ?? null
}

/** The agent whose process name matches (case-insensitive), or null. */
export function matchAgentDef(procName: string): AgentDef | null {
  const lower = procName.toLowerCase()
  return AGENTS.find((a) => a.matchProcess(lower)) ?? null
}

/** The agent behind a provider T3 names (its provider or driver id). */
export function agentIdForT3Provider(provider: string): AgentId | null {
  const providerId = t3ProviderNamed(provider)?.providerId
  return providerId ? AGENTS.find((agent) => agent.runners.t3?.providerId === providerId)?.id ?? null : null
}

// A resume command is typed into a restored shell, so the session id is
// validated to be a bare token first. Session ids come from hook posts any
// terminal process can forge; a dash-led "id" would be joined in as a flag.
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SAFE_PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** The full shell command that resumes `sessionId`, or null when the agent
 *  cannot resume by id (or the id is not a bare token). */
export function resumeCommandForAgent(
  agentId: string,
  sessionId: string,
  context?: { profile?: string },
): string | null {
  const def = agentDef(agentId)
  const args = def?.runners.terminal.resume.args
  if (!def || !args || !SAFE_SESSION_ID.test(sessionId)) return null
  if (context?.profile !== undefined && !SAFE_PROFILE_NAME.test(context.profile)) return null
  const argv = args(sessionId, context)
  return argv ? [def.runners.terminal.command, ...argv].join(' ') : null
}
