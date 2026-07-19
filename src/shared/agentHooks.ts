// =============================================================================
// Agent hook abstraction — the per-CLI declarations that turn the six agent
// CLIs' hook/extension/plugin surfaces into ONE normalized push event stream.
// Each agent entry declares (a) HOW Cate injects its hook bridge (PATH-shim
// argv, ambient env, or workspace-scoped files) and (b) how that CLI's raw
// hook payload normalizes into an AgentHookEvent. Adding a CLI is one entry
// here plus its AgentDef in agents.ts.
//
// The injection/payload contracts are pinned LIVE against the installed CLIs
// by src/runtime/capabilities/agentHookContracts.itest.ts — when a CLI update
// moves a hook surface, that suite fails loudly pre-release; the shapes here
// must follow it, never the other way around.
//
// Electron-free, node-only (crypto): imported by the runtime daemon (which
// ingests + normalizes on whichever host owns the terminal) and by the main
// process. The renderer may import TYPES from here, never values.
// =============================================================================

import { createHash } from 'crypto'
import type { AgentId } from './agents'

// ---------------------------------------------------------------------------
// Env contract — planted on every PTY by the daemon; echoed back by hooks
// (hook handlers inherit the PTY env, which is the terminal↔event correlation).
// ---------------------------------------------------------------------------

export const CATE_HOOK_ENDPOINT_ENV = 'CATE_HOOK_ENDPOINT'
export const CATE_HOOK_TOKEN_ENV = 'CATE_HOOK_TOKEN'
export const CATE_TERMINAL_ID_ENV = 'CATE_TERMINAL_ID'

/** Per-PTY session pre-assignment env var for an agent (e.g.
 *  CATE_SESSION_PREASSIGN_CLAUDE_CODE). When set on the PTY and the user's own
 *  argv has no session-affecting flags, the agent's shim injects
 *  `<preassign.flag> <value>` so Cate CHOOSES the session id at spawn. The
 *  daemon never sets it itself — policy belongs to the session-stamp feature,
 *  which can plant it per-terminal via PtyCreateOptions.env. */
export function sessionPreassignEnvVar(agentId: AgentId): string {
  return `CATE_SESSION_PREASSIGN_${agentId.toUpperCase().replace(/-/g, '_')}`
}

// ---------------------------------------------------------------------------
// The one normalized event
// ---------------------------------------------------------------------------

export type AgentHookEventKind =
  | 'session-start'
  | 'session-end'
  | 'turn-start'
  | 'turn-end'
  | 'permission-wait'
  /** A blocked permission-wait resolved and the turn is in flight again
   *  (claude/codex PostToolUse, opencode permission.replied). Also fires on
   *  every ordinary tool call for claude/codex — consumers treat it as an
   *  idempotent "the turn is running" re-assertion. */
  | 'turn-resume'

export interface AgentHookEvent {
  /** The pty id whose env the hook echoed back (CATE_TERMINAL_ID). */
  terminalId: string
  agentId: AgentId
  kind: AgentHookEventKind
  /** The CLI's own session/conversation id, or null when the event doesn't
   *  carry one (e.g. a malformed payload field). */
  sessionId: string | null
  /** The cwd the CLI reports for the session (its store join key), when the
   *  payload carries one. */
  cwd?: string
  /** The transcript / rollout / session file backing the session, when the
   *  payload carries one. */
  transcriptPath?: string
  /** The raw payload as posted by the bridge, for consumers that need
   *  per-CLI detail (e.g. codex's turn_id / tool_input on permission-wait). */
  raw: Record<string, unknown>
}

export type NormalizedHookFields = Pick<AgentHookEvent, 'kind' | 'sessionId'> &
  Partial<Pick<AgentHookEvent, 'cwd' | 'transcriptPath'>>

// ---------------------------------------------------------------------------
// Injection declarations
// ---------------------------------------------------------------------------

/** Paths the daemon materialized for one agent's injection; every builder is a
 *  pure function of this. */
export interface HookInjectionContext {
  /** Absolute path of this agent's bridge executable — a dependency-free
   *  command that forwards one stdin-JSON hook payload to the daemon. */
  bridgeCommand: string
  /** Absolute path of this agent's in-process support file (pi extension /
   *  opencode plugin), when the spec declares one. Empty otherwise. */
  filePath: string
}

