// =============================================================================
// LIVE agent-CLI hook contracts — pins, against the real installed CLIs, the
// hook / extension / plugin surface Cate's terminal integration builds on:
// push-based session identity (which session id a terminal's agent has open),
// turn status (prompt submitted / turn ended), and per-terminal correlation
// (an env var Cate sets on the PTY is echoed back by every hook event).
//
// This replaces the old store-probing contract suite: hooks are documented,
// versioned CLI surfaces, so the contract is stronger — but a CLI update can
// still move them, and that must fail HERE (loudly, pre-release), not in a
// user's restored terminal. Hooks are the ONLY session-identity source (no
// store-probe fallback exists anymore), so these contracts are load-bearing
// for terminal session restore.
//
// Per-CLI mechanism (all verified live 2026-07-18; claude file channel
// re-pinned 2026-07-19):
//   claude  · JSON-on-stdin hooks configured in <cwd>/.claude/
//             settings.local.json (project scope — launch-method independent,
//             unlike the --settings argv channel this replaced). session_id/
//             transcript_path/cwd on every event; /clear = SessionEnd(
//             reason=clear) + SessionStart(source=clear, new id). Works in
//             -p and TUI.
//             Permission-wait: Notification hook, notification_type
//             "permission_prompt" (and "idle_prompt" once idle nags kick in).
//             Approval resolution: PostToolUse fires once the approved tool
//             ran (denial produces no PostToolUse — the turn just Stops).
//   codex   · JSON-on-stdin hooks configured in <project root>/.codex/
//             hooks.json (repo scope, discovered by codex itself —
//             launch-method independent, unlike the six per-invocation -c
//             overrides this replaced; moved
//             2026-07-19). Project hooks load ONLY from a folder the user
//             TRUSTS, and unknown hooks are SILENTLY skipped until trusted
//             (interactive TUI: one-time review prompt; codex persists the
//             grant in its own user state). The shipped product relies on
//             that native trust UX; the tests below pre-plant the granted
//             state per-invocation as HARNESS ONLY (see trustArgs): folder
//             trust via -c projects={...} (inline-table form — the
//             dotted-path form silently no-ops) and hook trust via -c
//             hooks.state keyed "<root>/.codex/hooks.json:<label>:0:0" with
//             a trusted_hash (sha256 of the canonical handler identity) —
//             the hash scheme is internal, so THIS is the contract most
//             likely to drift. transcript_path IS the rollout file; exec resume reuses
//             the same id + file (source="resume"). SessionEnd never fires.
//             In the TUI, NO hook fires at launch — SessionStart(source=
//             startup) + everything else arrives at the FIRST prompt submit.
//             Permission-wait: PermissionRequest hook (session_id, turn_id,
//             tool_name, tool_input) — fires in exec mode too, where the
//             unanswerable approval is then auto-rejected and the turn Stops.
//             Approval resolution: PostToolUse (label post_tool_use) fires
//             after an executed command, same payload family.
//   cursor  · JSON-on-stdin hooks configured in <workspace>/.cursor/hooks.json
//             (project scope, discovered by the CLI itself; hooks landed in
//             the CLI ~2026.07 — pinned live 2026-07-19 against
//             2026.07.16-899851b). Schema: {version: 1, hooks: {<event>:
//             [{command}]}} — flat handlers, NOT the claude/codex group
//             shape. session_id (= conversation_id) on every event; payload
//             cwd is often "" — workspace_roots[0] is the join key;
//             transcript_path null on sessionStart, set from the first
//             tool/turn event. sessionStart fires AT LAUNCH (TUI), but turn
//             events are TUI-only: -p mode never fires beforeSubmitPrompt/
//             stop (sessionStart, tool events and sessionEnd still do).
//             --resume fires NO sessionStart, keeps the id — and ADOPTS an
//             unknown id as a fresh chat (exit 0) instead of failing, so a
//             stale stamp degrades to a fresh session, never a wrong one.
//             NO permission hook event exists: beforeShellExecution fires
//             before EVERY shell command (auto-approved alike, before the
//             command runs), so it cannot mark "blocked on approval".
//   pi      · in-process extension auto-discovered from <cwd>/.pi/extensions/
//             *.ts (project scope — launch-method independent, unlike the -e
//             argv channel this replaced; moved 2026-07-19).
//             ctx.sessionManager gives sessionId + sessionFile on every
//             event; agent_start/agent_end bracket each turn; --session
//             resumes an exact id. The test launches pi by ABSOLUTE PATH to
//             pin launch-method independence and registers a fake offline
//             provider via -e, so pi runs cost nothing and need no
//             credentials.
//   opencode· in-process plugin injected as <project>/.opencode/plugin/*.js
//             (no shared vendor config file); bus events carry sessionID;
//             session.status
//             busy/idle + session.idle mark turn state. The full lifecycle
//             fires even when the provider errors, so this works with broken
//             auth. ALWAYS spawn with OPENCODE_DISABLE_AUTOUPDATE=1 — the TUI
//             update modal steals keystrokes and self-updates.
//             Permission-wait: permission.asked bus event (sessionID,
//             permission, metadata.command). Needs a completed model turn that
//             CALLS a gated tool, so the test brings its own offline
//             OpenAI-compatible provider; run mode never asks (headless).
//             Approval resolution: permission.replied (sessionID, requestID =
//             the asked id, reply "once"/"always"/"reject"), then busy resumes.
//
// Permission-wait exists ONLY on claude/codex/opencode. pi has no approval
// concept at all (tools execute directly — verified: zero approval strings in
// its dist). cursor HAS native approval prompts but no hook event that marks
// them (see above) — while parked on approval, the last event is an ordinary
// beforeShellExecution, indistinguishable from an auto-approved run.
//
// Opt-in only: drives the real, locally-installed CLIs with the user's
// accounts (a few tiny prompts — cents; pi is offline/free). *.itest.ts is
// excluded from the normal vitest include.
//
// Run:  CATE_LIVE_AGENT_CLIS=1 npx vitest run --config vitest.live.config.ts \
//         agentHookContracts
// =============================================================================

import { describe, test, expect, afterAll } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { createAgentPresenceTracker } from './agentPresence'
import { snapshotProcessTree } from './process'

/** Headless CLI run with stdin CLOSED — several CLIs (codex exec, pi -p,
 *  opencode run) block reading a never-ending stdin pipe otherwise. PWD is
 *  pinned to the cwd because execFile does not update it and opencode derives
 *  the session's directory from $PWD, not getcwd (a real shell always keeps
 *  the two in sync, so Cate terminals are unaffected). */
function run(
  bin: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { cwd: opts.cwd, env: { ...opts.env, PWD: opts.cwd }, timeout: opts.timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout, stderr }))
        else resolve({ stdout, stderr })
      },
    )
    child.stdin?.end()
  })
}

const LIVE = process.env.CATE_LIVE_AGENT_CLIS === '1'
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/
const PROMPT = 'Reply with exactly: ok'
const PROMPT2 = 'Reply with exactly: ok again'

function hasBin(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// A nested CLAUDECODE/ANTHROPIC/CODEX/GROK env changes the CLIs' behavior
// (observed: claude silently stops persisting transcripts) — always drive them
// with the agent vars stripped, like a real Cate terminal. GROK_* matters
// doubly here: the grok suite asserts on the reserved hook-runner vars, which
// an inherited value would forge.
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k, v]) => v !== undefined && !/^(CLAUDE|ANTHROPIC|CODEX|GROK)/i.test(k) && k !== 'CLAUDECODE',
    ),
  ) as Record<string, string>
  return { ...base, ...extra }
}

