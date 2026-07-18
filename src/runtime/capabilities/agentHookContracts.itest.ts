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
// user's restored terminal. The store-join steps below also keep the shipped
// fallback probe's parsers (agentSessions.ts) pinned: every id learned from a
// hook is asserted to join the same on-disk store the probe scans.
//
// Per-CLI mechanism (all verified live 2026-07-18):
//   claude  · JSON-on-stdin hooks injected per-invocation via --settings
//             '<inline JSON>'. session_id/transcript_path/cwd on every event;
//             /clear = SessionEnd(reason=clear) + SessionStart(source=clear,
//             new id); --session-id pre-assigns the id. Works in -p and TUI.
//   codex   · JSON-on-stdin hooks injected per-invocation via -c overrides.
//             Untrusted hooks are SILENTLY skipped: a hooks.state entry with a
//             trusted_hash (sha256 of the canonical handler identity, key
//             source "/<session-flags>/config.toml") must ride along — the
//             hash scheme is internal, so THIS is the contract most likely to
//             drift. transcript_path IS the rollout file; exec resume reuses
//             the same id + file (source="resume"). SessionEnd never fires.
//   pi      · in-process extension via -e <file.ts>; ctx.sessionManager gives
//             sessionId + sessionFile on every event; agent_start/agent_end
//             bracket each turn; --session-id creates-or-resumes an exact id.
//             The test registers a fake offline provider (also via -e), so pi
//             runs cost nothing and need no credentials.
//   opencode· in-process plugin injected via OPENCODE_CONFIG_CONTENT env (no
//             config file); bus events carry sessionID; session.status
//             busy/idle + session.idle mark turn state. The full lifecycle
//             fires even when the provider errors, so this works with broken
//             auth. ALWAYS spawn with OPENCODE_DISABLE_AUTOUPDATE=1 — the TUI
//             update modal steals keystrokes and self-updates.
//   cursor  · <cwd>/.cursor/hooks.json (project-scoped; fine for a throwaway
//             cwd). conversation_id (= chats/<md5(cwd)>/<id> dir) on every
//             event. TUI fires beforeSubmitPrompt/stop/afterAgentResponse;
//             print mode does NOT (only sessionStart/sessionEnd). sessionStart
//             does not fire on --resume. create-chat pre-assigns an id.
//   agy     · <cwd>/.agents/hooks.json (agy-specific schema, NOT Claude's),
//             trust pre-seeded via trustedWorkspaces in
//             ~/.gemini/antigravity-cli/settings.json. conversationId on every
//             event = the `agy --conversation=<id>` resume handle. Hooks fire
//             in interactive mode ONLY (never in -p). Only PreInvocation/Stop
//             are registered — an observing PreToolUse hook that doesn't
//             answer {"decision":"allow"} blocks tool calls.
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
import { createHash, randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { FILE_STORES, newestCursorSessionFor, newestOpencodeSessionFor } from './agentSessions'

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

// A nested CLAUDECODE/ANTHROPIC/CODEX env changes the CLIs' behavior (observed:
// claude silently stops persisting transcripts) — always drive them with the
// agent vars stripped, like a real Cate terminal.
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k, v]) => v !== undefined && !/^(CLAUDE|ANTHROPIC|CODEX)/i.test(k) && k !== 'CLAUDECODE',
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

async function until(pred: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return
    await sleep(250)
  }
  throw new Error(`timeout waiting for ${label}`)
}