export interface AgentHookSpec {
  /**
   * PATH-shim argv injection: terminals are plain user-typed shells, so CLIs
   * with per-invocation flags (codex hooks, pi's -e extension, claude/pi
   * session pre-assignment) are intercepted by an executable of the same name
   * earlier in PATH that exec's the real binary with `args` prepended.
   * CAVEAT: the shim dir only wins while it stays first on PATH — a shell rc
   * file prepending the CLI's own install dir (~/.local/bin etc.), an alias,
   * or an absolute-path launch bypasses it. Prefer a file/env channel where
   * the CLI offers one; consumers must tolerate shim-injected events never
   * arriving.
   */
  shim?: {
    /** Extra argv tokens inserted BEFORE the user's own args. */
    args(ctx: HookInjectionContext): string[]
    /** In-process support file (pi's -e extension) written into the hooks
     *  dir; args() receives its absolute path as ctx.filePath. */
    file?: { name: string; content(): string }
    /** Session pre-assignment: the shim injects `flag <value-of-preassign-env>`
     *  unless the user's argv contains one of `blockers` (session-affecting
     *  flags / subcommands — the user's own choice always wins). */
    preassign?: { flag: string; blockers: string[] }
  }
  /**
   * Ambient env injection (opencode): vars planted on every PTY. Verified
   * against the opencode 1.18.x binary: OPENCODE_CONFIG_CONTENT is parsed and
   * MERGED over global+project config as a "local"-scope source at the end of
   * Config.loadInstanceState, with `plugin` arrays deduplicated and appended —
   * it does NOT replace the user's config, so this is safe for ambient
   * injection. (Caveat: a user who exports their own OPENCODE_CONFIG_CONTENT
   * in shell rc overwrites ours — injection degrades to none, never breaks.)
   */
  env?: {
    file: { name: string; content(): string }
    vars(ctx: HookInjectionContext): Record<string, string>
  }
  /**
   * Workspace-scoped hook files (claude's .claude/settings.local.json,
   * cursor/agy's hooks.json). `build` returns the file's new content given
   * the existing one, or null to leave the file untouched. Merge policy
   * (never clobber user config): a missing file is created; a parseable file
   * is merged — our entries (marked by the CATE_HOOK_MARKER in the command
   * path) are replaced/refreshed, every user entry is preserved; an
   * unparseable file is left alone.
   */
  projectFiles?: Array<{
    relPath: string
    build(existing: string | null, ctx: HookInjectionContext): string | null
  }>
  /**
   * Global trust seeding (agy): hooks only run in trusted workspaces, so the
   * workspace root is added to a settings file under the HOME dir. `build`
   * returns updated content or null to leave the file alone.
   */
  trust?: {
    /** Path relative to the host home dir. */
    relPath: string
    build(existing: string | null, workspaceRoot: string): string | null
  }
  /** Normalize one raw payload posted by this agent's bridge. Null = drop
   *  (an event Cate doesn't track, e.g. claude's idle_prompt notification). */
  normalize(payload: Record<string, unknown>): NormalizedHookFields | null
}

/** Marker every generated bridge/wrapper path contains — how the project-file
 *  merge recognizes (and refreshes) Cate's own entries across daemon restarts
 *  (the hooks dir is per-boot, so stale paths must be replaced). */
export const CATE_HOOK_MARKER = 'cate-hook'

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

// ---------------------------------------------------------------------------
// claude — hooks ride in <workspace>/.claude/settings.local.json (project
// scope, merged by claude over user settings; same file whether claude is in
// TUI or -p mode). File injection on purpose: the original per-invocation
// `--settings` shim relied on the shim dir staying FIRST on PATH, which every
// rc-file `export PATH="~/.local/bin:$PATH"` prepend (uv/bun/brew boilerplate
// — and claude installs into ~/.local/bin) silently defeats, as do aliases
// and absolute-path launches. The shim survives only for session
// pre-assignment. JSON payload on hook stdin; session_id/transcript_path/cwd
// on every event.
// ---------------------------------------------------------------------------

const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'PostToolUse', 'Stop', 'SessionEnd']

/** One matcher-group per event, holding only our bridge command. */
interface ClaudeHookGroup {
  matcher?: unknown
  hooks?: Array<{ type?: unknown; command?: unknown }>
  [k: string]: unknown
}

interface ClaudeSettingsJson {
  hooks?: Record<string, ClaudeHookGroup[]>
  [k: string]: unknown
}