const RUN_TAG = `cate-hook-contract-${Date.now()}`
const cleanups: (() => void)[] = []
afterAll(() => {
  for (const fn of cleanups.reverse()) {
    try { fn() } catch { /* best-effort cleanup */ }
  }
})
function makeCwd(sub: string): string {
  const dir = join(tmpdir(), `${RUN_TAG}-${sub}`)
  mkdirSync(dir, { recursive: true })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return realpathSync(dir)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// --- the bridge: one hook process shape for all stdin-JSON CLIs --------------
// (claude and codex deliver one JSON payload on stdin. The
// events-file path and the terminal correlation id both arrive via env — that
// env inheritance IS part of the contract under test: Cate correlates a hook
// event to a terminal by the CATE_TERMINAL_ID it planted on the PTY. No
// stdout on purpose: every CLI accepts silent exit-0.)
function writeBridge(dir: string): string {
  const path = join(dir, 'cate-bridge.js')
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('fs')
let d = ''
process.stdin.on('data', (c) => { d += c })
process.stdin.on('end', () => {
  let payload
  try { payload = JSON.parse(d) } catch { payload = { raw: d } }
  // Reserved hook-runner env: grok injects these on EVERY hook process
  // (undefined for the other CLIs). GROK_HOOK_EVENT is the deterministic
  // "grok ran me" marker the shipped bridge keys its agent disambiguation on.
  const env = {}
  for (const k of ['GROK_HOOK_EVENT', 'GROK_SESSION_ID', 'GROK_WORKSPACE_ROOT', 'CLAUDE_PROJECT_DIR']) {
    if (process.env[k] !== undefined) env[k] = process.env[k]
  }
  fs.appendFileSync(process.env.CATE_EVENTS_FILE, JSON.stringify({
    terminalId: process.env.CATE_TERMINAL_ID ?? null,
    ppid: process.ppid,
    env,
    payload,
  }) + '\\n')
})
`,
  )
  chmodSync(path, 0o755)
  return path
}

interface BridgeEvent {
  terminalId: string | null
  /** The hook process's parent pid — the lineage claim the daemon bridge
   *  posts (agentPresence.ts walks the ancestry from here to the agent). */
  ppid?: number
  /** Reserved hook-runner env vars present on the hook process (grok only). */
  env?: Record<string, string>
  payload: Record<string, unknown>
}

function readJsonl<T>(file: string): T[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: T[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* partial write */ }
  }
  return out
}

/** Every captured event must carry the terminal correlation id — a single
 *  mis-echo means Cate would attribute a session to the wrong terminal. */
function expectEcho(events: { terminalId?: unknown; cateTerminalId?: unknown }[], tid: string): void {
  expect(events.length).toBeGreaterThan(0)
  for (const e of events) expect(e.terminalId ?? e.cateTerminalId, 'CATE_TERMINAL_ID echo').toBe(tid)
}

// --- tiny TUI driver (for the CLIs whose hooks need a live TUI) --------------

interface Tui {
  pid: number
  send: (line: string) => Promise<void>
  /** Write raw bytes with no trailing Enter — for answering a menu by key
   *  (Esc to dismiss, arrows to move) where `send` would submit a line. */
  press: (keys: string) => void
  settle: (ms: number) => Promise<void>
  waitFor: (pred: () => boolean, timeoutMs: number, label: string) => Promise<void>
  peek: () => string
  kill: () => void
}

async function driveTui(bin: string, args: string[], cwd: string, env: Record<string, string>): Promise<Tui> {
  const { spawn } = await import('node-pty')
  const p = spawn(bin, args, { name: 'xterm-256color', cols: 120, rows: 40, cwd, env })
  let buf = ''
  let exited = false
  let trusted = false
  p.onData((d) => { buf += d })
  p.onExit(() => { exited = true })
  cleanups.push(() => { if (!exited) p.kill() })

  // First-run interstitials, checked on every poll tick: folder-trust prompts
  // (claude and codex ask in a fresh cwd; default is "yes, trust") and
  // update banners. NEVER Enter through an update banner — Enter ACCEPTS the
  // self-update (observed: opencode updated itself). Esc dismisses.
  const handleInterstitials = async (): Promise<void> => {
    if (!trusted && /trust/i.test(buf)) {
      trusted = true
      await sleep(500)
      p.write('\r')
    }
    if (/Update available/i.test(buf)) {
      buf = ''
      p.write('\x1b')
    }
  }

  return {
    pid: p.pid,
    // Type character-by-character: opencode's composer drops a bulk-written
    // line entirely (verified live — the submit lands on an empty input), and
    // per-char typing is what a real terminal produces anyway.
    send: async (line) => {
      for (const ch of line) {
        p.write(ch)
        await sleep(15)
      }
      await sleep(800) // let TUI input handling settle before submit
      p.write('\r')
    },
    press: (keys) => { p.write(keys) },
    settle: async (ms) => {
      const start = Date.now()
      while (Date.now() - start < ms) {
        await handleInterstitials()
        await sleep(250)
      }
    },
    waitFor: async (pred, timeoutMs, label) => {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        await handleInterstitials()
        if (pred()) return
        await sleep(250)
      }
      throw new Error(`timeout waiting for ${label}; screen tail: ${buf.slice(-400)}`)
    },
    peek: () => buf,
    kill: () => p.kill(),
  }
}

// =============================================================================
// claude — hooks via <cwd>/.claude/settings.local.json (project scope). File
// injection on purpose: an argv channel is launch-method dependent (aliases,
// rc-file PATH prepends, absolute-path launches all sidestep argv injection),
// while repo-scoped settings hooks fire regardless. The pinned contract is
// that project-local settings hooks fire in BOTH TUI and print mode.
// =============================================================================

describe.skipIf(!LIVE || !hasBin('claude'))('claude hook contract', () => {
  const writeClaudeSettings = (cwd: string, bridge: string): void => {
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(
      join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: Object.fromEntries(
          ['SessionStart', 'UserPromptSubmit', 'Notification', 'PostToolUse', 'Stop', 'SessionEnd'].map((e) => [
            e,
            [{ hooks: [{ type: 'command', command: bridge }] }],
          ]),
        ),
      }),
    )
  }

  const byName = (events: BridgeEvent[], name: string): BridgeEvent[] =>
    events.filter((e) => e.payload.hook_event_name === name)

  // Remove the per-cwd transcript slug dir — exclusively this test's cwd.
  const registerTranscriptCleanup = (transcriptPath: string): void => {
    cleanups.push(() => rmSync(dirname(transcriptPath), { recursive: true, force: true }))
  }

  test('TUI: hooks stream identity + turn status; /clear rotates with end/start handoff', { retry: 1, timeout: 420_000 }, async () => {
    const cwd = makeCwd('claude')
    const eventsFile = join(cwd, 'events.jsonl')
    const bridge = writeBridge(cwd)
    writeClaudeSettings(cwd, bridge)
    const tid = `cate-term-claude-${Date.now()}`
    const events = (): BridgeEvent[] => readJsonl<BridgeEvent>(eventsFile)

    const tui = await driveTui(
      'claude',
      ['--model', 'haiku'],
      cwd,
      cleanEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }),
    )

    // Identity is PUSHED at launch — before any prompt, before any transcript
    // exists. This is what closes the lazy-persistence gap the old probe
    // handled via the pid registry.
    await tui.waitFor(() => byName(events(), 'SessionStart').length > 0, 60_000, 'SessionStart')
    const start = byName(events(), 'SessionStart')[0].payload
    expect(start.source, 'fresh launch').toBe('startup')
    expect(start.session_id).toMatch(UUID_RE)
    expect(start.cwd, 'hook payload cwd is the session join key').toBe(cwd)
    const id1 = start.session_id as string
    const transcript1 = start.transcript_path as string
    registerTranscriptCleanup(transcript1)

    // Turn status: prompt-submit and turn-end push for the same session.
    await tui.send(PROMPT)
    await tui.waitFor(() => byName(events(), 'UserPromptSubmit').length > 0, 120_000, 'UserPromptSubmit')
    expect(byName(events(), 'UserPromptSubmit')[0].payload.session_id).toBe(id1)
    await tui.waitFor(() => byName(events(), 'Stop').length > 0, 120_000, 'Stop')
    expect(byName(events(), 'Stop')[0].payload.session_id).toBe(id1)

    // transcript_path points at a real transcript once the first prompt ran —
    // the moment the RESUMABLE_FROM_SESSION_START gating counts on.
    expect(existsSync(transcript1), 'transcript exists after first prompt').toBe(true)

    // Presence lineage contract: every hook process is a descendant of the
    // agent, so the REAL tracker must resolve the bridge's recorded parent
    // pid to the live claude process — this is the entire basis of
    // hook-anchored presence (the pty tree plays no part, which is what
    // makes detection tmux/screen/setsid-proof).
    const lineage = events().find((e) => typeof e.ppid === 'number')
    expect(lineage, 'bridge recorded its parent pid').toBeTruthy()
    const tracker = createAgentPresenceTracker({ snapshot: snapshotProcessTree })
    await tracker.notePost(tid, 'claude-code', lineage!.ppid)
    expect(
      tracker.presenceFor(tid, await snapshotProcessTree()),
      'ancestry walk lands on the live claude',
    ).toEqual({ agentName: 'Claude Code', agentPresent: true })

    // /clear rotates IN the same process: old session ends (reason=clear),
    // new one starts (source=clear) with a fresh id — the push signal that
    // replaces the old in-place pid-registry rotation contract.
    await tui.send('/clear')
    await tui.waitFor(
      () => byName(events(), 'SessionEnd').some((e) => e.payload.reason === 'clear'),
      60_000,
      'SessionEnd(reason=clear)',
    )
    expect(byName(events(), 'SessionEnd').find((e) => e.payload.reason === 'clear')?.payload.session_id).toBe(id1)
    await tui.waitFor(
      () => byName(events(), 'SessionStart').some((e) => e.payload.source === 'clear'),
      60_000,
      'SessionStart(source=clear)',
    )
    const rotated = byName(events(), 'SessionStart').find((e) => e.payload.source === 'clear')?.payload
    expect(rotated?.session_id).toMatch(UUID_RE)
    expect(rotated?.session_id, '/clear yields a NEW session id').not.toBe(id1)
    registerTranscriptCleanup(rotated?.transcript_path as string)

    expectEcho(events(), tid)
    tui.kill()
  })

  test('print mode: hooks report one consistent id; hooks fire on a resume relaunch', { timeout: 300_000 }, async () => {
    const cwd = makeCwd('claude-print')
    const bridge = writeBridge(cwd)
    writeClaudeSettings(cwd, bridge)
    const tid = `cate-term-claude-p-${Date.now()}`

    const eventsFile = join(cwd, 'events-print.jsonl')
    await run(
      'claude',
      ['-p', PROMPT, '--model', 'haiku'],
      { cwd, env: cleanEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }), timeout: 240_000 },
    )
    const events = readJsonl<BridgeEvent>(eventsFile)
    const id = events.find((e) => e.payload.hook_event_name === 'SessionStart')?.payload.session_id as string
    expect(id).toMatch(UUID_RE)
    for (const name of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      const hits = events.filter((e) => e.payload.hook_event_name === name)
      expect(hits.length, `${name} fired`).toBeGreaterThan(0)
      for (const h of hits) expect(h.payload.session_id, `${name} reports the same id`).toBe(id)
    }
    const transcript = events[0].payload.transcript_path as string
    expect(existsSync(transcript), 'transcript exists').toBe(true)
    cleanups.push(() => rmSync(dirname(transcript), { recursive: true, force: true }))
    expectEcho(events, tid)

    // Resume relaunch (the shipped restore argv, --resume <id>): hooks keep
    // flowing. claude may FORK on resume (shadow session continuing the
    // original transcript) — the id is not asserted; the contract is that the
    // relaunched process pushes events at all, so Cate's tracker re-stamps
    // whatever the fork produced.
    const eventsFile2 = join(cwd, 'events-resume.jsonl')
    await run(
      'claude',
      ['-p', PROMPT2, '--resume', id, '--model', 'haiku'],
      { cwd, env: cleanEnv({ CATE_EVENTS_FILE: eventsFile2, CATE_TERMINAL_ID: tid }), timeout: 240_000 },
    )
    const resumeEvents = readJsonl<BridgeEvent>(eventsFile2)
    const stops = resumeEvents.filter((e) => e.payload.hook_event_name === 'Stop')
    expect(stops.length, 'Stop fired on the resumed run').toBeGreaterThan(0)
    expect(stops[0].payload.session_id).toMatch(UUID_RE)
    expectEcho(resumeEvents, tid)
  })

  // Permission-wait is PUSHED: while a tool call is blocked on the user's
  // approval, the Notification hook fires with notification_type
  // "permission_prompt" — mid-turn, before any Stop. This is the signal that
  // replaces the spinner-stop + settle-timer "needs input" heuristic. And the
  // RESOLUTION is pushed too: approving runs the tool, so PostToolUse marks
  // the turn as back in flight before it finally Stops.
  test('TUI: Notification(permission_prompt) while blocked; approval resumes via PostToolUse', { retry: 1, timeout: 420_000 }, async () => {
    const cwd = makeCwd('claude-perm')
    const eventsFile = join(cwd, 'events.jsonl')
    const bridge = writeBridge(cwd)
    writeClaudeSettings(cwd, bridge)
    const tid = `cate-term-claude-perm-${Date.now()}`
    const events = (): BridgeEvent[] => readJsonl<BridgeEvent>(eventsFile)

    const tui = await driveTui(
      'claude',
      ['--model', 'haiku'],
      cwd,
      cleanEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }),
    )
    await tui.waitFor(() => byName(events(), 'SessionStart').length > 0, 60_000, 'SessionStart')
    const id = byName(events(), 'SessionStart')[0].payload.session_id as string
    registerTranscriptCleanup(byName(events(), 'SessionStart')[0].payload.transcript_path as string)

    // `touch` is outside claude's safe-command set in default permission mode,
    // so the turn parks on an approval prompt instead of completing.
    await tui.send('Use the Bash tool to run exactly this command: touch needs-approval.txt')
    await tui.waitFor(
      () => byName(events(), 'Notification').some((e) => e.payload.notification_type === 'permission_prompt'),
      180_000,
      'Notification(permission_prompt)',
    )
    const perm = byName(events(), 'Notification').find(
      (e) => e.payload.notification_type === 'permission_prompt',
    )?.payload
    expect(perm?.session_id, 'permission-wait identifies the session').toBe(id)
    expect(perm?.message, 'human-readable permission message').toContain('permission')
    // The turn is still in flight — the wait signal precedes any Stop.
    expect(byName(events(), 'Stop').length, 'no Stop while blocked on approval').toBe(0)

    // Approve (Enter accepts the highlighted "Yes"): the tool runs, PostToolUse
    // pushes the back-in-flight signal, then the turn completes with Stop.
    await tui.send('')
    await tui.waitFor(() => byName(events(), 'PostToolUse').length > 0, 120_000, 'PostToolUse after approval')
    expect(byName(events(), 'PostToolUse')[0].payload.session_id).toBe(id)
    expect(byName(events(), 'PostToolUse')[0].payload.tool_name).toBe('Bash')
    await tui.waitFor(() => byName(events(), 'Stop').length > 0, 120_000, 'Stop after approval')
    expectEcho(events(), tid)
    tui.kill()
  })

  // Resuming a dead id must FAIL (not silently start fresh) — this is what
  // lets Cate fall back to a plain shell when a stored id has been deleted.
  test('print mode: resuming an unknown session id fails', { timeout: 240_000 }, async () => {
    const cwd = makeCwd('claude-badresume')
    const ghost = '99999999-9999-4999-8999-999999999999'
    await expect(
      run('claude', ['-p', 'hi', '--resume', ghost, '--model', 'haiku'], { cwd, env: cleanEnv(), timeout: 120_000 }),
    ).rejects.toThrow()
  })
})

// =============================================================================
// codex — hooks via <project root>/.codex/hooks.json + codex's own trust.
// codex is launched by ABSOLUTE PATH throughout: the shipped channel is a repo
// file codex discovers itself, so events must fire independent of how the
// binary was found (alias, rc-file PATH prepend, absolute invocation).
// =============================================================================

describe.skipIf(!LIVE || !hasBin('codex'))('codex hook contract', () => {
  // Resolved lazily inside tests — the describe body runs even when skipped.
  const codexBin = (): string => execFileSync('which', ['codex']).toString().trim()

  /** [hooks.json key (CamelCase), trust label (snake_case)] pairs — the two
   *  casings are a codex quirk, not a typo. */
  const CODEX_EVENTS: [string, string][] = [
    ['SessionStart', 'session_start'],
    ['UserPromptSubmit', 'user_prompt_submit'],
    ['PermissionRequest', 'permission_request'],
    ['PostToolUse', 'post_tool_use'],
    ['Stop', 'stop'],
  ]

  // Trust-key hash: sha256 of the canonical handler identity. Key + hash
  // formats are codex internals (source comment: "replace this positional
  // suffix with a durable hook id") — when this breaks, THIS suite is the
  // early warning. Must stay byte-identical to codexTrustedHash in
  // src/shared/agentHooks.ts (pinned there by a vector test).
  const trustedHash = (label: string, command: string, timeout: number): string => {
    const identity =
      `{"event_name":${JSON.stringify(label)},"hooks":[{"async":false,` +
      `"command":${JSON.stringify(command)},"timeout":${timeout},"type":"command"}]}`
    return 'sha256:' + createHash('sha256').update(identity).digest('hex')
  }

  /** The SHIPPED channel: the hooks.json Cate's prepareWorkspace merges into
   *  the project root (same shape, same 60s timeout). */
  const writeHooksFile = (root: string, bridge: string): void => {
    mkdirSync(join(root, '.codex'), { recursive: true })
    writeFileSync(
      join(root, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: Object.fromEntries(
          CODEX_EVENTS.map(([key]) => [key, [{ hooks: [{ type: 'command', command: bridge, timeout: 60 }] }]]),
        ),
      }),
    )
  }

  /** Folder trust for the project root. Inline-table form REQUIRED — the
   *  dotted-path `-c projects."<root>".trust_level=...` spelling silently
   *  no-ops (pinned live). --dangerously-bypass-hook-trust does NOT bypass
   *  folder trust either. */
  const folderTrustArg = (root: string): string => `projects={"${root}"={trust_level="trusted"}}`

  /** Hook trust for every injected hook, keyed by the REAL source-file path.
   *  HARNESS ONLY — the shipped product plants no trust: a headless test
   *  cannot answer codex's interactive review prompt, so these overrides
   *  simulate the state the user's one-time "trust" click persists. */
  const hookTrustArg = (root: string, bridge: string): string =>
    `hooks.state={${CODEX_EVENTS.map(
      ([, label]) => `"${root}/.codex/hooks.json:${label}:0:0"={trusted_hash="${trustedHash(label, bridge, 60)}"}`,
    ).join(',')}}`

  /** The full harness-only trust pre-plant: trusted folder + trusted hooks. */
  const trustArgs = (root: string, bridge: string): string[] => [
    '-c', folderTrustArg(root),
    '-c', hookTrustArg(root, bridge),
  ]

  test('exec: project-file hooks report identity + turn; exec resume reuses id and rollout', { timeout: 420_000 }, async () => {
    const cwd = makeCwd('codex')
    const bridge = writeBridge(cwd)
    writeHooksFile(cwd, bridge)
    const tid = `cate-term-codex-${Date.now()}`

    const eventsFile = join(cwd, 'events.jsonl')
    await run(
      codexBin(),
      ['exec', '--skip-git-repo-check', ...trustArgs(cwd, bridge), PROMPT],
      { cwd, env: cleanEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }), timeout: 300_000 },
    )
    const events = readJsonl<BridgeEvent>(eventsFile)
    const start = events.find((e) => e.payload.hook_event_name === 'SessionStart')?.payload
    expect(start, 'SessionStart fired — absence means hooks.json discovery or the trust scheme drifted').toBeTruthy()
    expect(start?.source).toBe('startup')
    expect(start?.session_id).toMatch(UUID_RE)
    expect(start?.cwd).toBe(cwd)
    const id = start?.session_id as string
    const rollout = start?.transcript_path as string
    cleanups.push(() => rmSync(rollout, { force: true }))
    expect(events.some((e) => e.payload.hook_event_name === 'UserPromptSubmit')).toBe(true)
    expect(events.some((e) => e.payload.hook_event_name === 'Stop')).toBe(true)

    // transcript_path IS the rollout file, stored under the codex sessions
    // root and named by the session id.
    expect(rollout).toContain(`${homedir()}/.codex/sessions/`)
    expect(rollout).toContain(id)
    expect(existsSync(rollout)).toBe(true)
    expectEcho(events, tid)

    // exec resume: same id, same rollout, source=resume — no fork.
    const eventsFile2 = join(cwd, 'events-resume.jsonl')
    await run(
      codexBin(),
      ['exec', '--skip-git-repo-check', ...trustArgs(cwd, bridge), 'resume', id, PROMPT2],
      { cwd, env: cleanEnv({ CATE_EVENTS_FILE: eventsFile2, CATE_TERMINAL_ID: tid }), timeout: 300_000 },
    )
    const resumeEvents = readJsonl<BridgeEvent>(eventsFile2)
    const resumeStart = resumeEvents.find((e) => e.payload.hook_event_name === 'SessionStart')?.payload
    expect(resumeStart?.source).toBe('resume')
    expect(resumeStart?.session_id, 'resume re-attaches to the SAME session').toBe(id)
    expect(resumeStart?.transcript_path).toBe(rollout)
    expect(resumeEvents.some((e) => e.payload.hook_event_name === 'Stop')).toBe(true)
    expectEcho(resumeEvents, tid)
  })

  // Permission-wait is PUSHED: PermissionRequest fires the moment a tool call
  // needs approval — in exec mode too, where codex then auto-rejects ("approval
  // is not supported in exec mode") and the turn completes with a Stop. That
  // auto-reject makes exec the cheap deterministic harness for this contract.
  test('exec: PermissionRequest fires when a command needs approval', { timeout: 300_000 }, async () => {
    const cwd = makeCwd('codex-perm')
    const bridge = writeBridge(cwd)
    writeHooksFile(cwd, bridge)
    const tid = `cate-term-codex-perm-${Date.now()}`
    const eventsFile = join(cwd, 'events.jsonl')

    // approval_policy=untrusted parks ANY command on approval; the exec run
    // still exits 0 (the model reports the rejection), so run() must not throw.
    await run(
      codexBin(),
      ['exec', '--skip-git-repo-check', '-c', 'approval_policy="untrusted"', ...trustArgs(cwd, bridge),
        'Run exactly this shell command: touch needs-approval.txt'],
      { cwd, env: cleanEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }), timeout: 240_000 },
    )
    const events = readJsonl<BridgeEvent>(eventsFile)
    const start = events.find((e) => e.payload.hook_event_name === 'SessionStart')?.payload
    expect(start?.session_id).toMatch(UUID_RE)
    cleanups.push(() => rmSync(start?.transcript_path as string, { force: true }))

    const perm = events.find((e) => e.payload.hook_event_name === 'PermissionRequest')?.payload
    expect(perm, 'PermissionRequest fired').toBeTruthy()
    expect(perm?.session_id, 'permission-wait identifies the session').toBe(start?.session_id)
    expect(perm?.turn_id, 'permission-wait identifies the turn').toBeTruthy()
    expect(perm?.tool_name).toBe('Bash')
    expect((perm?.tool_input as { command?: string })?.command).toContain('touch')

    // Event order pins the state machine the tracker runs: submit → wait → end.
    const names = events.map((e) => e.payload.hook_event_name)
    expect(names.indexOf('PermissionRequest')).toBeGreaterThan(names.indexOf('UserPromptSubmit'))
    expect(names.indexOf('Stop'), 'auto-reject completes the turn').toBeGreaterThan(names.indexOf('PermissionRequest'))
    expectEcho(events, tid)
  })

  // Approval RESOLUTION is pushed as PostToolUse once the tool actually ran —
  // pinned via --full-auto (auto-approved echo), where the order is
  // UserPromptSubmit → PostToolUse → Stop with no PermissionRequest.
  test('exec: PostToolUse fires after an executed command', { timeout: 300_000 }, async () => {
    const cwd = makeCwd('codex-pt')
    const bridge = writeBridge(cwd)
    writeHooksFile(cwd, bridge)
    const tid = `cate-term-codex-pt-${Date.now()}`
    const eventsFile = join(cwd, 'events.jsonl')

    await run(
      codexBin(),
      ['exec', '--skip-git-repo-check', '--full-auto', ...trustArgs(cwd, bridge), 'Run exactly this shell command: echo cate-pt-probe'],
      { cwd, env: cleanEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }), timeout: 240_000 },
    )
    const events = readJsonl<BridgeEvent>(eventsFile)
    const start = events.find((e) => e.payload.hook_event_name === 'SessionStart')?.payload
    cleanups.push(() => rmSync(start?.transcript_path as string, { force: true }))
    const post = events.find((e) => e.payload.hook_event_name === 'PostToolUse')?.payload
    expect(post, 'PostToolUse fired').toBeTruthy()
    expect(post?.session_id).toBe(start?.session_id)
    expect(post?.tool_name).toBe('Bash')
    const names = events.map((e) => e.payload.hook_event_name)
    expect(names).not.toContain('PermissionRequest')
    expect(names.indexOf('Stop')).toBeGreaterThan(names.indexOf('PostToolUse'))
    expectEcho(events, tid)
  })

  // The TUI defers EVERY hook to the first prompt submit — nothing fires at
  // launch. Pinned because the session-stamp feature must know that codex TUI
  // identity arrives only once the user prompts (until then the fd-scan
  // fallback probe is the only signal).
  test('TUI: hooks are silent at launch; SessionStart arrives with the first submit', { retry: 1, timeout: 420_000 }, async () => {
    const cwd = makeCwd('codex-tui')
    const bridge = writeBridge(cwd)
    writeHooksFile(cwd, bridge)
    const tid = `cate-term-codex-tui-${Date.now()}`
    const eventsFile = join(cwd, 'events.jsonl')
    const events = (): BridgeEvent[] => readJsonl<BridgeEvent>(eventsFile)

    // Trust pre-planted (harness) so the one-time hook review prompt never
    // appears — headless PTY driving cannot answer it deterministically.
    const tui = await driveTui(
      codexBin(),
      ['-c', 'approval_policy="untrusted"', ...trustArgs(cwd, bridge)],
      cwd,
      cleanEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }),
    )
    await tui.settle(10_000)
    expect(events().length, 'no hook fires at TUI launch').toBe(0)

    await tui.send('Run exactly this shell command: touch needs-approval.txt')
    await tui.waitFor(
      () => events().some((e) => e.payload.hook_event_name === 'PermissionRequest'),
      180_000,
      'PermissionRequest in TUI',
    )
    const start = events().find((e) => e.payload.hook_event_name === 'SessionStart')?.payload
    expect(start?.source, 'deferred SessionStart still reports startup').toBe('startup')
    expect(start?.session_id).toMatch(UUID_RE)
    cleanups.push(() => rmSync(start?.transcript_path as string, { force: true }))
    const perm = events().find((e) => e.payload.hook_event_name === 'PermissionRequest')?.payload
    expect(perm?.session_id).toBe(start?.session_id)
    expectEcho(events(), tid)
    tui.kill()
  })

  // Negative controls: every broken link in the trust chain must yield ZERO
  // events — a silent skip, no error, no partial delivery. This is the safety
  // property the interactive-trust UX (and Cate's "hooks may never arrive"
  // tolerance) is built on. Rollouts of these runs are not cleaned up (no
  // events → no transcript_path to find them by).
  test('exec: untrusted folder / wrong hash / wrong key path all silently skip hooks', { timeout: 600_000 }, async () => {
    const cwd = makeCwd('codex-neg')
    const bridge = writeBridge(cwd)
    writeHooksFile(cwd, bridge)

    const runCase = async (name: string, args: string[]): Promise<void> => {
      const eventsFile = join(cwd, `events-${name}.jsonl`)
      await run(
        codexBin(),
        ['exec', '--skip-git-repo-check', ...args, PROMPT],
        { cwd, env: cleanEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: `cate-term-${name}` }), timeout: 180_000 },
      )
      expect(readJsonl<BridgeEvent>(eventsFile).length, `${name}: hooks must be silently skipped`).toBe(0)
    }

    // Folder NOT trusted (hook trust alone is not enough — project hooks
    // only load from a trusted folder).
    await runCase('untrusted-folder', ['-c', hookTrustArg(cwd, bridge)])
    // Trusted folder, but a garbage trusted_hash.
    const zeroState = `hooks.state={${CODEX_EVENTS.map(
      ([, label]) => `"${cwd}/.codex/hooks.json:${label}:0:0"={trusted_hash="sha256:${'0'.repeat(64)}"}`,
    ).join(',')}}`
    await runCase('bad-hash', ['-c', folderTrustArg(cwd), '-c', zeroState])
    // Trusted folder, correct hashes, but the OLD placeholder path segment in
    // the key — the source-file path is part of the trust identity.
    const wrongPathState = `hooks.state={${CODEX_EVENTS.map(
      ([, label]) => `"/<session-flags>/config.toml:${label}:0:0"={trusted_hash="${trustedHash(label, bridge, 60)}"}`,
    ).join(',')}}`
    await runCase('wrong-key-path', ['-c', folderTrustArg(cwd), '-c', wrongPathState])
  })
})

// =============================================================================
// cursor — hooks via <workspace>/.cursor/hooks.json (project scope, cursor's
// own flat schema). The CLI is a launcher script the user's installer links
// as cursor-agent; hooks fire regardless of launch method (repo file).
// =============================================================================

describe.skipIf(!LIVE || !hasBin('cursor-agent'))('cursor hook contract', () => {
  /** The SHIPPED channel: the five events Cate's cursorSpec registers, plus
   *  beforeShellExecution where a test pins why it is NOT mapped. */
  const writeCursorHooks = (cwd: string, bridge: string, extraEvents: string[] = []): void => {
    mkdirSync(join(cwd, '.cursor'), { recursive: true })
    writeFileSync(
      join(cwd, '.cursor', 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: Object.fromEntries(
          ['sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'stop', 'sessionEnd', ...extraEvents].map((e) => [
            e,
            [{ command: bridge }],
          ]),
        ),
      }),
    )
  }

  const byName = (events: BridgeEvent[], name: string): BridgeEvent[] =>
    events.filter((e) => e.payload.hook_event_name === name)

  // Transcripts land under ~/.cursor/projects/<slug-of-cwd>/agent-transcripts/
  // <id>/<id>.jsonl — the slug dir is derived from this test's tmp cwd, so it
  // is exclusively ours to remove.
  const registerTranscriptCleanup = (transcriptPath: string): void => {
    cleanups.push(() => rmSync(dirname(dirname(dirname(transcriptPath))), { recursive: true, force: true }))
  }

  test('TUI: sessionStart at launch; beforeSubmitPrompt/stop bracket turns; --resume keeps the id with NO sessionStart', { retry: 1, timeout: 420_000 }, async () => {
    const cwd = makeCwd('cursor')
    const eventsFile = join(cwd, 'events.jsonl')
    const bridge = writeBridge(cwd)
    writeCursorHooks(cwd, bridge)
    const tid = `cate-term-cursor-${Date.now()}`
    const events = (): BridgeEvent[] => readJsonl<BridgeEvent>(eventsFile)

    const tui = await driveTui(
      'cursor-agent',
      [],
      cwd,
      cleanEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }),
    )

    // Identity is PUSHED at launch (unlike codex's first-submit deferral).
    await tui.waitFor(() => byName(events(), 'sessionStart').length > 0, 60_000, 'sessionStart')
    const start = byName(events(), 'sessionStart')[0].payload
    expect(start.session_id).toMatch(UUID_RE)
    expect(start.session_id, 'session_id and conversation_id are the same uuid').toBe(start.conversation_id)
    expect((start.workspace_roots as string[])[0], 'workspace_roots[0] is the session join key').toBe(cwd)
    expect(start.transcript_path, 'no transcript at launch').toBeNull()
    const id = start.session_id as string

    // Turn status: prompt-submit and turn-end push for the same session.
    await tui.send(PROMPT)
    await tui.waitFor(() => byName(events(), 'beforeSubmitPrompt').length > 0, 120_000, 'beforeSubmitPrompt')
    expect(byName(events(), 'beforeSubmitPrompt')[0].payload.session_id).toBe(id)
    await tui.waitFor(() => byName(events(), 'stop').length > 0, 180_000, 'stop')
    const stop = byName(events(), 'stop')[0].payload
    expect(stop.session_id).toBe(id)
    expect(stop.status).toBe('completed')

    // transcript_path materializes with the turn and points at a real file.
    const transcript = byName(events(), 'stop')[0].payload.transcript_path as string
    expect(transcript).toContain(`${homedir()}/.cursor/projects/`)
    expect(transcript).toContain(id)
    expect(existsSync(transcript)).toBe(true)
    registerTranscriptCleanup(transcript)
    expectEcho(events(), tid)
    tui.kill()

    // Resume relaunch (the shipped restore argv, --resume <id>): the session
    // keeps its id and NO sessionStart fires — the tracker must key on
    // whatever event carries the id first (beforeSubmitPrompt here).
    const eventsFile2 = join(cwd, 'events-resume.jsonl')
    const tui2 = await driveTui(
      'cursor-agent',
      ['--resume', id],
      cwd,
      cleanEnv({ CATE_EVENTS_FILE: eventsFile2, CATE_TERMINAL_ID: tid }),
    )
    const resumeEvents = (): BridgeEvent[] => readJsonl<BridgeEvent>(eventsFile2)
    await tui2.settle(8_000)
    await tui2.send(PROMPT2)
    await tui2.waitFor(() => byName(resumeEvents(), 'stop').length > 0, 180_000, 'stop on resumed session')
    expect(byName(resumeEvents(), 'sessionStart').length, 'no sessionStart on --resume').toBe(0)
    expect(byName(resumeEvents(), 'beforeSubmitPrompt')[0].payload.session_id, 'resume re-attaches to the SAME session').toBe(id)
    expect(byName(resumeEvents(), 'stop')[0].payload.session_id).toBe(id)
    expectEcho(resumeEvents(), tid)
    tui2.kill()
  })

  // Print mode pins the TURN-COVERAGE GAP the spec documents: sessionStart,
  // tool events and sessionEnd fire, but beforeSubmitPrompt/stop never do —
  // turn status is TUI-only. It also pins WHY beforeShellExecution is not a
  // permission signal: with --force nothing ever prompts, yet the event fires
  // for every command.
  test('print mode: no turn events; beforeShellExecution fires even for auto-approved commands', { timeout: 300_000 }, async () => {
    const cwd = makeCwd('cursor-print')
    const bridge = writeBridge(cwd)
    writeCursorHooks(cwd, bridge, ['beforeShellExecution'])
    const tid = `cate-term-cursor-p-${Date.now()}`
    const eventsFile = join(cwd, 'events.jsonl')

    await run(
      'cursor-agent',
      ['-p', '--trust', '-f', 'Run exactly this shell command: echo cate-cursor-probe'],
      { cwd, env: cleanEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }), timeout: 240_000 },
    )
    const events = readJsonl<BridgeEvent>(eventsFile)
    const start = events.find((e) => e.payload.hook_event_name === 'sessionStart')?.payload
    expect(start?.session_id).toMatch(UUID_RE)
    const id = start?.session_id as string

    // The print-mode gap: NO prompt-submit, NO stop.
    const names = events.map((e) => e.payload.hook_event_name)
    expect(names, 'print mode fires no beforeSubmitPrompt').not.toContain('beforeSubmitPrompt')
    expect(names, 'print mode fires no stop').not.toContain('stop')

    // Tool + lifecycle events still flow, all under the same id.
    const post = events.find((e) => e.payload.hook_event_name === 'postToolUse')?.payload
    expect(post, 'postToolUse fired').toBeTruthy()
    expect(post?.session_id).toBe(id)
    const end = events.find((e) => e.payload.hook_event_name === 'sessionEnd')?.payload
    expect(end, 'sessionEnd fired').toBeTruthy()
    expect(end?.session_id).toBe(id)
    registerTranscriptCleanup(end?.transcript_path as string)

    // --force auto-approves EVERYTHING, yet beforeShellExecution still fired —
    // the event precedes every shell command, not just prompted ones, which is
    // why cursorSpec maps no permission-wait.
    const shell = events.find((e) => e.payload.hook_event_name === 'beforeShellExecution')?.payload
    expect(shell, 'beforeShellExecution fires without any approval prompt').toBeTruthy()
    expect(shell?.command).toContain('echo cate-cursor-probe')
    expectEcho(events, tid)
  })

  // Resumability pins for the stamp gating: an id announced at sessionStart
  // but never prompted IS resumable (create-chat mints exactly that state),
  // and an UNKNOWN id is ADOPTED as a fresh chat instead of failing — a stale
  // stamp degrades to a fresh session under the same id, never a wrong one.
  test('print mode: a never-used chat id resumes; an unknown id is adopted, not rejected', { timeout: 420_000 }, async () => {
    const cwd = makeCwd('cursor-resume')
    const bridge = writeBridge(cwd)
    writeCursorHooks(cwd, bridge)
    const tid = `cate-term-cursor-r-${Date.now()}`

    const created = execFileSync('cursor-agent', ['create-chat'], { env: cleanEnv(), timeout: 60_000 })
      .toString()
      .trim()
    expect(created).toMatch(UUID_RE)

    const eventsFile = join(cwd, 'events.jsonl')
    await run(
      'cursor-agent',
      ['-p', '--trust', '-f', '--resume', created, PROMPT],
      { cwd, env: cleanEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }), timeout: 240_000 },
    )
    const events = readJsonl<BridgeEvent>(eventsFile)
    const end = events.find((e) => e.payload.hook_event_name === 'sessionEnd')?.payload
    expect(end?.session_id, 'never-used chat id resumes as itself').toBe(created)
    registerTranscriptCleanup(end?.transcript_path as string)
    expectEcho(events, tid)

    // Ghost id: adopted (exit 0, events under the ghost id) — NOT an error.
    const ghost = '99999999-9999-4999-8999-999999999999'
    const eventsFile2 = join(cwd, 'events-ghost.jsonl')
    await run(
      'cursor-agent',
      ['-p', '--trust', '-f', '--resume', ghost, PROMPT],
      { cwd, env: cleanEnv({ CATE_EVENTS_FILE: eventsFile2, CATE_TERMINAL_ID: tid }), timeout: 240_000 },
    )
    const ghostEvents = readJsonl<BridgeEvent>(eventsFile2)
    const ghostEnd = ghostEvents.find((e) => e.payload.hook_event_name === 'sessionEnd')?.payload
    expect(ghostEnd?.session_id, 'unknown id is adopted as a fresh chat').toBe(ghost)
    expect(ghostEvents.some((e) => e.payload.hook_event_name === 'sessionStart'), 'no sessionStart on --resume').toBe(false)
    registerTranscriptCleanup(ghostEnd?.transcript_path as string)
  })
})

// =============================================================================
// pi — in-process extension discovered from <cwd>/.pi/extensions (offline:
// fake provider via -e, zero cost). pi is launched by ABSOLUTE PATH on
// purpose: the file channel must fire regardless of how the binary was found
// (alias, rc-file PATH prepend, absolute invocation).
// =============================================================================

describe.skipIf(!LIVE || !hasBin('pi'))('pi hook contract', () => {
  interface PiEvent {
    event: string
    sessionId?: string
    sessionFile?: string
    cateTerminalId: string | null
  }

  // The bridge subscribes to the session + turn lifecycle and stamps every
  // line with the session identity from ctx.sessionManager — the exact API
  // Cate's bridge extension would use.
  const BRIDGE_TS = `
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OUT = process.env.CATE_EVENTS_FILE as string;

export default function (pi: ExtensionAPI) {
  for (const name of [
    "session_start", "session_shutdown",
    "agent_start", "agent_end", "turn_start", "turn_end",
  ] as const) {
    pi.on(name as any, async (event: unknown, ctx: any) => {
      let sessionId: string | undefined;
      let sessionFile: string | undefined;
      try {
        sessionId = ctx?.sessionManager?.getSessionId?.();
        sessionFile = ctx?.sessionManager?.getSessionFile?.();
      } catch {}
      fs.appendFileSync(OUT, JSON.stringify({
        event: name, sessionId, sessionFile,
        cateTerminalId: process.env.CATE_TERMINAL_ID ?? null,
        payload: event,
      }, (_k, v) => (typeof v === "bigint" ? String(v) : v)) + "\\n");
      return undefined;
    });
  }
}
`

  // Offline provider: the whole pi pipeline runs for real (session store,
  // events, resume) with no network and no credentials.
  const FAKE_PROVIDER_TS = `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("fake", {
    name: "Fake Offline Provider",
    baseUrl: "http://localhost:0",
    apiKey: "FAKE_KEY_UNUSED",
    api: "openai-completions",
    streamSimple: (model: any) => {
      const stream = createAssistantMessageEventStream();
      (async () => {
        const output: AssistantMessage = {
          role: "assistant", content: [], api: model.api, provider: model.provider,
          model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop", timestamp: Date.now(),
        } as AssistantMessage;
        stream.push({ type: "start", partial: output });
        (output.content as any).push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        (output.content as any)[0].text = "ok";
        stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: output });
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
      })();
      return stream;
    },
    models: [{ id: "fake-1", name: "Fake One", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000, maxTokens: 4096 }],
  });
}
`

  test('print: workspace-file bridge streams identity + turns; --session resumes', { timeout: 300_000 }, async () => {
    const cwd = makeCwd('pi')
    // The bridge rides the SHIPPED channel: a project-local extension at
    // <cwd>/.pi/extensions/cate-hook.ts, discovered by pi itself — no argv.
    const bridge = join(cwd, '.pi', 'extensions', 'cate-hook.ts')
    mkdirSync(dirname(bridge), { recursive: true })
    writeFileSync(bridge, BRIDGE_TS)
    const fake = join(cwd, 'fake-provider.ts')
    writeFileSync(fake, FAKE_PROVIDER_TS)
    const tid = `cate-term-pi-${Date.now()}`
    // Absolute path — the extension must load regardless of launch method.
    const piBin = execFileSync('which', ['pi']).toString().trim()
    const piArgs = ['-p', '-e', fake, '--provider', 'fake', '--model', 'fake-1']

    const eventsFile = join(cwd, 'events.jsonl')
    await run(piBin, [...piArgs, PROMPT], {
      cwd,
      env: cleanEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }),
      timeout: 120_000,
    })
    const events = readJsonl<PiEvent>(eventsFile)
    const id = events[0]?.sessionId as string
    expect(id).toMatch(UUID_RE)
    // Full lifecycle, every event stamped with the same session identity.
    for (const name of ['session_start', 'agent_start', 'turn_end', 'agent_end', 'session_shutdown']) {
      const hit = events.find((e) => e.event === name)
      expect(hit, `${name} fired`).toBeTruthy()
      expect(hit?.sessionId, `${name} carries the session id`).toBe(id)
    }
    const sessionFile = events[0].sessionFile as string
    expect(sessionFile).toContain(id)
    cleanups.push(() => rmSync(dirname(sessionFile), { recursive: true, force: true }))

    // The event's sessionFile is a real on-disk session store file.
    expect(existsSync(sessionFile)).toBe(true)
    expectEcho(events, tid)

    // Resume via the shipped restore argv (--session <id>): same id, same file.
    const eventsFile2 = join(cwd, 'events-resume.jsonl')
    await run(piBin, [...piArgs, '--session', id, PROMPT2], {
      cwd,
      env: cleanEnv({ CATE_EVENTS_FILE: eventsFile2, CATE_TERMINAL_ID: tid }),
      timeout: 120_000,
    })
    const resumeEvents = readJsonl<PiEvent>(eventsFile2)
    const end = resumeEvents.find((e) => e.event === 'agent_end')
    expect(end, 'agent_end fired on the resumed run').toBeTruthy()
    expect(end?.sessionId, 'resume re-attaches to the SAME session').toBe(id)
    expect(end?.sessionFile).toBe(sessionFile)
    expectEcho(resumeEvents, tid)
  })
})

// =============================================================================
// opencode — in-process plugin at <project>/.opencode/plugin/*.js
// =============================================================================

describe.skipIf(!LIVE || !hasBin('opencode'))('opencode hook contract', () => {
  interface OcEvent {
    type: string
    sessionID: string | null
    status: { type?: string } | string | null
    cate_terminal_id: string | null
    plugin_init?: boolean
  }

  const PLUGIN_JS = `
