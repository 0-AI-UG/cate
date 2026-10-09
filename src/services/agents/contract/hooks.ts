// Agent hook declarations: the per-CLI specs that turn each agent CLI's
// hook, extension or plugin surface into one normalized event stream. Each
// entry says how hooks are injected (workspace files or a profile plugin, plus
// PTY env), how a raw payload normalizes into an AgentHookEvent, which
// completed tool call it reports for edit capture, and how a user interrupt
// ends a turn. Raw payloads are read here and nowhere else.
//
// The injection and payload contracts are pinned live against the installed
// CLIs by the agent hook contract suite; the shapes here follow it. Pure.

import type { AgentId } from './registry'
import type { AgentApprovalDetection, AgentApprovalMode } from './approvalModes'

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
  /** Cate resolved the CLI's own persisted chat title for this session. This
   *  is transported on the hook stream because it has the same terminal +
   *  session identity, but it is metadata rather than a hook lifecycle edge. */
  | 'session-title'
  | 'turn-start'
  | 'turn-end'
  /** A permission decision is in progress; it may be resolved automatically.
   *  This is NOT evidence that a human needs to respond. */
  | 'permission-check'
  /** The CLI confirmed that a human permission prompt is waiting. */
  | 'permission-wait'
  /** An idempotent "the turn is running" re-assertion. OpenCode emits it when
   *  a permission reply arrives; other CLIs emit it after a tool completes.
   *  Claude/Codex/Grok do not hook the actual approval reply, so
   *  runtime PTY input supplies that earlier resume edge. */
  | 'turn-resume'
  /** Runtime-observed PTY Enter, ordered with hooks rather than guessed in
   *  the status machine. Carries no typed text. */
  | 'input-submit'

export interface AgentHookEvent {
  /** The pty id whose env the hook echoed back (CATE_TERMINAL_ID). */
  terminalId: string
  agentId: AgentId
  kind: AgentHookEventKind
  /** The CLI's own session/conversation id, or null when the event doesn't
   *  carry one (e.g. a malformed payload field). */
  sessionId: string | null
  /** The CLI's turn id when available. End events are correlated against this
   *  so a late end from an interrupted turn cannot idle its replacement. */
  turnId?: string
  /** The cwd the CLI reports for the session (its store join key), when the
   *  payload carries one. */
  cwd?: string
  /** The transcript / rollout / session file backing the session, when the
   *  payload carries one. */
  transcriptPath?: string
  /** Named CLI profile that owns the session, when the agent exposes one. */
  profile?: string
  /** Process that emitted an in-process hook; never persisted. */
  sourcePid?: number
  /** Monotonic process-start clock supplied by an in-process hook. */
  sourceStartedAt?: string
  /** Present only for session-title events. */
  title?: string
  /** permission-check only: the CLI's resolved approval config, read on the
   *  runtime's machine (the fallback for an ambiguous check). */
  approvalMode?: AgentApprovalMode
  /** permission-check / permission-wait only: what the agent asks to do, when the CLI says. */
  permission?: string
  /** turn-end only: the runtime recovered this turn end from a user
   *  interrupt the CLI did not report (see AgentHookSpec.interrupt). */
  interrupted?: true
  /** The raw payload as posted by the bridge, for consumers that need
   *  per-CLI detail (e.g. codex's turn_id / tool_input on permission-wait). */
  raw: Record<string, unknown>
}

/** One completed, successful tool call reported by a hook payload: the input
 *  edit capture consumes. Each agent's spec maps its own payload spelling onto
 *  this, so nothing downstream reads raw CLI payloads. */
export interface AgentToolCall {
  sessionId: string | null
  turnId?: string
  name: string
  input: unknown
  output: unknown
  /** The CLI's id for this call; a retried post of the same call dedupes on it. */
  callId?: string
  /** Where the tool ran, when the payload says and no lifecycle event does. */
  cwd?: string
  /** The spawning session, when the call ran in a subagent session. */
  parentSessionId?: string
}