const claudeSpec: AgentHookSpec = {
  shim: {
    args: () => [],
    preassign: {
      flag: '--session-id',
      // claude's session-affecting argv: resume (2 spellings), continue
      // (2 spellings), an explicit --session-id, or the resume subcommand.
      blockers: ['--resume', '-r', '--continue', '-c', '--session-id', 'resume'],
    },
  },
  projectFiles: [
    {
      relPath: '.claude/settings.local.json',
      build: (existing, ctx) => {
        const oursGroup = (): ClaudeHookGroup => ({ hooks: [{ type: 'command', command: ctx.bridgeCommand }] })
        const oursHooks = (): Record<string, ClaudeHookGroup[]> =>
          Object.fromEntries(CLAUDE_EVENTS.map((e) => [e, [oursGroup()]]))
        if (existing === null) return JSON.stringify({ hooks: oursHooks() }, null, 2) + '\n'
        // Merge, never clobber: claude owns this file too (its "always allow"
        // permission grants land here), so every user field and every user
        // hook group is preserved. Only groups consisting solely of STALE Cate
        // bridge entries (per-boot paths, recognized by the marker) are
        // dropped, then the fresh group is appended per tracked event.
        // Unparseable → leave alone.
        let parsed: ClaudeSettingsJson
        try {
          parsed = JSON.parse(existing) as ClaudeSettingsJson
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
        } catch {
          return null
        }
        const hooks: Record<string, ClaudeHookGroup[]> =
          typeof parsed.hooks === 'object' && parsed.hooks !== null && !Array.isArray(parsed.hooks)
            ? parsed.hooks
            : {}
        for (const event of CLAUDE_EVENTS) {
          const kept: ClaudeHookGroup[] = []
          for (const group of Array.isArray(hooks[event]) ? hooks[event] : []) {
            if (typeof group !== 'object' || group === null) {
              kept.push(group)
              continue
            }
            const entries = Array.isArray(group.hooks) ? group.hooks : []
            const filtered = entries.filter(
              (h) => !(typeof h?.command === 'string' && h.command.includes(CATE_HOOK_MARKER)),
            )
            if (entries.length > 0 && filtered.length === 0) continue // group was ours
            kept.push(filtered.length === entries.length ? group : { ...group, hooks: filtered })
          }
          hooks[event] = [...kept, oursGroup()]
        }
        const out = JSON.stringify({ ...parsed, hooks }, null, 2) + '\n'
        return out === existing ? null : out
      },
    },
  ],
  normalize: (p) => {
    const base = {
      sessionId: str(p.session_id),
      cwd: str(p.cwd) ?? undefined,
      transcriptPath: str(p.transcript_path) ?? undefined,
    }
    switch (p.hook_event_name) {
      case 'SessionStart': return { kind: 'session-start', ...base }
      case 'UserPromptSubmit': return { kind: 'turn-start', ...base }
      // Fires after EVERY executed tool call; the one after a permission-wait
      // is the approval resolution (denial produces no PostToolUse — the turn
      // just Stops).
      case 'PostToolUse': return { kind: 'turn-resume', ...base }
      case 'Stop': return { kind: 'turn-end', ...base }
      case 'SessionEnd': return { kind: 'session-end', ...base }
      case 'Notification':
        // permission_prompt = blocked on tool approval; idle_prompt (and any
        // future notification type) is not a tracked state — drop it.
        return p.notification_type === 'permission_prompt' ? { kind: 'permission-wait', ...base } : null
      default: return null
    }
  },
}

// ---------------------------------------------------------------------------
// codex — per-invocation `-c` overrides. Untrusted hooks are SILENTLY skipped,
// so each injected hook rides with a hooks.state trust entry whose
// trusted_hash covers the canonical handler identity. Key + hash formats are
// codex internals pinned by the live contract suite — the assertion there is
// the early warning when this drifts.
// ---------------------------------------------------------------------------

/** sha256 of codex's canonical handler identity — the exact builder verified
 *  live (see agentHookContracts.itest.ts trustedHash). */
export function codexTrustedHash(label: string, command: string, timeout: number): string {
  const identity =
    `{"event_name":${JSON.stringify(label)},"hooks":[{"async":false,` +
    `"command":${JSON.stringify(command)},"timeout":${timeout},"type":"command"}]}`
  return 'sha256:' + createHash('sha256').update(identity).digest('hex')
}

/** [TOML key (CamelCase), trust label (snake_case)] pairs — the two casings
 *  are a codex quirk, not a typo. */