// --- the bridge: one hook process shape for all stdin-JSON CLIs --------------
// (claude, codex, cursor, agy all deliver one JSON payload on stdin. The
// events-file path and the terminal correlation id both arrive via env — that
// env inheritance IS part of the contract under test: Cate correlates a hook
// event to a terminal by the CATE_TERMINAL_ID it planted on the PTY. No
// stdout on purpose: agy denies tool calls on non-allow hook output, and
// every CLI accepts silent exit-0.)
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
  fs.appendFileSync(process.env.CATE_EVENTS_FILE, JSON.stringify({
    terminalId: process.env.CATE_TERMINAL_ID ?? null,
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
  // (claude, codex, cursor ask in a fresh cwd; default is "yes, trust") and
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
    send: async (line) => {
      p.write(line)
      await sleep(600) // let TUI input handling settle before submit
      p.write('\r')
    },
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
// claude — hooks via --settings inline JSON
// =============================================================================

describe.skipIf(!LIVE || !hasBin('claude'))('claude hook contract', () => {
  const claudeSettings = (bridge: string): string =>
    JSON.stringify({
      hooks: Object.fromEntries(
        ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'].map((e) => [
          e,
          [{ hooks: [{ type: 'command', command: bridge }] }],
        ]),
      ),
    })

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
    const tid = `cate-term-claude-${Date.now()}`
    const events = (): BridgeEvent[] => readJsonl<BridgeEvent>(eventsFile)

    const tui = await driveTui(
      'claude',
      ['--model', 'haiku', '--settings', claudeSettings(bridge)],
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

    // Store join: transcript_path is real and the shipped fallback probe's
    // parser reads the same id + cwd from it.
    expect(existsSync(transcript1), 'transcript exists after first prompt').toBe(true)
    const meta = FILE_STORES['claude-code'].meta(readFileSync(transcript1, 'utf8'))
    expect(meta).toEqual({ sessionId: id1, cwd })

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

  test('print mode: --session-id pre-assigns the id; hooks fire on a resume relaunch', { timeout: 300_000 }, async () => {
    const cwd = makeCwd('claude-assign')
    const bridge = writeBridge(cwd)
    const tid = `cate-term-claude-p-${Date.now()}`
    const assigned = randomUUID()

    // Pre-assignment: Cate can CHOOSE the session id at spawn instead of
    // discovering it — the strongest possible terminal↔session binding.
    const eventsFile = join(cwd, 'events-assign.jsonl')
    await run(
      'claude',
      ['-p', PROMPT, '--model', 'haiku', '--session-id', assigned, '--settings', claudeSettings(bridge)],
      { cwd, env: cleanEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }), timeout: 240_000 },
    )
    const events = readJsonl<BridgeEvent>(eventsFile)
    for (const name of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      const hits = events.filter((e) => e.payload.hook_event_name === name)
      expect(hits.length, `${name} fired`).toBeGreaterThan(0)
      for (const h of hits) expect(h.payload.session_id, `${name} reports the assigned id`).toBe(assigned)
    }
    const transcript = events[0].payload.transcript_path as string
    expect(existsSync(transcript), 'assigned-id transcript exists').toBe(true)
    cleanups.push(() => rmSync(dirname(transcript), { recursive: true, force: true }))
    expectEcho(events, tid)

    // Resume relaunch: hooks keep flowing. claude may FORK on resume (shadow
    // session continuing the original transcript) — the id is not asserted;
    // the contract is that the relaunched process pushes events at all, so
    // Cate's tracker re-stamps whatever the fork produced.
    const eventsFile2 = join(cwd, 'events-resume.jsonl')
    await run(
      'claude',
      ['-p', PROMPT2, '--resume', assigned, '--model', 'haiku', '--settings', claudeSettings(bridge)],
      { cwd, env: cleanEnv({ CATE_EVENTS_FILE: eventsFile2, CATE_TERMINAL_ID: tid }), timeout: 240_000 },
    )
    const resumeEvents = readJsonl<BridgeEvent>(eventsFile2)
    const stops = resumeEvents.filter((e) => e.payload.hook_event_name === 'Stop')
    expect(stops.length, 'Stop fired on the resumed run').toBeGreaterThan(0)
    expect(stops[0].payload.session_id).toMatch(UUID_RE)
    expectEcho(resumeEvents, tid)
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
// codex — hooks via -c overrides + self-supplied trusted_hash
// =============================================================================

describe.skipIf(!LIVE || !hasBin('codex'))('codex hook contract', () => {
  // Untrusted hooks are SILENTLY skipped, so a per-invocation injection must
  // bring its own hooks.state trust entry. Key + hash formats are codex
  // internals (source comment: "replace this positional suffix with a durable
  // hook id") — when this breaks, THIS assertion is the early warning.
  const trustedHash = (label: string, command: string, timeout: number): string => {
    const identity =
      `{"event_name":${JSON.stringify(label)},"hooks":[{"async":false,` +
      `"command":${JSON.stringify(command)},"timeout":${timeout},"type":"command"}]}`
    return 'sha256:' + createHash('sha256').update(identity).digest('hex')
  }

  const hookArgs = (bridge: string): string[] => {
    const events: [string, string][] = [
      ['SessionStart', 'session_start'],
      ['UserPromptSubmit', 'user_prompt_submit'],
      ['Stop', 'stop'],
    ]
    const args: string[] = []
    const state: string[] = []
    for (const [toml, label] of events) {
      args.push('-c', `hooks.${toml}=[{hooks=[{type="command",command="${bridge}",timeout=60}]}]`)
      // The state key contains dots, so it must ride as one inline table —
      // it cannot go through -c's dotted-path parser.
      state.push(`"/<session-flags>/config.toml:${label}:0:0"={trusted_hash="${trustedHash(label, bridge, 60)}"}`)
    }
    args.push('-c', `hooks.state={${state.join(',')}}`)
    return args
  }

  test('exec: injected hooks report identity + turn; exec resume reuses id and rollout', { timeout: 420_000 }, async () => {
    const cwd = makeCwd('codex')
    const bridge = writeBridge(cwd)
    const tid = `cate-term-codex-${Date.now()}`

    const eventsFile = join(cwd, 'events.jsonl')
    await run(
      'codex',
      ['exec', '--skip-git-repo-check', ...hookArgs(bridge), PROMPT],
      { cwd, env: cleanEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }), timeout: 300_000 },
    )
    const events = readJsonl<BridgeEvent>(eventsFile)
    const start = events.find((e) => e.payload.hook_event_name === 'SessionStart')?.payload
    expect(start, 'SessionStart fired — absence means the trusted_hash scheme drifted').toBeTruthy()
    expect(start?.source).toBe('startup')
    expect(start?.session_id).toMatch(UUID_RE)
    expect(start?.cwd).toBe(cwd)
    const id = start?.session_id as string
    const rollout = start?.transcript_path as string
    cleanups.push(() => rmSync(rollout, { force: true }))
    expect(events.some((e) => e.payload.hook_event_name === 'UserPromptSubmit')).toBe(true)
    expect(events.some((e) => e.payload.hook_event_name === 'Stop')).toBe(true)

    // Store join: transcript_path IS the rollout file the fallback probe
    // scans; its meta line must agree on id + cwd.
    expect(rollout).toContain(`${homedir()}/.codex/sessions/`)
    expect(rollout).toContain(id)
    expect(existsSync(rollout)).toBe(true)
    expect(FILE_STORES.codex.meta(readFileSync(rollout, 'utf8'))).toEqual({ sessionId: id, cwd })
    expectEcho(events, tid)

    // exec resume: same id, same rollout, source=resume — no fork.
    const eventsFile2 = join(cwd, 'events-resume.jsonl')
    await run(
      'codex',
      ['exec', '--skip-git-repo-check', ...hookArgs(bridge), 'resume', id, PROMPT2],
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
})

// =============================================================================
// pi — in-process extension via -e (offline: fake provider, zero cost)
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

  test('print: -e bridge streams identity + turns; --session-id pre-assigns; --session resumes', { timeout: 300_000 }, async () => {
    const cwd = makeCwd('pi')
    const bridge = join(cwd, 'cate-bridge.ts')
    const fake = join(cwd, 'fake-provider.ts')
    writeFileSync(bridge, BRIDGE_TS)
    writeFileSync(fake, FAKE_PROVIDER_TS)
    const tid = `cate-term-pi-${Date.now()}`
    const assigned = randomUUID()
    const piArgs = ['-p', '-e', bridge, '-e', fake, '--provider', 'fake', '--model', 'fake-1']

    const eventsFile = join(cwd, 'events.jsonl')
    await run('pi', [...piArgs, '--session-id', assigned, PROMPT], {
      cwd,
      env: cleanEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }),
      timeout: 120_000,
    })
    const events = readJsonl<PiEvent>(eventsFile)
    // Full lifecycle, every event stamped with the ASSIGNED session identity.
    for (const name of ['session_start', 'agent_start', 'turn_end', 'agent_end', 'session_shutdown']) {
      const hit = events.find((e) => e.event === name)
      expect(hit, `${name} fired`).toBeTruthy()
      expect(hit?.sessionId, `${name} carries the assigned session id`).toBe(assigned)
    }
    const sessionFile = events[0].sessionFile as string
    expect(sessionFile).toContain(assigned)
    cleanups.push(() => rmSync(dirname(sessionFile), { recursive: true, force: true }))

    // Store join: the event's sessionFile is the store file the fallback
    // probe scans, and its header agrees on id + cwd.
    expect(existsSync(sessionFile)).toBe(true)
    expect(FILE_STORES.pi.meta(readFileSync(sessionFile, 'utf8'))).toEqual({ sessionId: assigned, cwd })
    expectEcho(events, tid)

    // Resume via the shipped restore argv (--session <id>): same id, same file.
    const eventsFile2 = join(cwd, 'events-resume.jsonl')
    await run('pi', [...piArgs, '--session', assigned, PROMPT2], {
      cwd,
      env: cleanEnv({ CATE_EVENTS_FILE: eventsFile2, CATE_TERMINAL_ID: tid }),
      timeout: 120_000,
    })
    const resumeEvents = readJsonl<PiEvent>(eventsFile2)
    const end = resumeEvents.find((e) => e.event === 'agent_end')
    expect(end, 'agent_end fired on the resumed run').toBeTruthy()
    expect(end?.sessionId, 'resume re-attaches to the SAME session').toBe(assigned)
    expect(end?.sessionFile).toBe(sessionFile)
    expectEcho(resumeEvents, tid)
  })
})

// =============================================================================
// opencode — in-process plugin via OPENCODE_CONFIG_CONTENT env
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

  const OPENCODE_DB = join(homedir(), '.local', 'share', 'opencode', 'opencode.db')

  // The provider on this machine may 401 — the busy→idle lifecycle and the
  // session row are emitted regardless (verified), so a failed completion
  // must NOT fail the contract. Never assert on exit code or reply text.
  const runTolerant = async (args: string[], cwd: string, env: Record<string, string>): Promise<void> => {
    await run('opencode', args, { cwd, env, timeout: 180_000 }).catch(() => {})
  }

  test('run: env-injected plugin streams sessionID + busy/idle; --session resumes', { timeout: 420_000 }, async () => {
    const cwd = makeCwd('opencode')
    const plugin = join(cwd, 'cate-plugin.mjs')
    writeFileSync(plugin, PLUGIN_JS)
    const tid = `cate-term-opencode-${Date.now()}`
    const env = (eventsFile: string): Record<string, string> =>
      cleanEnv({
        CATE_EVENTS_FILE: eventsFile,
        CATE_TERMINAL_ID: tid,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [`file://${plugin}`] }),
        // The autoupdate modal steals keystrokes and self-updates — never
        // spawn opencode without this.
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      })

    const eventsFile = join(cwd, 'events.jsonl')
    await runTolerant(['run', PROMPT], cwd, env(eventsFile))
    const events = readJsonl<OcEvent>(eventsFile)
    expect(events.some((e) => e.type === 'plugin.init'), 'plugin injected via env').toBe(true)
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

    // Store join: the fallback probe's sqlite lookup resolves the same id.
    // The row's WAL commit can trail process exit by a moment — poll briefly.
    let stored = await newestOpencodeSessionFor(OPENCODE_DB, cwd)
    const deadline = Date.now() + 15_000
    while (stored !== id && Date.now() < deadline) {
      await sleep(500)
      stored = await newestOpencodeSessionFor(OPENCODE_DB, cwd)
    }
    expect(stored, 'fallback probe resolves the hook-reported id').toBe(id)

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
})