export type NormalizedHookFields = Pick<AgentHookEvent, 'kind' | 'sessionId'> &
  Partial<Pick<AgentHookEvent, 'cwd' | 'transcriptPath' | 'profile' | 'permission'>>

export function normalizeAgentSourceStartedAt(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[0-9]{1,32}$/.test(value)) return undefined
  try { return BigInt(value) > 0n ? BigInt(value).toString() : undefined } catch { return undefined }
}

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
/** Result of a projectFile's `strip`: leave it (null), delete an owned file,
 *  or rewrite a shared file without our entries. */
export type AgentHookStrip = null | { delete: true } | { content: string }

/** Live per-agent injection state for one workspace, for the Settings UI.
 *  Produced by the workspace's runtime; clients import only the type. */
export interface AgentHookAgentState {
  agentId: AgentId
  displayName: string
  /** The agent's own config folder (.claude, .codex, …) exists in the repo —
   *  the signal 'auto' gates on. */
  folderPresent: boolean
  /** A repo hook file carrying Cate's marker is present (we've injected here). */
  injected: boolean
  /** How this CLI's permission requests are told apart (docs/agent-activity.md). */
  approvalDetection?: AgentApprovalDetection
}

export interface AgentHookSpec {
  /**
   * How a USER INTERRUPT (Esc / Ctrl+C) ends the running turn, the one turn
   * boundary that is not a normal completion. Each was verified live against
   * the real CLI.
   *  - hook: the CLI pushes an event normalize() maps to turn-end (codex's
   *    Interrupt, cursor's stop{status:aborted}, opencode's idle status).
   *  - transcript: no hook fires, but the CLI appends `marker` to its
   *    transcript; the runtime tails it during a turn and emits the turn-end.
   *  - input: no hook and no transcript marker; the runtime ends a hook-proven
   *    active turn on the terminal's own Ctrl-C input edge.
   * Recovered turn-ends carry `interrupted: true`.
   */
  interrupt: { via: 'hook' } | { via: 'transcript'; marker: RegExp } | { via: 'input' }
  /**
   * Workspace-scoped hook files (claude's .claude/settings.local.json,
   * codex's .codex/hooks.json, and opencode's .opencode/plugin/cate-hook.js)
   * are the ONLY injection channel:
   * every agent is reached this way, so every agent gets the same tri-state.
   * `build`
   * returns the file's new content given the existing one, or null to leave
   * the file untouched. Update policy is per-file: a SHARED file (claude's
   * settings, which also carries user config; codex's hooks.json, where users
   * may keep their own hooks) is merged — our entries (marked by the
   * CATE_HOOK_MARKER) are replaced/refreshed, every user entry is preserved,
   * an unparseable file is left alone; a file Cate owns outright is rewritten whenever its
   * content differs.
   */
  projectFiles?: Array<{
    relPath: string
    build(existing: string | null, ctx: HookInjectionContext): string | null
    /**
     * Inverse of `build` for the 'off' mode: remove Cate's entries from the
     * existing file. Returns null to leave it untouched (nothing of ours is
     * present), `{ delete: true }` to remove a file Cate owns outright,
     * or `{ content }` to rewrite a SHARED file with only our
     * entries stripped (every user entry preserved). Absent → 'off' cannot
     * reclaim this file, so it is merely not refreshed.
     */
    strip?(existing: string): AgentHookStrip
  }>
  /** Profile-scoped plugin managed on the runtime host instead of in the
   *  repo. The runtime installs it (and reports it as injected) by this id. */
  externalPlugin?: { id: string }
  /** Extra env this CLI needs on every Cate PTY, given whether its hooks are
   *  enabled there. Never overrides a variable the user already set. */
  ptyEnv?(hooksEnabled: boolean): Record<string, string>
  /** Normalize one raw payload posted by this agent's bridge. Null = drop
   *  (an event Cate doesn't track, e.g. claude's idle_prompt notification). */
  normalize(payload: Record<string, unknown>): NormalizedHookFields | null
  /** The completed, successful tool call this payload reports, or null. */
  toolCall(payload: Record<string, unknown>): AgentToolCall | null
  /** The CLI re-announces turn-start while a turn is already running (so a
   *  repeated turn-start without a turn id is the same turn, not a new one). */
  repeatsTurnStart?: boolean
  /**
   * A reserved env var this CLI's hook runner sets on every hook process it
   * spawns (and strips from user-supplied env), so its presence means "this
   * CLI ran me". A CLI that also runs other vendors' hook files thereby fires
   * their bridges with its own payload; the bridge drops a post whose
   * wrapper's agent disagrees with the runner the var names.
   */
  hookRunnerEnv?: string
}