const CODEX_EVENTS: Array<[string, string]> = [
  ['SessionStart', 'session_start'],
  ['UserPromptSubmit', 'user_prompt_submit'],
  ['PermissionRequest', 'permission_request'],
  ['PostToolUse', 'post_tool_use'],
  ['Stop', 'stop'],
]

const CODEX_HOOK_TIMEOUT = 60

const codexSpec: AgentHookSpec = {
  shim: {
    args: (ctx) => {
      const args: string[] = []
      const state: string[] = []
      for (const [toml, label] of CODEX_EVENTS) {
        args.push('-c', `hooks.${toml}=[{hooks=[{type="command",command="${ctx.bridgeCommand}",timeout=${CODEX_HOOK_TIMEOUT}}]}]`)
        // The state key contains dots, so it rides as one inline table — it
        // cannot go through -c's dotted-path parser.
        state.push(
          `"/<session-flags>/config.toml:${label}:0:0"={trusted_hash="${codexTrustedHash(label, ctx.bridgeCommand, CODEX_HOOK_TIMEOUT)}"}`,
        )
      }
      args.push('-c', `hooks.state={${state.join(',')}}`)
      return args
    },
    // No preassign: codex has no session-id pre-assignment flag.
  },
  normalize: (p) => {
    const base = {
      sessionId: str(p.session_id),
      cwd: str(p.cwd) ?? undefined,
      transcriptPath: str(p.transcript_path) ?? undefined,
    }
    switch (p.hook_event_name) {
      case 'SessionStart': return { kind: 'session-start', ...base }
      case 'UserPromptSubmit': return { kind: 'turn-start', ...base }
      case 'Stop': return { kind: 'turn-end', ...base }
      case 'PermissionRequest': return { kind: 'permission-wait', ...base }
      // Fires after EVERY executed tool call; the one after a PermissionRequest
      // is the approval resolution (denial produces no PostToolUse).
      case 'PostToolUse': return { kind: 'turn-resume', ...base }
      // SessionEnd never fires (pinned live) — no mapping on purpose.
      default: return null
    }
  },
}

// ---------------------------------------------------------------------------
// pi — in-process extension via `-e <file.ts>`; identity from
// ctx.sessionManager on every event; agent_start/agent_end bracket each turn.
// The extension posts to the daemon itself (fetch), so no bridge process runs.
// ---------------------------------------------------------------------------

const PI_EXTENSION_SOURCE = `// Generated by the Cate runtime daemon (agent hook injection). Do not edit.
const ENDPOINT = process.env.${CATE_HOOK_ENDPOINT_ENV};
const TOKEN = process.env.${CATE_HOOK_TOKEN_ENV};
export default function (pi: any) {
  if (!ENDPOINT || !TOKEN) return;
  const post = (event: string, ctx: any) => {
    let sessionId: string | undefined;
    let sessionFile: string | undefined;
    try {
      sessionId = ctx?.sessionManager?.getSessionId?.();
      sessionFile = ctx?.sessionManager?.getSessionFile?.();
    } catch {}
    fetch(ENDPOINT + "/hook", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
      body: JSON.stringify({
        agentId: "pi",
        terminalId: process.env.${CATE_TERMINAL_ID_ENV} ?? null,
        payload: { event, sessionId, sessionFile, cwd: process.cwd() },
      }),
    }).catch(() => {});
  };
  for (const name of ["session_start", "agent_start", "agent_end", "session_shutdown"]) {
    pi.on(name as any, async (_event: unknown, ctx: any) => {
      post(name, ctx);
      return undefined;
    });
  }
}
`

const piSpec: AgentHookSpec = {
  shim: {
    file: { name: 'cate-hook-pi.ts', content: () => PI_EXTENSION_SOURCE },
    args: (ctx) => ['-e', ctx.filePath],
    preassign: {
      flag: '--session-id',
      blockers: ['--resume', '--session', '--session-id', '--continue', 'resume'],
    },
  },
  normalize: (p) => {
    const base = {
      sessionId: str(p.sessionId),
      cwd: str(p.cwd) ?? undefined,
      transcriptPath: str(p.sessionFile) ?? undefined,
    }
    switch (p.event) {
      case 'session_start': return { kind: 'session-start', ...base }
      case 'agent_start': return { kind: 'turn-start', ...base }
      case 'agent_end': return { kind: 'turn-end', ...base }
      case 'session_shutdown': return { kind: 'session-end', ...base }
      default: return null
    }
  },
}