// =============================================================================
// cursor — hooks.json in the (throwaway) project cwd
// =============================================================================

describe.skipIf(!LIVE || !hasBin('cursor-agent'))('cursor hook contract', () => {
  const CURSOR_CHATS = join(homedir(), '.cursor', 'chats')

  const writeHooksJson = (cwd: string, bridge: string): void => {
    mkdirSync(join(cwd, '.cursor'), { recursive: true })
    writeFileSync(
      join(cwd, '.cursor', 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: Object.fromEntries(
          ['sessionStart', 'beforeSubmitPrompt', 'stop', 'afterAgentResponse', 'sessionEnd'].map(
            (e) => [e, [{ command: bridge }]],
          ),
        ),
      }),
    )
  }

  const byName = (events: BridgeEvent[], name: string): BridgeEvent[] =>
    events.filter((e) => e.payload.hook_event_name === name)

  test('TUI: hooks stream conversation_id + stop; print --resume re-attaches', { retry: 1, timeout: 420_000 }, async () => {
    const cwd = makeCwd('cursor')
    const eventsFile = join(cwd, 'events.jsonl')
    const bridge = writeBridge(cwd)
    writeHooksJson(cwd, bridge)
    const tid = `cate-term-cursor-${Date.now()}`
    const env = cleanEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid })
    const events = (): BridgeEvent[] => readJsonl<BridgeEvent>(eventsFile)
    // The whole md5(cwd) chats dir belongs to this throwaway cwd.
    cleanups.push(() =>
      rmSync(join(CURSOR_CHATS, createHash('md5').update(cwd).digest('hex')), { recursive: true, force: true }),
    )

    const tui = await driveTui('cursor-agent', [], cwd, env)
    await tui.waitFor(() => byName(events(), 'sessionStart').length > 0, 90_000, 'sessionStart')
    const start = byName(events(), 'sessionStart')[0].payload
    expect(start.conversation_id).toMatch(UUID_RE)
    const id = start.conversation_id as string

    // beforeSubmitPrompt and stop fire in the TUI ONLY — print mode never
    // emits them; if that changes, Cate can simplify to print-mode probing.
    await tui.send(PROMPT)
    await tui.waitFor(() => byName(events(), 'beforeSubmitPrompt').length > 0, 120_000, 'beforeSubmitPrompt')
    expect(byName(events(), 'beforeSubmitPrompt')[0].payload.conversation_id).toBe(id)
    await tui.waitFor(() => byName(events(), 'stop').length > 0, 180_000, 'stop (turn end)')
    const stop = byName(events(), 'stop')[0].payload
    expect(stop.conversation_id).toBe(id)
    expect(stop.status, 'stop carries turn status').toBeTruthy()

    // Store join: the fallback probe's chats-dir lookup resolves the same id.
    expect(await newestCursorSessionFor(CURSOR_CHATS, cwd)).toBe(id)
    expectEcho(events(), tid)
    tui.kill()

    // Print-mode resume re-attaches: sessionStart does NOT fire on resume, so
    // the id must come from sessionEnd (or any turn event) — exactly what
    // Cate's tracker has to key on.
    const eventsFile2 = join(cwd, 'events-resume.jsonl')
    await run('cursor-agent', ['-p', '--trust', '--resume', id, PROMPT2], {
      cwd,
      env: cleanEnv({ CATE_EVENTS_FILE: eventsFile2, CATE_TERMINAL_ID: tid }),
      timeout: 240_000,
    })
    const resumeEvents = readJsonl<BridgeEvent>(eventsFile2)
    const end = byName(resumeEvents, 'sessionEnd')[0]?.payload
    expect(end?.conversation_id, 'resumed run reports the SAME conversation').toBe(id)
    expectEcho(resumeEvents, tid)
  })

  test('create-chat pre-assigns an id that --resume attaches to', { timeout: 300_000 }, async () => {
    const cwd = makeCwd('cursor-create')
    const eventsFile = join(cwd, 'events.jsonl')
    const bridge = writeBridge(cwd)
    writeHooksJson(cwd, bridge)
    const tid = `cate-term-cursor-c-${Date.now()}`
    cleanups.push(() =>
      rmSync(join(CURSOR_CHATS, createHash('md5').update(cwd).digest('hex')), { recursive: true, force: true }),
    )

    const { stdout } = await run('cursor-agent', ['create-chat'], { cwd, env: cleanEnv(), timeout: 60_000 })
    const chatId = stdout.trim().match(UUID_RE)?.[0]
    expect(chatId, 'create-chat prints a chat id').toBeTruthy()

    await run('cursor-agent', ['-p', '--trust', '--resume', chatId as string, PROMPT], {
      cwd,
      env: cleanEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid }),
      timeout: 240_000,
    })
    const events = readJsonl<BridgeEvent>(eventsFile)
    expect(
      events.some((e) => e.payload.conversation_id === chatId),
      'hooks report the pre-created chat id',
    ).toBe(true)
    expect(existsSync(join(CURSOR_CHATS, createHash('md5').update(cwd).digest('hex'), chatId as string))).toBe(true)
  })
})

