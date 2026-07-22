// =============================================================================
// Agent hook abstraction — the per-CLI declarations that turn the agent
// CLIs' hook/extension/plugin surfaces into ONE normalized push event stream.
// Each agent entry declares (a) WHICH workspace-scoped files Cate writes to
// inject its hook bridge and (b) how that CLI's raw hook payload normalizes
// into an AgentHookEvent. Adding a CLI is one entry here plus its AgentDef in
// agents.ts.
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
   *  command that forwards one stdin-JSON hook payload to the daemon. The
   *  path is STABLE across daemon restarts (it lands in repo-scoped hook
   *  files, and codex additionally keys its persisted hook trust on it). */
  bridgeCommand: string
}

/**
 * Per-agent injection preference for a workspace's PROJECT hook files.
 *  - 'auto' (default): inject only when the agent's own config folder already
 *    exists in the repo (e.g. .claude, .codex) — a "this agent is relevant
 *    here" signal that avoids littering unrelated repos.
 *  - 'on': always inject, even in a repo with no such folder yet.
 *  - 'off': never inject, and strip any hook entries Cate previously wrote.
 * The shared CATE_HOOK_* env (endpoint/token/terminal id) is planted on every
 * PTY regardless — it leaves no repo trace, and a hook file that never gets
 * written simply never reads it.
 */
export type AgentHookMode = 'auto' | 'on' | 'off'

/** Sparse per-agent overrides; any agent absent resolves to 'auto'. */
export type AgentHookConfig = Partial<Record<AgentId, AgentHookMode>>

/** The effective mode for one agent (missing → 'auto'). */
export function resolveAgentHookMode(config: AgentHookConfig | undefined, agentId: AgentId): AgentHookMode {
  return config?.[agentId] ?? 'auto'
}

/** Result of a projectFile's `strip`: leave it (null), delete an owned file,
 *  or rewrite a shared file without our entries. */
export type AgentHookStrip = null | { delete: true } | { content: string }

/** Live per-agent injection state for one workspace, for the Settings UI.
 *  Produced by the agent-hooks capability on whichever host owns the workspace
 *  (so it is correct for remote workspaces too); the renderer imports only the
 *  type. */
export interface AgentHookAgentState {
  agentId: AgentId
  displayName: string
  /** The agent's own config folder (.claude, .codex, …) exists in the repo —
   *  the signal 'auto' gates on. */
  folderPresent: boolean
  /** A repo hook file carrying Cate's marker is present (we've injected here). */
  injected: boolean
}

export interface AgentHookSpec {
  /**
   * Workspace-scoped hook files (claude's .claude/settings.local.json,
   * codex's .codex/hooks.json, pi's .pi/extensions/cate-hook.ts,
   * opencode's .opencode/plugin/cate-hook.js) — the ONLY injection channel:
   * every agent is reached this way, so every agent gets the same tri-state.
   * `build`
   * returns the file's new content given the existing one, or null to leave
   * the file untouched. Update policy is per-file: a SHARED file (claude's
   * settings, which also carries user config; codex's hooks.json, where users
   * may keep their own hooks) is merged — our entries (marked by the
   * CATE_HOOK_MARKER) are replaced/refreshed, every user entry is preserved,
   * an unparseable file is left alone; a file Cate owns outright (pi's
   * extension, marked in its header comment) is rewritten whenever its
   * content differs.
   */
  projectFiles?: Array<{
    relPath: string
    build(existing: string | null, ctx: HookInjectionContext): string | null
    /**
     * Inverse of `build` for the 'off' mode: remove Cate's entries from the
     * existing file. Returns null to leave it untouched (nothing of ours is
     * present), `{ delete: true }` to remove a file Cate owns outright (pi's
     * extension), or `{ content }` to rewrite a SHARED file with only our
     * entries stripped (every user entry preserved). Absent → 'off' cannot
     * reclaim this file, so it is merely not refreshed.
     */
    strip?(existing: string): AgentHookStrip
  }>
  /** Normalize one raw payload posted by this agent's bridge. Null = drop
   *  (an event Cate doesn't track, e.g. claude's idle_prompt notification). */
  normalize(payload: Record<string, unknown>): NormalizedHookFields | null
}