/** Marker every generated bridge/wrapper path contains — how the project-file
 *  merge recognizes (and refreshes) Cate's own entries when the bridge path
 *  changes (the hooks dir is stable across boots, but an app relocation or a
 *  file written by an older per-boot-dir version leaves stale paths behind). */
export const CATE_HOOK_MARKER = 'cate-hook'

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}

/** The `permission` field for a permission-wait, from the CLI's own wording. */
function permission(detail: unknown): Pick<AgentHookEvent, 'permission'> {
  return typeof detail === 'string' && detail.trim() ? { permission: detail.trim() } : {}
}

/** The turn id a payload carries, in any CLI's spelling. */
function payloadTurnId(p: Record<string, unknown>): string | undefined {
  return str(p.turn_id) ?? str(p.turnId) ?? str(p.promptId) ?? undefined
}

/** A reported tool call, unless the CLI marked it failed. The CLIs all flag
 *  failure one of these ways, on the tool output or the payload itself. */
function succeededToolCall(p: Record<string, unknown>, call: Omit<AgentToolCall, 'turnId'>): AgentToolCall | null {
  const output = obj(call.output)
  if (output.is_error === true || output.success === false || p.success === false || p.error_type
    || ['error', 'failed', 'declined'].includes(String(output.status ?? p.status))) return null
  return { ...call, turnId: payloadTurnId(p) }
}