// =============================================================================
// agy — .agents/hooks.json in the (throwaway) cwd, trust pre-seeded
// =============================================================================

describe.skipIf(!LIVE || !hasBin('agy'))('agy hook contract', () => {
  const AGY_DIR = join(homedir(), '.gemini', 'antigravity-cli')

  // agy's trust gate persists in settings.json:trustedWorkspaces — seeding the
  // throwaway cwd there before launch skips the interactive prompt entirely.
  // The entry is removed again in cleanup.
  const trustWorkspace = (cwd: string): void => {
    const settingsPath = join(AGY_DIR, 'settings.json')
    let settings: { trustedWorkspaces?: string[] } = {}
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    } catch { /* fresh install */ }
    const list = (settings.trustedWorkspaces ??= [])
    if (!list.includes(cwd)) list.push(cwd)
    mkdirSync(AGY_DIR, { recursive: true })
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
    cleanups.push(() => {
      const s = JSON.parse(readFileSync(settingsPath, 'utf8'))
      s.trustedWorkspaces = (s.trustedWorkspaces ?? []).filter((w: string) => w !== cwd)
      writeFileSync(settingsPath, JSON.stringify(s, null, 2))
    })
  }

  // agy-specific schema: named hook → event → flat handler list. Only
  // PreInvocation/Stop — an observing PreToolUse that doesn't answer
  // {"decision":"allow"} DENIES the tool call.
  const writeHooksJson = (cwd: string, bridge: string): void => {
    mkdirSync(join(cwd, '.agents'), { recursive: true })
    writeFileSync(
      join(cwd, '.agents', 'hooks.json'),
      JSON.stringify({
        'cate-bridge': {
          PreInvocation: [{ type: 'command', command: bridge, timeout: 30 }],
          Stop: [{ type: 'command', command: bridge, timeout: 30 }],
        },
      }),
    )
  }

  test('TUI: hooks stream conversationId + Stop; --conversation resumes', { retry: 1, timeout: 420_000 }, async () => {
    const cwd = makeCwd('agy')
    const eventsFile = join(cwd, 'events.jsonl')
    const bridge = writeBridge(cwd)
    writeHooksJson(cwd, bridge)
    trustWorkspace(cwd)
    const tid = `cate-term-agy-${Date.now()}`
    const env = cleanEnv({ CATE_EVENTS_FILE: eventsFile, CATE_TERMINAL_ID: tid })
    const events = (): BridgeEvent[] => readJsonl<BridgeEvent>(eventsFile)

    // Hooks fire in interactive mode ONLY (verified: never in -p) — so this
    // contract is pinned through a live TUI, both launch and resume.
    const tui = await driveTui('agy', [], cwd, env)
    await tui.waitFor(() => tui.peek().length > 0, 60_000, 'agy first paint')
    await tui.settle(6_000)
    await tui.send(PROMPT)
    await tui.waitFor(
      () => events().some((e) => typeof e.payload.conversationId === 'string'),
      180_000,
      'first hook event with conversationId',
    )
    const id = events().find((e) => typeof e.payload.conversationId === 'string')?.payload.conversationId as string
    expect(id).toMatch(UUID_RE)
    cleanups.push(() => {
      rmSync(join(AGY_DIR, 'conversations', `${id}.db`), { force: true })
      rmSync(join(AGY_DIR, 'conversations', `${id}.pb`), { force: true })
      rmSync(join(AGY_DIR, 'brain', id), { recursive: true, force: true })
    })

    // Stop = turn end, same conversation.
    await tui.waitFor(
      () => events().some((e) => e.payload.terminationReason !== undefined),
      180_000,
      'Stop event (terminationReason)',
    )
    expect(events().find((e) => e.payload.terminationReason !== undefined)?.payload.conversationId).toBe(id)

    // Store join: the conversationId IS the resume handle and the .db name.
    await until(
      () => existsSync(join(AGY_DIR, 'conversations', `${id}.db`)) || existsSync(join(AGY_DIR, 'conversations', `${id}.pb`)),
      60_000,
      'conversation store file',
    )
    expectEcho(events(), tid)
    tui.kill()

    // Resume: `agy --conversation=<id>` re-attaches — hooks report the same id.
    const eventsFile2 = join(cwd, 'events-resume.jsonl')
    const env2 = cleanEnv({ CATE_EVENTS_FILE: eventsFile2, CATE_TERMINAL_ID: tid })
    const resumeEvents = (): BridgeEvent[] => readJsonl<BridgeEvent>(eventsFile2)
    const tui2 = await driveTui('agy', [`--conversation=${id}`], cwd, env2)
    await tui2.waitFor(() => tui2.peek().length > 0, 60_000, 'agy resume paint')
    await tui2.settle(6_000)
    await tui2.send(PROMPT2)
    await tui2.waitFor(
      () => resumeEvents().some((e) => typeof e.payload.conversationId === 'string'),
      180_000,
      'hook event on the resumed conversation',
    )
    expect(
      resumeEvents().find((e) => typeof e.payload.conversationId === 'string')?.payload.conversationId,
      'resume re-attaches to the SAME conversation',
    ).toBe(id)
    expectEcho(resumeEvents(), tid)
    tui2.kill()
  })
})