/** Marker every generated bridge/wrapper path contains — how the project-file
 *  merge recognizes (and refreshes) Cate's own entries when the bridge path
 *  changes (the hooks dir is stable across boots, but an app relocation or a
 *  file written by an older per-boot-dir version leaves stale paths behind). */
export const CATE_HOOK_MARKER = 'cate-hook'

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

// ---------------------------------------------------------------------------
// Shared {hooks: {<Event>: [groups]}} file merge — claude's
// settings.local.json and codex's hooks.json use the same shape.
// ---------------------------------------------------------------------------

/** One matcher-group per event, holding only our bridge command. */
interface HookGroup {
  matcher?: unknown
  hooks?: Array<{ type?: unknown; command?: unknown }>
  [k: string]: unknown
}

interface SharedHooksJson {
  hooks?: Record<string, HookGroup[]>
  [k: string]: unknown
}

/**
 * Merge OUR one-command group into every tracked event of a SHARED hooks file.
 * Merge, never clobber: the file also carries user content (claude's "always
 * allow" grants, a user's own codex hooks), so every user field and every user
 * hook group is preserved. Only groups consisting solely of STALE Cate bridge
 * entries (recognized by the marker) are dropped, then the fresh group is
 * appended per tracked event. Returns the new content, or null to leave the
 * file untouched (unparseable, or already correct).
 */
function mergeSharedHooksFile(
  existing: string | null,
  events: readonly string[],
  oursGroup: () => HookGroup,
): string | null {
  if (existing === null) {
    return JSON.stringify({ hooks: Object.fromEntries(events.map((e) => [e, [oursGroup()]])) }, null, 2) + '\n'
  }
  let parsed: SharedHooksJson
  try {
    parsed = JSON.parse(existing) as SharedHooksJson
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  } catch {
    return null
  }
  // The !Array.isArray guard is load-bearing: a `"hooks": []` value passes
  // the typeof-object check, and named keys assigned onto an array are
  // silently dropped by JSON.stringify — the file would look merged but
  // carry no hooks.
  const hooks: Record<string, HookGroup[]> =
    typeof parsed.hooks === 'object' && parsed.hooks !== null && !Array.isArray(parsed.hooks)
      ? parsed.hooks
      : {}
  for (const event of events) {
    const kept: HookGroup[] = []
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
}

/**
 * Inverse of mergeSharedHooksFile: drop OUR bridge entries from every tracked
 * event, preserving every user entry and field, and prune events left empty by
 * the removal. Returns { content } when anything of ours was removed, or null
 * when the file has nothing of ours / is unparseable (leave it alone). Never
 * deletes the file — it is shared with the user's own hooks.
 */
function stripSharedHooksFile(existing: string, events: readonly string[]): AgentHookStrip {
  let parsed: SharedHooksJson
  try {
    parsed = JSON.parse(existing) as SharedHooksJson
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  } catch {
    return null
  }
  if (typeof parsed.hooks !== 'object' || parsed.hooks === null || Array.isArray(parsed.hooks)) return null
  const hooks = parsed.hooks as Record<string, HookGroup[]>
  let changed = false
  for (const event of events) {
    if (!Array.isArray(hooks[event])) continue
    const kept: HookGroup[] = []
    for (const group of hooks[event]) {
      if (typeof group !== 'object' || group === null) {
        kept.push(group)
        continue
      }
      const entries = Array.isArray(group.hooks) ? group.hooks : []
      const filtered = entries.filter(
        (h) => !(typeof h?.command === 'string' && h.command.includes(CATE_HOOK_MARKER)),
      )
      if (entries.length > 0 && filtered.length === 0) {
        changed = true // group was purely ours — drop it
        continue
      }
      if (filtered.length !== entries.length) {
        changed = true
        kept.push({ ...group, hooks: filtered })
      } else {
        kept.push(group)
      }
    }
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  }
  if (!changed) return null
  return { content: JSON.stringify({ ...parsed, hooks }, null, 2) + '\n' }
}

/** The repo-local config folder whose presence gates 'auto' injection for one
 *  agent (`.claude`, `.codex`, `.cursor`, `.opencode`, `.pi`), or null for an
 *  agent that writes no project files. Derived from the agent's first project
 *  file so it stays in lockstep with the spec. */
export function agentHookFolder(agentId: AgentId): string | null {
  const rel = AGENT_HOOK_SPECS[agentId]?.projectFiles?.[0]?.relPath
  if (!rel) return null
  return rel.split('/')[0]
}

// ---------------------------------------------------------------------------
// claude — hooks ride in <workspace>/.claude/settings.local.json (project
// scope, merged by claude over user settings; same file whether claude is in
// TUI or -p mode). File injection on purpose: the original per-invocation
// `--settings` argv channel was launch-method dependent — every rc-file
// `export PATH="~/.local/bin:$PATH"` prepend (uv/bun/brew boilerplate — and
// claude installs into ~/.local/bin), alias, and absolute-path launch
// silently sidestepped it. JSON payload on hook stdin;
// session_id/transcript_path/cwd on every event.
// ---------------------------------------------------------------------------

const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'PostToolUse', 'Stop', 'SessionEnd']