/** The shape shared by the CLIs with snake_case PostToolUse-style payloads. */
function snakeCaseToolCall(p: Record<string, unknown>, sessionId: string | null): AgentToolCall | null {
  return succeededToolCall(p, {
    sessionId,
    name: str(p.tool_name) ?? '',
    input: p.tool_input,
    output: p.tool_response,
    callId: str(p.tool_use_id) ?? undefined,
    cwd: str(p.cwd) ?? undefined,
  })
}

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
  oursGroup: (event: string) => HookGroup,
): string | null {
  if (existing === null) {
    return JSON.stringify({ hooks: Object.fromEntries(events.map((e) => [e, [oursGroup(e)]])) }, null, 2) + '\n'
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
    hooks[event] = [...kept, oursGroup(event)]
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

const CLAUDE_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Notification',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'Stop', 'StopFailure', 'SessionEnd',
]

/** Claude and Codex subagents inherit the parent's terminal env and post with
 *  `agent_id` set. Their approval and Stop hooks must not change the parent
 *  terminal's activity or announce it as ready; edit capture still reads them. */
const isChildAgentPayload = (p: Record<string, unknown>): boolean =>
  typeof p.agent_id === 'string' && p.agent_id !== ''

const claudeSpec: AgentHookSpec = {
  // No hook fires on a user interrupt, but claude appends a user-role message
  // "[Request interrupted by user]" (also the "…for tool use" variant) to its
  // transcript when a turn is aborted. Verified live against the CLI.
  interrupt: { via: 'transcript', marker: /\[Request interrupted by user/ },
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
    if (isChildAgentPayload(p)) return null
    const base = {
      sessionId: str(p.session_id),
      cwd: str(p.cwd) ?? undefined,
      transcriptPath: str(p.transcript_path) ?? undefined,
    }
    switch (p.hook_event_name) {
      case 'SessionStart': return { kind: 'session-start', ...base }
      case 'UserPromptSubmit': return { kind: 'turn-start', ...base }
      // PreToolUse is activity, not evidence that approval was granted.
      case 'PreToolUse': return { kind: 'turn-resume', ...base }
      // Fires after EVERY executed tool call. This confirms the turn is still
      // active and remains a fallback resume edge for older Claude versions.
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied': return { kind: 'turn-resume', ...base }
      case 'Stop': return { kind: 'turn-end', ...base }
      case 'StopFailure': return { kind: 'turn-end', ...base }
      case 'SessionEnd': return { kind: 'session-end', ...base }
      // Other hooks may resolve a PermissionRequest automatically.
      case 'PermissionRequest': return { kind: 'permission-check', ...base, ...permission(p.message) }
      // This notification confirms a human prompt. Claude applies its own
      // delay (about six seconds).
      case 'Notification':
        return p.notification_type === 'permission_prompt'
          ? { kind: 'permission-wait', ...base, ...permission(p.message) }
          : null
      default: return null
    }
  },
  toolCall: (p) => p.hook_event_name === 'PostToolUse' ? snakeCaseToolCall(p, str(p.session_id)) : null,
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
// runtime/hooks/agentHooks.ts) — a churning path would re-prompt
// "modified since last trusted" on every boot. Schema and trust behavior were
// verified live against codex.
// ---------------------------------------------------------------------------

/** hooks.json event keys (CamelCase). Codex's own trust-state keys use
 *  snake_case labels of these same events — a codex quirk the live suite's
 *  trust harness mirrors. */
const CODEX_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'Stop', 'Interrupt',
]

const CODEX_HOOK_TIMEOUT = 60

const codexSpec: AgentHookSpec = {
  // Current Codex emits Interrupt with the interrupted turn_id. Hook-native on
  // purpose: its transcript format is explicitly not a stable hook interface.
  interrupt: { via: 'hook' },
  projectFiles: [
    {
      relPath: '.codex/hooks.json',
      // Shared with the user's own codex hooks — merged, never clobbered.
      build: (existing, ctx) =>
        mergeSharedHooksFile(existing, CODEX_EVENTS, (event) => ({
          hooks: [{
            type: 'command',
            command: ctx.bridgeCommand,
            timeout: event === 'Interrupt' ? 3 : CODEX_HOOK_TIMEOUT,
          }],
        })),
      strip: (existing) => stripSharedHooksFile(existing, CODEX_EVENTS),
    },
  ],
  // Codex's shared app-server daemon launches hooks with the daemon's
  // environment, so a hook cannot identify the terminal that submitted a
  // prompt. An explicitly present (but empty) executor URL makes Codex use its
  // local executor and embedded app-server, preserving this PTY's hook
  // identity for a plain `codex` invocation. A user-selected executor URL wins.
  ptyEnv: (enabled): Record<string, string> => enabled ? { CODEX_EXEC_SERVER_URL: '' } : {},
  normalize: (p) => {
    if (isChildAgentPayload(p)) return null
    const base = {
      sessionId: str(p.session_id),
      cwd: str(p.cwd) ?? undefined,
      transcriptPath: str(p.transcript_path) ?? undefined,
    }
    switch (p.hook_event_name) {
      case 'SessionStart': return { kind: 'session-start', ...base }
      case 'UserPromptSubmit': return { kind: 'turn-start', ...base }
      case 'Stop': return { kind: 'turn-end', ...base }
      case 'Interrupt': return { kind: 'turn-end', ...base }
      // Runs BEFORE Codex chooses hooks, automatic review, or the user. The
      // hook's permission_mode describes policy, not the selected reviewer,
      // and Codex exposes no hook for the later human-prompt boundary: the
      // runtime reads its resolved approval config instead.
      case 'PermissionRequest':
        return { kind: 'permission-check', ...base, ...permission(obj(p.tool_input).command ?? p.tool_name) }
      // Fires after an approval is resolved and immediately before the tool
      // starts. This clears permission-wait while a long-running command is
      // executing instead of leaving the UI blocked until PostToolUse.
      case 'PreToolUse': return { kind: 'turn-resume', ...base }
      // Fires after EVERY executed tool call. This confirms the turn is still
      // active and remains a fallback resume edge for older Codex versions.
      case 'PostToolUse': return { kind: 'turn-resume', ...base }
      // SessionEnd never fires (pinned live) — no mapping on purpose.
      default: return null
    }
  },
  toolCall: (p) => p.hook_event_name === 'PostToolUse' ? snakeCaseToolCall(p, str(p.session_id)) : null,
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

const CURSOR_EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'afterFileEdit', 'stop', 'sessionEnd']

interface CursorHooksJson {
  version?: unknown
  hooks?: Record<string, Array<{ command?: unknown }>>
  [k: string]: unknown
}

const cursorSpec: AgentHookSpec = {
  // Interrupt (Esc) pushes stop{status:aborted} ~100ms later → turn-end.
  interrupt: { via: 'hook' },
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
      case 'afterFileEdit':
      case 'postToolUse': return { kind: 'turn-resume', ...base }
      case 'stop': return { kind: 'turn-end', ...base }
      case 'sessionEnd': return { kind: 'session-end', ...base }
      default: return null
    }
  },
  toolCall: (p) => {
    const sessionId = str(p.session_id) ?? str(p.conversation_id)
    // afterFileEdit carries the before/after fragments on the payload itself.
    if (p.hook_event_name === 'afterFileEdit') {
      return succeededToolCall(p, { sessionId, name: 'Edit', input: p, output: undefined, callId: str(p.tool_use_id) ?? undefined })
    }
    if (p.hook_event_name !== 'postToolUse') return null
    // Cursor also reports a generic Write completion (new contents only) for
    // the same edit, without a shared id; afterFileEdit is authoritative.
    if (p.tool_name === 'Write') return null
    return succeededToolCall(p, {
      sessionId,
      name: str(p.tool_name) ?? '',
      input: p.tool_input,
      output: p.tool_output,
      callId: str(p.tool_use_id) ?? undefined,
    })
  },
}