// ---------------------------------------------------------------------------
// opencode — in-process plugin via the OPENCODE_CONFIG_CONTENT env var (merged
// over the user's config, see AgentHookSpec.env). The plugin forwards only the
// five bus events Cate tracks; the bus is otherwise chatty (message parts).
// ---------------------------------------------------------------------------

const OPENCODE_PLUGIN_SOURCE = `// Generated by the Cate runtime daemon (agent hook injection). Do not edit.
const ENDPOINT = process.env.${CATE_HOOK_ENDPOINT_ENV}
const TOKEN = process.env.${CATE_HOOK_TOKEN_ENV}
const TRACKED = new Set(["session.created", "session.status", "session.idle", "permission.asked", "permission.replied"])
export const CateHookBridge = async () => {
  if (!ENDPOINT || !TOKEN) return {}
  return {
    event: async ({ event }) => {
      if (!event || !TRACKED.has(event.type)) return
      const props = event.properties ?? {}
      fetch(ENDPOINT + "/hook", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
        body: JSON.stringify({
          agentId: "opencode",
          terminalId: process.env.${CATE_TERMINAL_ID_ENV} ?? null,
          payload: {
            type: event.type,
            sessionID: props.sessionID ?? props.info?.id ?? null,
            status: props.status ?? null,
            directory: props.info?.directory ?? null,
            permission: props.permission ?? null,
            metadata: props.metadata ?? null,
          },
        }),
      }).catch(() => {})
    },
  }
}
`

const opencodeSpec: AgentHookSpec = {
  env: {
    file: { name: 'cate-hook-opencode.mjs', content: () => OPENCODE_PLUGIN_SOURCE },
    vars: (ctx) => ({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [`file://${ctx.filePath}`] }),
    }),
  },
  normalize: (p) => {
    const base = { sessionId: str(p.sessionID), cwd: str(p.directory) ?? undefined }
    switch (p.type) {
      case 'session.created': return { kind: 'session-start', ...base }
      case 'session.status':
        // busy marks the turn starting; the idle STATUS is redundant with the
        // explicit session.idle event below, so only busy maps.
        return (p.status as { type?: unknown } | null)?.type === 'busy' ? { kind: 'turn-start', ...base } : null
      case 'session.idle': return { kind: 'turn-end', ...base }
      case 'permission.asked': return { kind: 'permission-wait', ...base }
      // The user answered the permission prompt. Even a "reject" reply keeps
      // the turn in flight (the model receives the denial, produces text, and
      // idles), so every reply maps to turn-resume — the later turn-end
      // settles the state either way.
      case 'permission.replied': return { kind: 'turn-resume', ...base }
      default: return null
    }
  },
}

// ---------------------------------------------------------------------------
// cursor — <workspace>/.cursor/hooks.json (project-scoped), conversation_id on
// every event. sessionStart does NOT fire on --resume (pinned live), so the
// tracker keys on whatever event carries the id first.
// ---------------------------------------------------------------------------

const CURSOR_EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'stop', 'sessionEnd']

interface CursorHooksJson {
  version?: unknown
  hooks?: Record<string, Array<{ command?: unknown }>>
  [k: string]: unknown
}

const cursorSpec: AgentHookSpec = {
  projectFiles: [
    {
      relPath: '.cursor/hooks.json',
      build: (existing, ctx) => {
        const ours = (): CursorHooksJson => ({
          version: 1,
          hooks: Object.fromEntries(CURSOR_EVENTS.map((e) => [e, [{ command: ctx.bridgeCommand }]])),
        })
        if (existing === null) return JSON.stringify(ours(), null, 2) + '\n'
        // Merge, never clobber: keep every user field/handler; drop only STALE
        // Cate entries (per-boot bridge paths, recognized by the marker) and
        // append the fresh one per tracked event. Unparseable → leave alone.
        let parsed: CursorHooksJson
        try {
          parsed = JSON.parse(existing) as CursorHooksJson
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
        } catch {
          return null
        }
        const hooks: Record<string, Array<{ command?: unknown }>> =
          typeof parsed.hooks === 'object' && parsed.hooks !== null ? parsed.hooks : {}
        for (const event of CURSOR_EVENTS) {
          const kept = (Array.isArray(hooks[event]) ? hooks[event] : []).filter(
            (h) => !(typeof h?.command === 'string' && h.command.includes(CATE_HOOK_MARKER)),
          )
          hooks[event] = [...kept, { command: ctx.bridgeCommand }]
        }
        const next = { version: parsed.version ?? 1, ...parsed, hooks }
        const out = JSON.stringify(next, null, 2) + '\n'
        return out === existing ? null : out
      },
    },
  ],
  normalize: (p) => {
    const base = { sessionId: str(p.conversation_id) }
    switch (p.hook_event_name) {
      case 'sessionStart': return { kind: 'session-start', ...base }
      case 'beforeSubmitPrompt': return { kind: 'turn-start', ...base }
      case 'stop': return { kind: 'turn-end', ...base }
      case 'sessionEnd': return { kind: 'session-end', ...base }
      default: return null
    }
  },
}