const claudeSpec: AgentHookSpec = {
  projectFiles: [
    {
      relPath: '.claude/settings.local.json',
      // Shared with claude's own writes (its "always allow" permission grants
      // land in this file) — merged, never clobbered.
      build: (existing, ctx) =>
        mergeSharedHooksFile(existing, CLAUDE_EVENTS, () => ({
          hooks: [{ type: 'command', command: ctx.bridgeCommand }],
        })),
      strip: (existing) => stripSharedHooksFile(existing, CLAUDE_EVENTS),
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
// codex — hooks ride in <project>/.codex/hooks.json (repo scope, discovered
// by codex itself). File injection on purpose: the earlier six per-invocation
// `-c` overrides were argv injection, which any alias, rc-file PATH prepend,
// or absolute-path launch silently bypasses. Codex loads project hooks ONLY
// from a folder the user trusts, and unknown hooks get a ONE-TIME interactive
// review prompt (non-interactive runs silently skip them); on "trust", codex
// persists the grant in ITS OWN user state, keyed by the hook source path and
// a hash of the handler identity. That trust key is why the bridge command
// path must stay stable across app restarts (see the stable hooks dir in
// runtime/capabilities/agentHooks.ts) — a churning path would re-prompt
// "modified since last trusted" on every boot. Schema + trust behavior pinned
// live by agentHookContracts.itest.ts.
// ---------------------------------------------------------------------------

/** sha256 of codex's canonical handler identity — the recipe codex checks a
 *  hooks.state trusted_hash against, verified live (see
 *  agentHookContracts.itest.ts trustedHash). Product code no longer plants
 *  trust (the user grants it once in codex's own review prompt); the builder
 *  stays exported for the pinned-vector test and the live suite's harness. */
export function codexTrustedHash(label: string, command: string, timeout: number): string {
  const identity =
    `{"event_name":${JSON.stringify(label)},"hooks":[{"async":false,` +
    `"command":${JSON.stringify(command)},"timeout":${timeout},"type":"command"}]}`
  return 'sha256:' + createHash('sha256').update(identity).digest('hex')
}

/** hooks.json event keys (CamelCase). Codex's own trust-state keys use
 *  snake_case labels of these same events — a codex quirk the live suite's
 *  trust harness mirrors. */
const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop']

const CODEX_HOOK_TIMEOUT = 60

const codexSpec: AgentHookSpec = {
  projectFiles: [
    {
      relPath: '.codex/hooks.json',
      // Shared with the user's own codex hooks — merged, never clobbered.
      build: (existing, ctx) =>
        mergeSharedHooksFile(existing, CODEX_EVENTS, () => ({
          hooks: [{ type: 'command', command: ctx.bridgeCommand, timeout: CODEX_HOOK_TIMEOUT }],
        })),
      strip: (existing) => stripSharedHooksFile(existing, CODEX_EVENTS),
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
// cursor — JSON-on-stdin hooks configured in <workspace>/.cursor/hooks.json
// (project scope, discovered by the CLI itself; schema differs from the
// claude/codex shared shape: {version: 1, hooks: {<event>: [{command}]}}).
// Hooks fire in the CLI since ~2026.07 (pinned live 2026-07-19 against
// 2026.07.16-899851b). session_id (= conversation_id) on every event;
// payload cwd is often "" — workspace_roots[0] is the real join key.
// transcript_path is null on sessionStart, set from the first tool/turn
// event on.
//
// Turn coverage is TUI-only: print mode (-p) fires sessionStart, tool events
// and sessionEnd but NEVER beforeSubmitPrompt/stop. sessionStart does NOT
// fire on --resume — the tracker keys on whatever event carries the id first.
// stop fires on abort too (status "aborted", sometimes followed by a second
// "error" stop — idempotent for the FSM).
//
// NO permission-wait mapping on purpose: cursor has no dedicated permission
// hook event (pinned live). beforeShellExecution fires before EVERY shell
// command — auto-approved or prompted alike, and before the command RUNS, not
// just before a prompt — so mapping it would flag every approved long-running
// command as "waiting" and fire a needs-permission notification per shell
// call. During a real approval prompt cursor therefore shows 'running' until
// the user answers; postToolUse (turn-resume) re-asserts the turn afterwards.
// ---------------------------------------------------------------------------

const CURSOR_EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'stop', 'sessionEnd']

interface CursorHooksJson {
  version?: unknown
  hooks?: Record<string, Array<{ command?: unknown }>>
  [k: string]: unknown
}

const cursorSpec: AgentHookSpec = {
  projectFiles: [
    {
      relPath: '.cursor/hooks.json',
      // Shared with the user's own cursor hooks — merged, never clobbered.
      // Not mergeSharedHooksFile: cursor's per-event entries are flat
      // [{command}] handlers, not {matcher, hooks: [...]} groups.
      build: (existing, ctx) => {
        const ours = (): CursorHooksJson => ({
          version: 1,
          hooks: Object.fromEntries(CURSOR_EVENTS.map((e) => [e, [{ command: ctx.bridgeCommand }]])),
        })
        if (existing === null) return JSON.stringify(ours(), null, 2) + '\n'
        let parsed: CursorHooksJson
        try {
          parsed = JSON.parse(existing) as CursorHooksJson
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
        } catch {
          return null
        }
        // The !Array.isArray guard is load-bearing (same bug class as the
        // shared merge): a `"hooks": []` value passes typeof-object, and named
        // keys assigned onto an array vanish in JSON.stringify.
        const hooks: Record<string, Array<{ command?: unknown }>> =
          typeof parsed.hooks === 'object' && parsed.hooks !== null && !Array.isArray(parsed.hooks)
            ? parsed.hooks
            : {}
        for (const event of CURSOR_EVENTS) {
          const kept = (Array.isArray(hooks[event]) ? hooks[event] : []).filter(
            (h) => !(typeof h?.command === 'string' && h.command.includes(CATE_HOOK_MARKER)),
          )
          hooks[event] = [...kept, { command: ctx.bridgeCommand }]
        }
        const out = JSON.stringify({ version: parsed.version ?? 1, ...parsed, hooks }, null, 2) + '\n'
        return out === existing ? null : out
      },
      strip: (existing) => {
        let parsed: CursorHooksJson
        try {
          parsed = JSON.parse(existing) as CursorHooksJson
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
        } catch {
          return null
        }
        if (typeof parsed.hooks !== 'object' || parsed.hooks === null || Array.isArray(parsed.hooks)) return null
        const hooks = parsed.hooks
        let changed = false
        for (const event of CURSOR_EVENTS) {
          if (!Array.isArray(hooks[event])) continue
          const kept = hooks[event].filter(
            (h) => !(typeof h?.command === 'string' && h.command.includes(CATE_HOOK_MARKER)),
          )
          if (kept.length !== hooks[event].length) changed = true
          if (kept.length === 0) delete hooks[event]
          else hooks[event] = kept
        }
        if (!changed) return null
        return { content: JSON.stringify({ ...parsed, hooks }, null, 2) + '\n' }
      },
    },
  ],
  normalize: (p) => {
    const roots = Array.isArray(p.workspace_roots) ? p.workspace_roots : []
    const base = {
      // session_id and conversation_id are the same uuid on every observed
      // event; keep the fallback in case one spelling disappears in an update.
      sessionId: str(p.session_id) ?? str(p.conversation_id),
      cwd: str(roots[0]) ?? undefined,
      transcriptPath: str(p.transcript_path) ?? undefined,
    }
    switch (p.hook_event_name) {
      case 'sessionStart': return { kind: 'session-start', ...base }
      case 'beforeSubmitPrompt': return { kind: 'turn-start', ...base }
      // Fires after EVERY executed tool call — the idempotent "turn is
      // running" re-assertion (and the only turn signal print mode has).
      case 'postToolUse': return { kind: 'turn-resume', ...base }
      case 'stop': return { kind: 'turn-end', ...base }
      case 'sessionEnd': return { kind: 'session-end', ...base }
      default: return null
    }
  },
}

// ---------------------------------------------------------------------------
// pi — in-process extension auto-discovered from <cwd>/.pi/extensions/*.ts
// (project scope, `--no-extensions` disables). File injection on purpose: the
// original `-e <tempfile>` argv channel was launch-method dependent (any
// rc-file PATH prepend, alias, or absolute-path launch silently bypassed
// it) — the same failure mode that moved claude's hooks into its settings
// file. Cate owns
// cate-hook.ts outright; it self-gates on the Cate env vars, so it is inert
// if committed and loaded by a teammate's pi. Identity from
// ctx.sessionManager on every event; agent_start/agent_end bracket each turn.
// The extension posts to the daemon itself (fetch), so no bridge process
// runs.
// ---------------------------------------------------------------------------

const PI_EXTENSION_SOURCE = `// cate-hook — generated by Cate (agent hook injection); do not edit.
// Inert outside Cate terminals: it no-ops unless the CATE_HOOK_* env vars are set.
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
        pid: process.pid, // in-process: this IS the agent, for presence tracking
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
  projectFiles: [
    {
      relPath: '.pi/extensions/cate-hook.ts',
      // Cate owns this whole file (the header marker says so): rewrite on any
      // drift — including a user edit — and leave every other file in
      // .pi/extensions/ alone. The content is boot-independent (the endpoint
      // rides in env), so an up-to-date file is never rewritten.
      build: (existing) => (existing === PI_EXTENSION_SOURCE ? null : PI_EXTENSION_SOURCE),
      // Cate owns this file outright (header marker). Remove it wholesale;
      // leave a user file that merely shares the name (no marker) alone.
      strip: (existing) => (existing.includes(CATE_HOOK_MARKER) ? { delete: true } : null),
    },
  ],
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
// grok (xAI Grok Build) — hooks ride in <project>/.grok/hooks/cate.json. Grok
// loads every *.json in that dir, so Cate owns one file there outright rather
// than merging into a shared one (pi-style ownership, codex-style trust).
//
// Two grok-specific quirks, both pinned live by agentHookContracts.itest.ts:
//
//  · Casing is split: the FILE keys events in CamelCase ("SessionStart"), the
//    PAYLOAD reports them in snake_case ("session_start") on a camelCase
//    envelope (sessionId / workspaceRoot / toolName). Neither spelling is a
//    typo; both are contract.
//  · Grok also scans OTHER vendors' hook files — <project>/.claude/settings
//    .json + settings.local.json — by default. Cate injects its claude bridge
//    into settings.local.json, so a grok session fires the CLAUDE wrapper too,
//    with a grok payload. The bridge drops those posts (see BRIDGE_JS's
//    GROK_HOOK_EVENT guard); without it a grok terminal would be labelled
//    Claude Code and offered claude's resume command.
//
// Project hooks are gated on grok's folder trust: until the user runs
// /hooks-trust, the file is silently inert (no error, no events) — and grok
// resolves a project root only inside a git repo, so a non-repo workspace
// never loads them at all. Both are normal, not failure states.
// ---------------------------------------------------------------------------

const GROK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'PostToolUse', 'Stop', 'SessionEnd']

const GROK_HOOK_TIMEOUT = 60

const grokSpec: AgentHookSpec = {
  projectFiles: [
    {
      // `cate.json` is ours alone — grok merges every file in the dir, so a
      // user's own hooks live beside it untouched.
      relPath: `.grok/hooks/${CATE_HOOK_MARKER}.json`,
      build: (existing, ctx) =>
        mergeSharedHooksFile(existing, GROK_EVENTS, () => ({
          hooks: [{ type: 'command', command: ctx.bridgeCommand, timeout: GROK_HOOK_TIMEOUT }],
        })),
      strip: (existing) => (existing.includes(CATE_HOOK_MARKER) ? { delete: true } : null),
    },
  ],
  normalize: (p) => {
    const base = {
      sessionId: str(p.sessionId),
      cwd: str(p.cwd) ?? undefined,
      // Absent on session_start (the session file does not exist yet); the
      // updates.jsonl path from the first prompt onwards.
      transcriptPath: str(p.transcriptPath) ?? undefined,
    }
    switch (p.hookEventName) {
      case 'session_start': return { kind: 'session-start', ...base }
      case 'user_prompt_submit': return { kind: 'turn-start', ...base }
      // Fires after every executed tool call; the one following a
      // permission_prompt is the approval resolution.
      case 'post_tool_use': return { kind: 'turn-resume', ...base }
      case 'stop': return { kind: 'turn-end', ...base }
      case 'session_end': return { kind: 'session-end', ...base }
      case 'notification':
        // permission_prompt = parked on tool approval. PreToolUse fires ~30ms
        // earlier for the same call but precedes EVERY tool, approved or not,
        // so it cannot mark the wait — which is why it isn't injected at all.
        return p.notificationType === 'permission_prompt' ? { kind: 'permission-wait', ...base } : null
      default: return null
    }
  },
}

// ---------------------------------------------------------------------------
// opencode — an in-process plugin at <project>/.opencode/plugin/cate-hook.js.
// opencode scans `{plugin,plugins}/*.{ts,js}` under every config directory it
// resolves and imports each match at startup (verified against the 1.18.3
// binary: a probe file in .opencode/plugin/ was loaded and received
// session.created / session.status / session.idle). Two contract details that
// suite pins: the extension must be .js (.mjs is outside the glob), and EVERY
// exported factory is invoked — not just the default — hence a single named
// export here.
//
// This replaced an earlier OPENCODE_CONFIG_CONTENT ambient-env injection. The
// repo file is the documented channel, it survives a user who sets that var
// themselves, and it puts opencode on the same Auto/On/Off tri-state (and the
// same ownership/strip rules) as every other agent.
//
// The plugin forwards only the five bus events Cate tracks; the bus is
// otherwise chatty (message parts, plugin.added, catalog.updated…).
// ---------------------------------------------------------------------------

const OPENCODE_PLUGIN_SOURCE = `// cate-hook — generated by Cate (agent hook injection); do not edit.
// Inert outside Cate terminals: it no-ops unless the CATE_HOOK_* env vars are set.
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
          pid: process.pid, // in-process: this IS the agent, for presence tracking
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
  projectFiles: [
    {
      // `.js`, not `.mjs`: opencode's scan glob is `*.{ts,js}` only.
      relPath: '.opencode/plugin/cate-hook.js',
      // Cate owns this whole file (the header marker says so): rewrite on any
      // drift and leave every other file in .opencode/plugin/ alone. The
      // content is boot-independent (the endpoint rides in env), so an
      // up-to-date file is never rewritten.
      build: (existing) => (existing === OPENCODE_PLUGIN_SOURCE ? null : OPENCODE_PLUGIN_SOURCE),
      strip: (existing) => (existing.includes(CATE_HOOK_MARKER) ? { delete: true } : null),
    },
  ],
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
// Registry + normalization entry point
// ---------------------------------------------------------------------------

export const AGENT_HOOK_SPECS: Record<AgentId, AgentHookSpec> = {
  'claude-code': claudeSpec,
  codex: codexSpec,
  cursor: cursorSpec,
  grok: grokSpec,
  pi: piSpec,
  opencode: opencodeSpec,
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