import { appendFileSync } from "node:fs"
const OUT = process.env.CATE_EVENTS_FILE
export const CateEventLogger = async ({ directory }) => {
  appendFileSync(OUT, JSON.stringify({
    type: "plugin.init", sessionID: null, status: null, directory,
    cate_terminal_id: process.env.CATE_TERMINAL_ID ?? null,
  }) + "\\n")
  return {
    event: async ({ event }) => {
      appendFileSync(OUT, JSON.stringify({
        type: event?.type,
        sessionID: event?.properties?.sessionID ?? event?.properties?.info?.id ?? null,
        status: event?.properties?.status ?? null,
        directory: event?.properties?.info?.directory ?? null,
        cate_terminal_id: process.env.CATE_TERMINAL_ID ?? null,
      }) + "\\n")
    },
  }
}
`

  // The provider on this machine may 401 — the busy→idle lifecycle and the
  // session row are emitted regardless (verified), so a failed completion
  // must NOT fail the contract. Never assert on exit code or reply text.
  const runTolerant = async (args: string[], cwd: string, env: Record<string, string>): Promise<void> => {
    await run('opencode', args, { cwd, env, timeout: 180_000 }).catch(() => {})
  }

  // Injection is a plain file under <project>/.opencode/plugin/: opencode scans
  // `{plugin,plugins}/*.{ts,js}` under each config dir it resolves and imports
  // every match at startup. Two contract details pinned here: the extension
  // must be .js (.mjs is outside the glob), and EVERY exported factory is
  // invoked — not just the default — which is why the shipped plugin has a
  // single named export.
  test('run: .opencode/plugin/*.js streams sessionID + busy/idle; --session resumes', { timeout: 420_000 }, async () => {
    const cwd = makeCwd('opencode')
    mkdirSync(join(cwd, '.opencode', 'plugin'), { recursive: true })
    writeFileSync(join(cwd, '.opencode', 'plugin', 'cate-probe.js'), PLUGIN_JS)
    // .mjs beside it must be ignored — if it were loaded, plugin.init doubles.
    writeFileSync(join(cwd, '.opencode', 'plugin', 'ignored.mjs'), PLUGIN_JS)
    const tid = `cate-term-opencode-${Date.now()}`
    const env = (eventsFile: string): Record<string, string> =>
      cleanEnv({
        CATE_EVENTS_FILE: eventsFile,
        CATE_TERMINAL_ID: tid,
        // The autoupdate modal steals keystrokes and self-updates — never
        // spawn opencode without this.
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      })

    const eventsFile = join(cwd, 'events.jsonl')
    await runTolerant(['run', PROMPT], cwd, env(eventsFile))
    const events = readJsonl<OcEvent>(eventsFile)
    expect(events.filter((e) => e.type === 'plugin.init').length, 'loaded once, from the .js only').toBe(1)
    const created = events.find((e) => e.type === 'session.created')
    expect(created?.sessionID, 'session.created pushes the id').toMatch(/^ses_/)
    const id = created?.sessionID as string
    cleanups.push(() => {
      execFileSync('opencode', ['session', 'delete', id], { env: cleanEnv(), timeout: 30_000 })
      rmSync(join(homedir(), '.local', 'share', 'opencode', 'storage', 'session_diff', `${id}.json`), { force: true })
    })
    // Turn status: busy → idle for this session, then the explicit
    // end-of-turn signal (fires even on the provider-error path).
    expect(
      events.some((e) => e.sessionID === id && (e.status as { type?: string })?.type === 'busy'),
      'session.status busy',
    ).toBe(true)
    expect(events.some((e) => e.type === 'session.idle' && e.sessionID === id), 'session.idle').toBe(true)
    expectEcho(events.map((e) => ({ cateTerminalId: e.cate_terminal_id })), tid)

    // Resume identifies by the first sessionID-bearing event — session.created
    // does NOT fire again, and no NEW session may appear.
    const eventsFile2 = join(cwd, 'events-resume.jsonl')
    await runTolerant(['run', '--session', id, PROMPT2], cwd, env(eventsFile2))
    const resumeEvents = readJsonl<OcEvent>(eventsFile2)
    const firstWithId = resumeEvents.find((e) => e.sessionID)
    expect(firstWithId?.sessionID, 'resume events identify the resumed session').toBe(id)
    expect(
      resumeEvents.some((e) => e.type === 'session.created' && e.sessionID !== id),
      'resume must not create a new session',
    ).toBe(false)
    expect(resumeEvents.some((e) => e.type === 'session.idle' && e.sessionID === id)).toBe(true)
  })

  // Permission-wait is PUSHED: permission.asked fires on the bus when a gated
  // tool call parks on user approval, and the RESOLUTION is pushed as
  // permission.replied (requestID = the asked id) once the user answers.
  // Reaching it needs a model turn that actually CALLS bash, and run mode
  // never asks — so this drives the TUI against a self-hosted offline
  // OpenAI-compatible provider that always answers with a bash tool call
  // (no network, no credentials, no cost).
  test('TUI: permission.asked while a bash call waits; approval pushes permission.replied', { retry: 1, timeout: 420_000 }, async () => {
    const { createServer } = await import('node:http')
    const cwd = makeCwd('opencode-perm')
    mkdirSync(join(cwd, '.opencode', 'plugin'), { recursive: true })
    // Same shape as PLUGIN_JS but with the FULL properties object — the
    // permission payload (permission/metadata) lives beside sessionID.
    writeFileSync(
      join(cwd, '.opencode', 'plugin', 'cate-perm.js'),
      `
import { appendFileSync } from "node:fs"
const OUT = process.env.CATE_EVENTS_FILE
export const CatePermLogger = async () => ({
  event: async ({ event }) => {
    appendFileSync(OUT, JSON.stringify({
      type: event?.type,
      sessionID: event?.properties?.sessionID ?? event?.properties?.info?.id ?? null,
      properties: event?.properties ?? null,
      cate_terminal_id: process.env.CATE_TERMINAL_ID ?? null,
    }) + "\\n")
  },
})
`,
    )

    // One-trick provider: first request streams a bash tool call, the
    // follow-up (carrying the tool result) streams plain text and stops.
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const followUp = body.includes('"tool"')
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (obj: unknown): void => void res.write(`data: ${JSON.stringify(obj)}\n\n`)
        const base = { id: 'cmpl-1', object: 'chat.completion.chunk', created: 1, model: 'fake-1' }
        if (!followUp) {
          send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '' } }] }, finish_reason: null }] })
          send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: 'touch needs-approval.txt', description: 'touch a file' }) } }] }, finish_reason: null }] })
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
        } else {
          send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
        }
        res.write('data: [DONE]\n\n')
        res.end()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    cleanups.push(() => server.close())
    const port = (server.address() as { port: number }).port

    const tid = `cate-term-opencode-perm-${Date.now()}`
    const eventsFile = join(cwd, 'events.jsonl')
    interface PermEvent {
      type: string
      sessionID: string | null
      properties: {
        id?: string
        permission?: string
        sessionID?: string
        metadata?: { command?: string }
        requestID?: string
        reply?: string
      } | null
      cate_terminal_id: string | null
    }
    const events = (): PermEvent[] => readJsonl<PermEvent>(eventsFile)
    const tuiEnv = cleanEnv({
      CATE_EVENTS_FILE: eventsFile,
      CATE_TERMINAL_ID: tid,
      // Config content here is TEST scaffolding (gate bash, register the fake
      // provider) — the plugin itself rides in .opencode/plugin/, as in prod.
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: { bash: 'ask' },
        provider: {
          catefake: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Cate Fake',
            options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'unused' },
            models: { 'fake-1': { name: 'Fake One', tool_call: true, limit: { context: 128000, output: 4096 } } },
          },
        },
        model: 'catefake/fake-1',
      }),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    })

    const tui = await driveTui('opencode', [], cwd, tuiEnv)
    await tui.settle(8_000)
    await tui.send('please run the bash command')
    await tui.waitFor(() => events().some((e) => e.type === 'permission.asked'), 120_000, 'permission.asked')

    const created = events().find((e) => e.type === 'session.created')
    const id = created?.sessionID as string
    expect(id).toMatch(/^ses_/)
    cleanups.push(() => {
      execFileSync('opencode', ['session', 'delete', id], { env: cleanEnv(), timeout: 30_000 })
      rmSync(join(homedir(), '.local', 'share', 'opencode', 'storage', 'session_diff', `${id}.json`), { force: true })
    })
    const asked = events().find((e) => e.type === 'permission.asked')?.properties
    expect(asked?.sessionID, 'permission-wait identifies the session').toBe(id)
    expect(asked?.permission).toBe('bash')
    expect(asked?.metadata?.command).toContain('touch')
    // The turn is still busy while parked on approval — idle has not fired.
    expect(events().some((e) => e.type === 'session.idle' && e.sessionID === id)).toBe(false)

    // Approve (Enter accepts the highlighted "allow once"): permission.replied
    // resolves the SAME request, then the turn runs on to completion.
    await tui.send('')
    await tui.waitFor(() => events().some((e) => e.type === 'permission.replied'), 60_000, 'permission.replied')
    const replied = events().find((e) => e.type === 'permission.replied')?.properties
    expect(replied?.sessionID).toBe(id)
    expect(replied?.requestID, 'resolution references the asked request').toBe(asked?.id)
    expect(replied?.reply).toBeTruthy()
    await tui.waitFor(
      () => events().some((e) => e.type === 'session.idle' && e.sessionID === id),
      120_000,
      'session.idle after approval',
    )
    expectEcho(events().map((e) => ({ cateTerminalId: e.cate_terminal_id })), tid)
    tui.kill()
  })
})

// =============================================================================
// grok (xAI Grok Build) — hooks via <project>/.grok/hooks/*.json, gated on
// grok's own folder trust. Closest sibling to codex: a repo file grok
// discovers itself, silently inert until the user grants trust once. Two
// things make grok unlike every other CLI here and drive the product design:
//
//   1. The payload is camelCase (hookEventName / sessionId / cwd /
//      workspaceRoot / toolName), and the EVENT NAME VALUE is snake_case
//      ("session_start") even though the config key is CamelCase
//      ("SessionStart"). Config casing and payload casing are different
//      alphabets; both are pinned below.
//   2. grok also SCANS OTHER VENDORS' hook files — <project>/.claude/
//      settings.json and settings.local.json, plus .cursor/hooks.json — by
//      default ([compat.claude] hooks). Cate already injects its bridge into
//      .claude/settings.local.json, so in any workspace with claude injection
//      a grok session fires the CLAUDE-labelled bridge wrapper, which would
//      otherwise report agentId=claude-code for a grok process (wrong panel
//      label, wrong presence, wrong resume command). The disambiguator is
//      GROK_HOOK_EVENT: a reserved var grok's hook runner injects into EVERY
//      hook process it spawns, whatever file the hook came from. The shipped
//      bridge drops a post whose baked-in agent id disagrees with that marker;
//      these tests pin the marker's presence on both hook sources.
//
// Harness-only trust: GROK_FOLDER_TRUST=0 ungates project hooks without
// writing to the user's ~/.grok (the shipped product plants no trust — the
// user grants it once via /hooks-trust, exactly like codex's review prompt).
//
// Verified live 2026-07-21 against grok 0.2.106.
// =============================================================================

describe.skipIf(!LIVE || !hasBin('grok'))('grok hook contract', () => {
  /** hooks.json event keys are CamelCase; the payload's hookEventName echoes
   *  the same events in snake_case. Both casings are contract. */
  const GROK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd', 'Notification']

  /** A cwd that grok resolves a PROJECT ROOT for. Project-scoped hooks are
   *  keyed on that root, and grok derives it from the git repo — a plain
   *  directory yields projectRoot=null and loads no project hooks at all
   *  (pinned below). */
  const makeRepo = (sub: string): string => {
    const dir = makeCwd(sub)
    execFileSync('git', ['init', '-q'], { cwd: dir })
    return dir
  }

  /** The SHIPPED channel: one JSON file under <project>/.grok/hooks/. */
  const writeGrokHooks = (root: string, bridge: string): void => {
    mkdirSync(join(root, '.grok', 'hooks'), { recursive: true })
    writeFileSync(
      // Same filename the shipped injection uses (grokSpec's relPath).
      join(root, '.grok', 'hooks', 'cate-hook.json'),
      JSON.stringify({
        hooks: Object.fromEntries(GROK_EVENTS.map((e) => [e, [{ hooks: [{ type: 'command', command: bridge, timeout: 60 }] }]])),
      }),
    )
  }

  /** The file Cate injects for CLAUDE — which grok reads too (compat scan). */
  const writeClaudeCompatHooks = (root: string, bridge: string): void => {
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(
      join(root, '.claude', 'settings.local.json'),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: bridge }] }] } }),
    )
  }

  /** HARNESS ONLY — ungates project hooks without touching the user's
   *  ~/.grok/trusted_folders.toml. A headless PTY cannot answer the
   *  interactive folder-trust prompt deterministically. */
  const untrustedEnv = (extra: Record<string, string> = {}): Record<string, string> => cleanEnv(extra)
  const trustedEnv = (extra: Record<string, string> = {}): Record<string, string> =>
    cleanEnv({ GROK_FOLDER_TRUST: '0', ...extra })

  /** Never let a test run self-update the binary out from under the suite. */
  const NO_UPDATE = ['--no-auto-update']

  const byName = (events: BridgeEvent[], snakeName: string): BridgeEvent[] =>
    events.filter((e) => e.payload.hookEventName === snakeName)

  interface InspectHook {
    event: string
    hookType: string
    target: string
    source: { type: string; path: string }
    vendor?: string
    compatibilityStatus?: string
  }

  /** `grok inspect --json` — grok's own view of what it discovered for a
   *  directory. Costs nothing and needs no auth, so the discovery/trust half
   *  of the contract is pinned even when the account is logged out. */
  const inspect = (
    cwd: string,
    env: Record<string, string>,
  ): { hooks: InspectHook[]; projectTrusted: boolean; projectRoot: string | null; skills?: Array<{ name: string; source: { path: string } }> } =>
    JSON.parse(execFileSync('grok', ['inspect', '--json'], { cwd, env, timeout: 60_000 }).toString())

  // ---------------------------------------------------------------------------
  // Discovery + trust (auth-free)
  // ---------------------------------------------------------------------------

  // The safety property Cate's injection rides on, and the reason a freshly
  // injected workspace can be silent: an UNTRUSTED project's hooks are not
  // "errored", they are invisible. Cate must treat missing grok events as
  // normal, never as a broken install.
  test('inspect: project hooks are silently skipped until the folder is trusted', () => {
    const cwd = makeRepo('grok-untrusted')
    writeGrokHooks(cwd, writeBridge(cwd))
    const seen = inspect(cwd, untrustedEnv())
    expect(seen.projectTrusted, 'a fresh project starts untrusted').toBe(false)
    expect(seen.hooks, 'untrusted project contributes NO hooks').toEqual([])
  })

  // Project scope is anchored on a git repo: in a plain directory grok
  // resolves NO project root and .grok/hooks is never consulted — trusted or
  // not. A non-repo workspace therefore gets no grok hooks at all.
  test('inspect: a non-repo directory resolves no project root and loads no project hooks', () => {
    const cwd = makeCwd('grok-norepo')
    writeGrokHooks(cwd, writeBridge(cwd))
    const seen = inspect(cwd, trustedEnv())
    expect(seen.projectRoot, 'no git repo — no project root').toBeNull()
    expect(seen.hooks, 'project hooks need a project root').toEqual([])
  })

  // The shipped file lands where grok looks, with the shape grok parses.
  test('inspect: a trusted project loads .grok/hooks/*.json', () => {
    const cwd = makeRepo('grok-trusted')
    const bridge = writeBridge(cwd)
    writeGrokHooks(cwd, bridge)
    const seen = inspect(cwd, trustedEnv())
    expect(seen.projectTrusted).toBe(true)
    for (const event of GROK_EVENTS) {
      const hit = seen.hooks.find((h) => h.event === event && h.target === bridge)
      expect(hit, `${event} handler registered from .grok/hooks`).toBeTruthy()
      expect(hit?.hookType).toBe('command')
      expect(hit?.source.type).toBe('project')
      expect(hit?.source.path, 'sourced from the .grok/hooks dir').toContain(join('.grok', 'hooks'))
      expect(hit?.vendor, 'a native grok hook carries no vendor tag').toBeUndefined()
    }
  })

  // THE cross-vendor contract: grok reads Cate's CLAUDE injection too. If this
  // ever stops being true the disambiguation in the bridge becomes dead code;
  // while it IS true, a grok session in a claude-injected workspace posts
  // through the claude-labelled wrapper and must be re-attributed.
  test('inspect: grok also loads the .claude/settings.local.json Cate injects, tagged vendor=claude', () => {
    const cwd = makeRepo('grok-compat')
    const bridge = writeBridge(cwd)
    writeClaudeCompatHooks(cwd, bridge)
    const seen = inspect(cwd, trustedEnv())
    const compat = seen.hooks.find((h) => h.event === 'SessionStart' && h.target === bridge)
    expect(compat, 'grok discovers the claude-vendored hook file').toBeTruthy()
    expect(compat?.vendor).toBe('claude')
    expect(compat?.compatibilityStatus).toBe('enabled')
    expect(compat?.source.path, 'sourced from the repo .claude dir').toContain('.claude')

    // Dedup: an IDENTICAL command registered for the same event by both
    // sources collapses to one handler, and the claude-vendored entry is the
    // survivor. Cate does NOT rely on this — its two wrappers have different
    // paths (the agent id is baked into the wrapper argv) — but if it ever
    // stopped holding for identical commands, a user who hand-copied one
    // command into both files would get doubled events.
    writeGrokHooks(cwd, bridge)
    const same = inspect(cwd, trustedEnv()).hooks.filter((h) => h.event === 'SessionStart' && h.target === bridge)
    expect(same.length, 'identical command in both sources = ONE handler').toBe(1)
    expect(same[0].vendor, 'the claude-vendored entry survives dedup').toBe('claude')

    // The shipped shape: DIFFERENT commands (per-agent wrappers) both load, so
    // a grok session in a claude-injected workspace fires BOTH bridges. That
    // is what the GROK_HOOK_EVENT guard exists to disambiguate.
    const grokBridge = join(cwd, 'cate-bridge-grok.js')
    writeFileSync(grokBridge, readFileSync(bridge, 'utf8'))
    chmodSync(grokBridge, 0o755)
    writeGrokHooks(cwd, grokBridge)
    const distinct = inspect(cwd, trustedEnv()).hooks.filter((h) => h.event === 'SessionStart')
    expect(distinct.length, 'distinct commands BOTH load').toBe(2)
    expect(distinct.filter((h) => h.vendor === 'claude').length).toBe(1)
    expect(distinct.filter((h) => h.vendor === undefined).length).toBe(1)
  })

  // ---------------------------------------------------------------------------
  // Skills (auth-free) — the OTHER half of Cate's per-agent integration, whose
  // install dir is declared alongside the hook spec in src/shared/agents.ts.
  // ---------------------------------------------------------------------------

  // Cate installs grok skills to <project>/.grok/skills (AgentDef.skills). grok
  // ALSO reads .agents, .claude and .cursor skills, but those dirs belong to
  // the agents that own them — installing there would double-write a skill the
  // user asked for once.
  test('inspect: a skill installed to .grok/skills is discovered as a project skill', () => {
    const cwd = makeRepo('grok-skills')
    const name = 'cate-probe-skill'
    mkdirSync(join(cwd, '.grok', 'skills', name), { recursive: true })
    writeFileSync(
      join(cwd, '.grok', 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: probe\n---\n\nbody\n`,
    )
    const found = inspect(cwd, cleanEnv()).skills?.find((s) => s.name === name)
    expect(found, 'grok discovers the skill Cate installed').toBeTruthy()
    expect(found?.source.path).toContain(join('.grok', 'skills', name))
  })

  // Skills and hooks degrade INDEPENDENTLY: folder trust gates code execution
  // (hooks/MCP/LSP), not skill discovery. So in a repo the user has not trusted
  // yet, a Cate-installed skill works immediately while its hooks stay inert —
  // Cate must not treat "no hook events" as "the grok integration is broken".
  test('inspect: skills load in an UNTRUSTED project where hooks do not', () => {
    const cwd = makeRepo('grok-skills-untrusted')
    const name = 'cate-probe-untrusted'
    mkdirSync(join(cwd, '.grok', 'skills', name), { recursive: true })
    writeFileSync(
      join(cwd, '.grok', 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: probe\n---\n\nbody\n`,
    )
    writeGrokHooks(cwd, writeBridge(cwd))

    const seen = inspect(cwd, untrustedEnv())
    expect(seen.projectTrusted, 'hooks present + never granted = untrusted').toBe(false)
    expect(seen.hooks, 'hooks stay inert').toEqual([])
    expect(seen.skills?.some((s) => s.name === name), 'skills load anyway').toBe(true)
  })

  // ---------------------------------------------------------------------------
  // Live sessions (needs a logged-in grok — `grok login`)
  // ---------------------------------------------------------------------------

  test('headless: hooks stream identity + turn status through one session id', { timeout: 420_000 }, async () => {
    const cwd = makeRepo('grok-headless')
    const bridge = writeBridge(cwd)
    writeGrokHooks(cwd, bridge)
    const tid = `cate-term-grok-${Date.now()}`
    const eventsFile = join(cwd, 'events.jsonl')

    await run(
      'grok',
      [...NO_UPDATE, '-p', PROMPT],
      { cwd, env: trustedEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }), timeout: 300_000 },
    )
    const events = readJsonl<BridgeEvent>(eventsFile)
    const start = byName(events, 'session_start')[0]?.payload
    expect(start, 'SessionStart fired — absence means hook discovery or trust drifted').toBeTruthy()
    // Payload casing: camelCase keys, snake_case event VALUE. Both are pinned
    // because the normalizer keys off exactly these spellings.
    expect(start?.sessionId, 'session ids are UUIDs (v7 when grok generates them)').toMatch(UUID_RE)
    expect(start?.cwd, 'hook payload cwd is the session join key').toBe(cwd)
    expect(start?.workspaceRoot, 'workspaceRoot resolves to the project').toContain(cwd)
    expect(start?.session_id, 'no snake_case alias — camelCase only').toBeUndefined()
    const id = start?.sessionId as string

    for (const name of ['user_prompt_submit', 'stop']) {
      const hits = byName(events, name)
      expect(hits.length, `${name} fired`).toBeGreaterThan(0)
      for (const h of hits) expect(h.payload.sessionId, `${name} reports the same id`).toBe(id)
    }
    // Turn order is the state machine the tracker runs.
    const order = events.map((e) => e.payload.hookEventName)
    expect(order.indexOf('stop')).toBeGreaterThan(order.indexOf('user_prompt_submit'))
    expect(order.indexOf('user_prompt_submit')).toBeGreaterThan(order.indexOf('session_start'))

    // The reserved runner env — the deterministic "grok spawned me" marker.
    const first = events[0]
    expect(first.env?.GROK_HOOK_EVENT, 'runner injects the event name').toBe('session_start')
    expect(first.env?.GROK_SESSION_ID, 'runner injects the session id').toBe(id)
    expect(first.env?.GROK_WORKSPACE_ROOT).toContain(cwd)
    expectEcho(events, tid)

    // Presence lineage: the hook process is a descendant of the grok CLI, so
    // the real tracker must resolve the recorded parent pid to a live grok.
    // (Asserted against the process tree captured while the run was alive is
    // impossible headlessly — the run has exited — so only the claim shape is
    // checked here; the TUI test below does the live ancestry walk.)
    const lineage = events.find((e) => typeof e.ppid === 'number')
    expect(lineage, 'bridge recorded its parent pid').toBeTruthy()

    cleanups.push(() => rmSync(join(homedir(), '.grok', 'sessions'), { recursive: true, force: true }))
  })

  test('headless: PostToolUse reports the tool that ran', { timeout: 420_000 }, async () => {
    const cwd = makeRepo('grok-tool')
    const bridge = writeBridge(cwd)
    writeGrokHooks(cwd, bridge)
    const tid = `cate-term-grok-tool-${Date.now()}`
    const eventsFile = join(cwd, 'events.jsonl')

    await run(
      'grok',
      [...NO_UPDATE, '--permission-mode', 'bypassPermissions', '-p', 'Run exactly this shell command: echo cate-pt-probe'],
      { cwd, env: trustedEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }), timeout: 300_000 },
    )
    const events = readJsonl<BridgeEvent>(eventsFile)
    const post = byName(events, 'post_tool_use')[0]?.payload
    expect(post, 'PostToolUse fired').toBeTruthy()
    expect(post?.sessionId).toBe(byName(events, 'session_start')[0]?.payload.sessionId)
    // grok's OWN tool name, not the claude alias the matcher accepts.
    expect(post?.toolName).toBe('run_terminal_command')
    expect((post?.toolInput as { command?: string })?.command).toContain('echo')
    const order = events.map((e) => e.payload.hookEventName)
    expect(order.indexOf('stop')).toBeGreaterThan(order.indexOf('post_tool_use'))
    expectEcho(events, tid)
  })

  // Resume is the terminal-restore contract: the shipped argv (`grok --resume
  // <id>`) must keep pushing hook events, and an id that no longer exists must
  // FAIL rather than silently starting a fresh session under the stale stamp.
  test('headless: resume keeps hooks flowing; an unknown id fails', { timeout: 420_000 }, async () => {
    const cwd = makeRepo('grok-resume')
    const bridge = writeBridge(cwd)
    writeGrokHooks(cwd, bridge)
    const tid = `cate-term-grok-resume-${Date.now()}`

    const eventsFile = join(cwd, 'events.jsonl')
    await run(
      'grok',
      [...NO_UPDATE, '-p', PROMPT],
      { cwd, env: trustedEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }), timeout: 300_000 },
    )
    const id = byName(readJsonl<BridgeEvent>(eventsFile), 'session_start')[0]?.payload.sessionId as string
    expect(id).toMatch(UUID_RE)

    const eventsFile2 = join(cwd, 'events-resume.jsonl')
    await run(
      'grok',
      [...NO_UPDATE, '--resume', id, '-p', PROMPT2],
      { cwd, env: trustedEnv({ CATE_EVENTS_FILE: eventsFile2, CATE_TERMINAL_ID: tid }), timeout: 300_000 },
    )
    const resumeEvents = readJsonl<BridgeEvent>(eventsFile2)
    const resumed = byName(resumeEvents, 'session_start')[0]?.payload
    expect(resumed, 'SessionStart fires on the resumed run').toBeTruthy()
    expect(resumed?.sessionId, 'resume re-attaches to the SAME session').toBe(id)
    expect(byName(resumeEvents, 'stop').length, 'the resumed turn completes').toBeGreaterThan(0)
    expectEcho(resumeEvents, tid)

    // A dead id must reject — this is what lets Cate fall back to a plain shell.
    await expect(
      run('grok', [...NO_UPDATE, '--resume', '99999999-9999-4999-8999-999999999999', '-p', 'hi'],
        { cwd, env: trustedEnv(), timeout: 120_000 }),
    ).rejects.toThrow()
  })

  // The gate behind RESUMABLE_FROM_SESSION_START (agentSessionStamps.ts): is
  // the id announced by SessionStart resumable BEFORE the turn it opened for
  // finished? For claude it is not — it announces at TUI launch, and resuming
  // that empty id fails, so claude is stamped only from its first turn event.
  // grok is safe: SessionStart is deferred to the submit, so the session is
  // already on disk, and a run killed mid-turn still resumes. A regression
  // here would make Cate hand a restored terminal a resume command that
  // errors — degrading silently to a plain shell.
  test('a session killed mid-turn is still resumable from its SessionStart id', { retry: 1, timeout: 420_000 }, async () => {
    const cwd = makeRepo('grok-midturn')
    const bridge = writeBridge(cwd)
    writeGrokHooks(cwd, bridge)
    const tid = `cate-term-grok-mid-${Date.now()}`
    const eventsFile = join(cwd, 'events.jsonl')
    const events = (): BridgeEvent[] => readJsonl<BridgeEvent>(eventsFile)

    const tui = await driveTui(
      'grok',
      NO_UPDATE,
      cwd,
      trustedEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }),
    )
    await tui.settle(10_000)
    // A long answer, so the turn is still running when we pull the plug.
    await tui.send('Count slowly from 1 to 40, one number per line.')
    await tui.waitFor(() => byName(events(), 'session_start').length > 0, 120_000, 'SessionStart')
    const id = byName(events(), 'session_start')[0].payload.sessionId as string
    expect(byName(events(), 'stop'), 'killed before the turn completed').toEqual([])
    tui.kill()
    await sleep(2_000)

    // The shipped restore argv must succeed against that id.
    await run('grok', [...NO_UPDATE, '--resume', id, '-p', PROMPT], { cwd, env: trustedEnv(), timeout: 300_000 })
  })

  // The misattribution guard, pinned end to end: with ONLY Cate's claude
  // injection present (no .grok/hooks), a grok run still fires that bridge —
  // and the process it fires carries GROK_HOOK_EVENT, which is how the shipped
  // bridge knows the payload is grok's and not claude's.
  test('headless: the claude-injected bridge fires for grok, marked by GROK_HOOK_EVENT', { timeout: 420_000 }, async () => {
    const cwd = makeRepo('grok-crossfire')
    const bridge = writeBridge(cwd)
    writeClaudeCompatHooks(cwd, bridge) // no .grok/hooks on purpose
    const tid = `cate-term-grok-x-${Date.now()}`
    const eventsFile = join(cwd, 'events.jsonl')

    await run(
      'grok',
      [...NO_UPDATE, '-p', PROMPT],
      { cwd, env: trustedEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }), timeout: 300_000 },
    )
    const events = readJsonl<BridgeEvent>(eventsFile)
    expect(events.length, 'grok fired the claude-vendored hook file').toBeGreaterThan(0)
    const start = events[0]
    // Payload is grok-shaped even though the FILE is claude's — a claude
    // normalizer reading hook_event_name would see nothing and drop it, while
    // presence would still be credited to claude. Hence the env marker.
    expect(start.payload.hookEventName).toBe('session_start')
    expect(start.payload.hook_event_name).toBeUndefined()
    expect(start.env?.GROK_HOOK_EVENT, 'the disambiguator is present on a compat-sourced hook').toBe('session_start')
    expect(start.env?.CLAUDE_PROJECT_DIR, 'grok sets the claude-compat alias too').toContain(cwd)
    expectEcho(events, tid)
  })

  // The TUI opens on a WELCOME MENU (New worktree / Resume session / Changelog
  // / Quit) — no session exists yet, so NO hook fires at launch. Identity
  // arrives with the first prompt submit, where SessionStart and
  // UserPromptSubmit land together. Same deferral as codex, opposite of claude
  // and cursor: Cate cannot stamp a restored grok terminal until the user
  // prompts, and until then the terminal has no session id to restore against.
  test('TUI: hooks are silent at launch; SessionStart arrives with the first submit', { retry: 1, timeout: 420_000 }, async () => {
    const cwd = makeRepo('grok-tui')
    const bridge = writeBridge(cwd)
    writeGrokHooks(cwd, bridge)
    const tid = `cate-term-grok-tui-${Date.now()}`
    const eventsFile = join(cwd, 'events.jsonl')
    const events = (): BridgeEvent[] => readJsonl<BridgeEvent>(eventsFile)

    const tui = await driveTui(
      'grok',
      NO_UPDATE,
      cwd,
      trustedEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }),
    )
    await tui.settle(12_000)
    expect(
      events().map((e) => e.payload.hookEventName),
      'no hook fires while the welcome menu is up',
    ).toEqual([])

    await tui.send(PROMPT)
    await tui.waitFor(() => byName(events(), 'session_start').length > 0, 120_000, 'SessionStart after submit')
    const start = byName(events(), 'session_start')[0].payload
    expect(start.sessionId).toMatch(UUID_RE)
    expect(start.cwd).toBe(cwd)
    // Deferred, but still ordered: the session opens before the prompt it was
    // opened for.
    await tui.waitFor(() => byName(events(), 'user_prompt_submit').length > 0, 60_000, 'UserPromptSubmit')
    expect(byName(events(), 'user_prompt_submit')[0].payload.sessionId).toBe(start.sessionId)

    const lineage = events().find((e) => typeof e.ppid === 'number')
    expect(lineage, 'bridge recorded its parent pid').toBeTruthy()
    const tracker = createAgentPresenceTracker({ snapshot: snapshotProcessTree })
    await tracker.notePost(tid, 'grok', lineage!.ppid)
    expect(
      tracker.presenceFor(tid, await snapshotProcessTree()),
      'ancestry walk lands on the live grok',
    ).toEqual({ agentName: 'Grok', agentPresent: true })

    await tui.waitFor(() => byName(events(), 'stop').length > 0, 180_000, 'Stop')
    expect(byName(events(), 'stop')[0].payload.sessionId).toBe(start.sessionId)
    expectEcho(events(), tid)
    tui.kill()
  })

  // Permission-wait is PUSHED, and spelled exactly like claude's:
  // Notification with notificationType "permission_prompt". PreToolUse fires
  // ~30ms earlier for the SAME call, but it fires before every tool whether or
  // not approval is needed (cursor's problem), so Notification is the only
  // event that means "parked on the user".
  //
  // This test CANCELS the prompt instead of approving it. Blind-Enter on grok's
  // approval menu is not safe to automate: the highlighted row can be a
  // remembered "always allow" grant, and accepting it writes
  // `[ui] permission_mode = "always-approve"` into the USER-GLOBAL
  // ~/.grok/config.toml — silently disabling every approval prompt on the
  // machine, and poisoning later runs of this very test (the second run never
  // prompts, so it times out). Cancelling keeps the run inert. The resolution
  // half of the contract (PostToolUse marks the turn back in flight) is covered
  // by the headless PostToolUse test, which needs no menu interaction.
  test('TUI: Notification(permission_prompt) fires while blocked on approval', { retry: 1, timeout: 420_000 }, async () => {
    const cwd = makeRepo('grok-perm')
    const bridge = writeBridge(cwd)
    writeGrokHooks(cwd, bridge)
    const tid = `cate-term-grok-perm-${Date.now()}`
    const eventsFile = join(cwd, 'events.jsonl')
    const events = (): BridgeEvent[] => readJsonl<BridgeEvent>(eventsFile)

    const tui = await driveTui(
      'grok',
      NO_UPDATE,
      cwd,
      trustedEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }),
    )
    await tui.settle(10_000)
    await tui.send('Use the shell tool to run exactly this command: touch needs-approval.txt')
    await tui.waitFor(
      () => byName(events(), 'notification').some((e) => e.payload.notificationType === 'permission_prompt'),
      180_000,
      'Notification(permission_prompt)',
    )
    const id = byName(events(), 'session_start')[0].payload.sessionId as string
    const perm = byName(events(), 'notification').find((e) => e.payload.notificationType === 'permission_prompt')?.payload
    expect(perm?.sessionId, 'permission-wait identifies the session').toBe(id)
    expect(perm?.message).toContain('permission')
    // Still in flight — the wait signal precedes any Stop.
    expect(byName(events(), 'stop').length, 'no Stop while blocked on approval').toBe(0)

    // PreToolUse is deliberately NOT in the shipped file, so it is absent
    // here: it fires ~30ms before this Notification for the same call, but it
    // precedes EVERY tool call, approved or not (cursor's problem), so it
    // cannot mark a wait. Notification is the only event that means "parked".
    expect(byName(events(), 'pre_tool_use'), 'PreToolUse is not injected').toEqual([])

    // session_start carries NO transcriptPath (the session file does not exist
    // yet); every later event does. The normalizer must treat it as optional.
    const startPayload = byName(events(), 'session_start')[0].payload
    expect(startPayload.transcriptPath, 'absent on session_start').toBeUndefined()
    expect(startPayload.source).toBe('new')
    expect(perm?.transcriptPath, 'later events carry the updates.jsonl path').toContain('.grok/sessions/')

    // The hazard, pinned: row 1 of grok's approval menu is PRESELECTED and is
    // the blanket grant, so a bare Enter here silently turns approvals off for
    // the whole machine. If this assertion ever fails, re-read the menu before
    // touching the key this test sends.
    //   1 (●) Yes, and don't ask again for anything (always-approve mode)
    //   2 (○) Yes, proceed
    //   3 (○) No, reject (type to add feedback)
    expect(tui.peek(), 'approval menu still defaults to the blanket grant').toContain('always-approve')

    // Ctrl+C cancels the turn (Esc does NOT dismiss this menu — verified).
    // "Turn cancelled by user", Stop fires, and no grant is persisted.
    tui.press('\x03')
    await tui.waitFor(() => byName(events(), 'stop').length > 0, 120_000, 'Stop after cancel')
    expect(byName(events(), 'stop')[0].payload.sessionId).toBe(id)
    // The gated command never ran.
    expect(existsSync(join(cwd, 'needs-approval.txt')), 'cancelled tool call did not execute').toBe(false)
    expectEcho(events(), tid)
    tui.kill()

    // Guard the machine-global side effect this test used to cause: nothing
    // here may write a blanket approval into the user's grok config.
    const userConfig = join(homedir(), '.grok', 'config.toml')
    if (existsSync(userConfig)) {
      expect(readFileSync(userConfig, 'utf8'), 'test must not grant a global always-approve')
        .not.toContain('always-approve')
    }
  })
})