// ---------------------------------------------------------------------------
// grok (xAI Grok Build) — hooks ride in <project>/.grok/hooks/cate.json. Grok
// loads every *.json in that dir, so Cate owns one file there outright rather
// than merging into a shared one.
//
// Two grok-specific quirks, both verified live against grok:
//
//  · Casing is split: the FILE keys events in CamelCase ("SessionStart"), the
//    PAYLOAD reports them in snake_case ("session_start") on a camelCase
//    envelope (sessionId / workspaceRoot / toolName). Neither spelling is a
//    typo; both are contract.
//  · Grok also scans OTHER vendors' hook files — <project>/.claude/settings
//    .json + settings.local.json — by default. Cate injects its claude bridge
//    into settings.local.json, so a grok session fires the CLAUDE wrapper too,
//    with a grok payload. The bridge drops those posts (`hookRunnerEnv`:
//    GROK_HOOK_EVENT); without it a grok terminal would be labelled
//    Claude Code and offered claude's resume command.
//
// Project hooks are gated on grok's folder trust: until the user runs
// /hooks-trust, the file is silently inert (no error, no events) — and grok
// resolves a project root only inside a git repo, so a non-repo workspace
// never loads them at all. Both are normal, not failure states.
// ---------------------------------------------------------------------------

const GROK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'Notification', 'PostToolUse',
  'Stop', 'StopFailure', 'StopCancelled', 'SessionEnd',
]

const GROK_HOOK_TIMEOUT = 60