// ---------------------------------------------------------------------------
// agy — <workspace>/.agents/hooks.json (agy-specific schema: named hook →
// event → handler list). Only PreInvocation/Stop are safe to observe (an
// observing PreToolUse that doesn't answer {"decision":"allow"} DENIES tool
// calls). Trust is pre-seeded via trustedWorkspaces in the CLI's settings.
// ---------------------------------------------------------------------------

const AGY_HOOK_NAME = 'cate-hook-bridge'

interface AgyHooksJson {
  [name: string]: unknown
}

const agySpec: AgentHookSpec = {
  projectFiles: [
    {
      relPath: '.agents/hooks.json',
      build: (existing, ctx) => {
        const ours = {
          PreInvocation: [{ type: 'command', command: ctx.bridgeCommand, timeout: 30 }],
          Stop: [{ type: 'command', command: ctx.bridgeCommand, timeout: 30 }],
        }
        if (existing === null) return JSON.stringify({ [AGY_HOOK_NAME]: ours }, null, 2) + '\n'
        // Merge under our own named-hook key (agy's schema namespaces hooks by
        // name, so replacing ONLY that key preserves every user hook).
        // Unparseable → leave alone.
        let parsed: AgyHooksJson
        try {
          parsed = JSON.parse(existing) as AgyHooksJson
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
        } catch {
          return null
        }
        const out = JSON.stringify({ ...parsed, [AGY_HOOK_NAME]: ours }, null, 2) + '\n'
        return out === existing ? null : out
      },
    },
  ],
  trust: {
    relPath: '.gemini/antigravity-cli/settings.json',
    build: (existing, workspaceRoot) => {
      let settings: { trustedWorkspaces?: unknown; [k: string]: unknown } = {}
      if (existing !== null) {
        try {
          settings = JSON.parse(existing) as typeof settings
          if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return null
        } catch {
          return null // never clobber an unparseable user settings file
        }
      }
      const list = Array.isArray(settings.trustedWorkspaces) ? (settings.trustedWorkspaces as unknown[]) : []
      if (list.includes(workspaceRoot)) return null
      return JSON.stringify({ ...settings, trustedWorkspaces: [...list, workspaceRoot] }, null, 2) + '\n'
    },
  },
  normalize: (p) => {
    // agy payloads carry conversationId on every event but no event name; only
    // PreInvocation and Stop are registered, and Stop is the one that carries
    // terminationReason — the same disambiguation the live contract suite uses.
    const sessionId = str(p.conversationId)
    if (sessionId === null) return null
    return p.terminationReason !== undefined
      ? { kind: 'turn-end', sessionId }
      : { kind: 'turn-start', sessionId }
  },
}

// ---------------------------------------------------------------------------
// Registry + normalization entry point
// ---------------------------------------------------------------------------

export const AGENT_HOOK_SPECS: Record<AgentId, AgentHookSpec> = {
  'claude-code': claudeSpec,
  codex: codexSpec,
  pi: piSpec,
  opencode: opencodeSpec,
  cursor: cursorSpec,
  antigravity: agySpec,
}

/** Normalize one raw bridge-posted payload into the shared event, or null when
 *  the agent is unknown or the payload isn't a tracked event. */
export function normalizeAgentHookPayload(
  agentId: string,
  terminalId: string,
  payload: Record<string, unknown>,
): AgentHookEvent | null {
  const spec = AGENT_HOOK_SPECS[agentId as AgentId]
  if (!spec) return null
  const fields = spec.normalize(payload)
  if (!fields) return null
  return { terminalId, agentId: agentId as AgentId, raw: payload, ...fields }
}