const grokSpec: AgentHookSpec = {
  // Current Grok emits StopCancelled on user interrupt; promptId correlates a
  // possibly-late cancellation with the turn it actually ended.
  interrupt: { via: 'hook' },
  hookRunnerEnv: 'GROK_HOOK_EVENT',
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
    // Root terminal state must not be ended by a child-agent completion.
    if (p.subagentType != null) return null
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
      // Fires after every executed tool call. Terminal input supplies the
      // earlier approval-answer edge for long-running approved tools.
      case 'post_tool_use': return { kind: 'turn-resume', ...base }
      case 'stop': return { kind: 'turn-end', ...base }
      case 'stop_failure': return { kind: 'turn-end', ...base }
      case 'stop_cancelled': return { kind: 'turn-end', ...base }
      case 'session_end': return { kind: 'session-end', ...base }
      case 'notification':
        // permission_prompt = parked on tool approval. PreToolUse fires ~30ms
        // earlier for the same call but precedes EVERY tool, approved or not,
        // so it cannot mark the wait — which is why it isn't injected at all.
        return p.notificationType === 'permission_prompt' ? { kind: 'permission-wait', ...base } : null
      default: return null
    }
  },
  // Subagent edits are real workspace edits, so unlike normalize() this keeps them.
  toolCall: (p) => p.hookEventName === 'post_tool_use'
    ? succeededToolCall(p, {
        sessionId: str(p.sessionId),
        name: str(p.toolName) ?? '',
        input: p.toolInput,
        output: p.toolResponse,
        callId: str(p.toolUseId) ?? undefined,
        cwd: str(p.cwd) ?? undefined,
      })
    : null,
}

// ---------------------------------------------------------------------------
// opencode — an in-process plugin at <project>/.opencode/plugin/cate-hook.js.
// opencode scans `{plugin,plugins}/*.{ts,js}` under every config directory it
// resolves and imports each match at startup (verified against the 1.18.3
// binary: a probe file in .opencode/plugin/ was loaded and received
// session.created / session.status). Two contract details that
// suite pins: the extension must be .js (.mjs is outside the glob), and EVERY
// exported factory is invoked — not just the default — hence a single named
// export here.
//
// This replaced an earlier OPENCODE_CONFIG_CONTENT ambient-env injection. The
// repo file is the documented channel, it survives a user who sets that var
// themselves, and it puts opencode on the same Auto/On/Off tri-state (and the
// same ownership/strip rules) as every other agent.
//
// The plugin forwards only the four bus events Cate tracks; the bus is
// otherwise chatty (message parts, plugin.added, catalog.updated…).
// ---------------------------------------------------------------------------

const OPENCODE_PLUGIN_SOURCE = `// cate-hook — generated by Cate (agent hook injection); do not edit.
// Inert outside Cate terminals: it no-ops unless the CATE_HOOK_* env vars are set.
const ENDPOINT = process.env.${CATE_HOOK_ENDPOINT_ENV}
const TOKEN = process.env.${CATE_HOOK_TOKEN_ENV}
const TRACKED = new Set(["session.created", "session.status", "permission.asked", "permission.replied", "message.part.updated"])
const SUBAGENT_SESSIONS = new Set()
const PARENT_SESSIONS = new Map()
async function promptContext() {
  try {
    const response = await fetch(ENDPOINT + "/prompt-context", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
      body: JSON.stringify({ agentId: "opencode", terminalId: process.env.${CATE_TERMINAL_ID_ENV} ?? null }),
    })
    return response.ok ? await response.text() : ""
  } catch { return "" }
}
export const CateHookBridge = async () => {
  if (!ENDPOINT || !TOKEN) return {}
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      const context = await promptContext()
      if (context) output.system.push(context)
    },
    event: async ({ event }) => {
      if (!event || !TRACKED.has(event.type)) return
      const props = event.properties ?? {}
      const sessionID = props.sessionID ?? props.part?.sessionID ?? props.info?.id ?? null
      if (sessionID && event.type === "session.created" && props.info?.parentID) {
        SUBAGENT_SESSIONS.add(sessionID)
        PARENT_SESSIONS.set(sessionID, props.info.parentID)
      }
      const editCompleted = event.type === "message.part.updated" && props.part?.type === "tool" && props.part.state?.status === "completed"
      if (event.type === "message.part.updated" && !editCompleted) return
      if (SUBAGENT_SESSIONS.has(sessionID) && !editCompleted) return
      fetch(ENDPOINT + "/hook", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
        body: JSON.stringify({
          agentId: "opencode",
          terminalId: process.env.${CATE_TERMINAL_ID_ENV} ?? null,
          pid: process.pid, // in-process: this IS the agent, for presence tracking
          payload: {
            type: event.type,
            sessionID,
            status: props.status ?? null,
            directory: props.info?.directory ?? null,
            permission: props.permission ?? null,
            metadata: props.metadata ?? null,
            ...(editCompleted ? { part: props.part, parentSessionId: PARENT_SESSIONS.get(sessionID) } : {}),
          },
        }),
      }).catch(() => {})
    },
  }
}
`

const opencodeSpec: AgentHookSpec = {
  // Interrupt (Ctrl+C) returns session.status to idle → turn-end.
  interrupt: { via: 'hook' },
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
        // session.status is OpenCode's canonical busy/idle lifecycle event.
        if ((p.status as { type?: unknown } | null)?.type === 'busy') return { kind: 'turn-start', ...base }
        return (p.status as { type?: unknown } | null)?.type === 'idle' ? { kind: 'turn-end', ...base } : null
      case 'permission.asked': return { kind: 'permission-wait', ...base, ...permission(obj(p.metadata).command) }
      // The user answered the permission prompt. Even a "reject" reply keeps
      // the turn in flight (the model receives the denial, produces text, and
      // idles), so every reply maps to turn-resume — the later turn-end
      // settles the state either way.
      case 'permission.replied': return { kind: 'turn-resume', ...base }
      default: return null
    }
  },
  // session.status busy repeats while one turn runs.
  repeatsTurnStart: true,
  toolCall: (p) => {
    const part = obj(p.part)
    const state = obj(part.state)
    if (p.type !== 'message.part.updated' || part.type !== 'tool' || state.status !== 'completed') return null
    return succeededToolCall(p, {
      sessionId: str(p.sessionID),
      name: str(part.tool) ?? '',
      input: state.input,
      output: state.metadata,
      callId: str(part.callID) ?? undefined,
      cwd: str(p.directory) ?? undefined,
      parentSessionId: str(p.parentSessionId) ?? undefined,
    })
  },
}

// ---------------------------------------------------------------------------
// kiro — standalone v1 hook file in <workspace>/.kiro/hooks/. Kiro's v3 engine
// documents session-start/userPromptSubmit/postToolUse/stop lifecycle payloads
// with session_id + cwd on JSON stdin. Cate owns this one file outright;
// every other user hook in the directory is untouched.
// ---------------------------------------------------------------------------

const KIRO_TRIGGERS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'] as const

function kiroHookSource(ctx: HookInjectionContext): string {
  return JSON.stringify({
    version: 'v1',
    hooks: KIRO_TRIGGERS.map((trigger) => ({
      name: `${CATE_HOOK_MARKER}-${trigger}`,
      trigger,
      action: { type: 'command', command: ctx.bridgeCommand },
    })),
  }, null, 2) + '\n'
}

const kiroSpec: AgentHookSpec = {
  // Verified live against Kiro CLI 2.19.0: Ctrl-C returns to the prompt with
  // neither a Stop hook nor a transcript marker.
  interrupt: { via: 'input' },
  projectFiles: [
    {
      relPath: '.kiro/hooks/cate-hook.json',
      build: (existing, ctx) => {
        const source = kiroHookSource(ctx)
        return existing === source ? null : source
      },
      strip: (existing) => (existing.includes(CATE_HOOK_MARKER) ? { delete: true } : null),
    },
  ],
  normalize: (p) => {
    const base = { sessionId: str(p.session_id), cwd: str(p.cwd) ?? undefined }
    switch (p.hook_event_name) {
      // Kiro CLI v3 emits canonical PascalCase. Keep documented legacy aliases
      // so payloads from older CLI releases remain useful during migration.
      case 'SessionStart':
      case 'agentSpawn':
      case 'sessionStart': return { kind: 'session-start', ...base }
      case 'UserPromptSubmit':
      case 'userPromptSubmit': return { kind: 'turn-start', ...base }
      case 'PostToolUse':
      case 'postToolUse': return { kind: 'turn-resume', ...base }
      case 'Stop':
      case 'stop': return { kind: 'turn-end', ...base }
      default: return null
    }
  },
  toolCall: (p) => p.hook_event_name === 'PostToolUse' || p.hook_event_name === 'postToolUse'
    ? snakeCaseToolCall(p, str(p.session_id))
    : null,
}

// ---------------------------------------------------------------------------
// Hermes — a profile-scoped Python plugin posts lifecycle and tool events to
// Cate's authenticated per-PTY endpoint. The managed plugin is a no-op outside
// Cate terminals and returns connected-panel context from pre_llm_call.
// ---------------------------------------------------------------------------

const HERMES_INTERACTIVE_PLATFORMS = new Set(['cli', 'tui'])

const hermesSpec: AgentHookSpec = {
  interrupt: { via: 'hook' },
  externalPlugin: { id: 'cate-agent-state' },
  // The profile-wide plugin reports only for terminals where it is enabled.
  ptyEnv: (enabled) => ({ CATE_HERMES_HOOKS: enabled ? '1' : '0' }),
  normalize: (p) => {
    const platform = str(p.platform)
    if (platform && !HERMES_INTERACTIVE_PLATFORMS.has(platform)) return null
    const base = {
      sessionId: str(p.session_id),
      turnId: str(p.turn_id),
      cwd: str(p.cwd) ?? undefined,
      profile: str(p.profile) ?? undefined,
    }
    switch (p.hook_event_name) {
      case 'on_session_start':
      case 'on_session_reset': return { kind: 'session-start', ...base }
      case 'pre_llm_call': return { kind: 'turn-start', ...base }
      case 'on_session_end': return { kind: 'turn-end', ...base }
      case 'pre_approval_request':
        // Smart review and plugin transports may resolve without a human.
        // Older bridges omit surface; absence is not proof of a human wait.
        return { kind: p.surface === 'cli' ? 'permission-wait' : 'permission-check', ...base }
      case 'post_approval_response': return { kind: 'turn-resume', ...base }
      // Confirms execution resumed even if an older/custom approval flow did
      // not emit post_approval_response; it also keeps status active across
      // ordinary tool calls while edit ingestion consumes the raw payload.
      case 'post_tool_call': return { kind: 'turn-resume', ...base }
      case 'on_session_finalize': return { kind: 'session-end', ...base }
      default: return null
    }
  },
  toolCall: (p) => p.hook_event_name === 'post_tool_call'
    ? succeededToolCall(p, {
        sessionId: str(p.session_id),
        name: str(p.tool_name) ?? '',
        input: p.args,
        output: p.result,
        callId: str(p.tool_call_id) ?? undefined,
        cwd: str(p.cwd) ?? undefined,
        parentSessionId: str(p.parent_session_id) ?? undefined,
      })
    : null,
}

// ---------------------------------------------------------------------------
// Registry + normalization entry point
// ---------------------------------------------------------------------------

export const AGENT_HOOK_SPECS: Record<AgentId, AgentHookSpec> = {
  'claude-code': claudeSpec,
  codex: codexSpec,
  cursor: cursorSpec,
  grok: grokSpec,
  hermes: hermesSpec,
  kiro: kiroSpec,
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
  const turnId = payloadTurnId(payload)
  return { terminalId, agentId: agentId as AgentId, raw: payload, turnId, ...fields }
}
