// =============================================================================
// Agent hooks capability — the daemon-side mechanism that turns the per-agent
// declarations in src/shared/agentHooks.ts into a live push event stream:
//
//   1. materialize a STABLE per-user hooks dir (~/.cate/agent-hooks — same
//      convention as the extensions root): the stdin→HTTP bridge, per-agent
//      bridge wrappers. Stable on purpose: the bridge paths are embedded in
//      repo-scoped hook files (.codex/hooks.json,
//      .claude/settings.local.json), where a per-boot
//      path would rewrite user repos every boot and re-trigger codex's
//      "modified since last trusted" hook review on every restart. Contents
//      are regenerated on every boot; stale files are harmless.
//   2. plant the hook env on every PTY (endpoint + per-terminal derived token
//      + CATE_TERMINAL_ID — the terminal↔event correlation contract);
//   3. prepare workspace-scoped hook files (claude, codex, cursor, grok, pi,
//      opencode) at PTY create time;
//   4. ingest hook posts on a daemon-owned loopback HTTP endpoint, normalize
//      them (shared code), and emit AgentHookEvents to subscribers (the
//      rpcServer forwards them to the client as evt frames).
//
// Transport choice: loopback HTTP with a PER-TERMINAL bearer token
// (HMAC-SHA256 of the pty id under a per-boot secret, validated against the
// terminalId each post claims — so a process inside one terminal cannot forge
// events for another). Hook handlers always run on the daemon's own host
// (they are children of PTYs this daemon spawned), so loopback suffices even
// for remote workspaces — the daemon ingests locally and the normalized
// events ride the existing LF-JSON pipe to the app. HTTP over a unix socket
// was rejected because the in-process injections (the pi extension, the
// opencode plugin) post with plain `fetch`, which cannot target a unix socket
// without extra dependencies. Both are workspace files the CLI discovers on
// its own (<cwd>/.pi/extensions/*.ts, <cwd>/.opencode/plugin/*.js).
//
// Bridge choice: a tiny wrapper (sh script on POSIX, .cmd on win32) running
// the daemon's OWN node binary (process.execPath) on a daemon-written JS
// file. Node is NOT guaranteed on the user's PATH, but the daemon is always a
// working node on this host; the bundled `cate` CLI was rejected as the
// bridge because it is absent in dev/direct mode and its runtime is gated on
// the CATE_API setting.
//
// Electron-free; runs on every platform (the wrapper flavor is the only
// platform-specific piece).
// =============================================================================

import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import http from 'http'
import os from 'os'
import path from 'path'
import { chmod, mkdir, open, readFile, stat, unlink, writeFile } from 'fs/promises'
import { AGENTS, type AgentId } from '../../shared/agents'
import {
  AGENT_HOOK_SPECS,
  CATE_HOOK_MARKER,
  CATE_HOOK_ENDPOINT_ENV,
  CATE_HOOK_TOKEN_ENV,
  CATE_TERMINAL_ID_ENV,
  agentHookFolder,
  normalizeAgentHookPayload,
  resolveAgentHookMode,
  type AgentHookAgentState,
  type AgentHookConfig,
  type AgentHookEvent,
  type HookInjectionContext,
} from '../../shared/agentHooks'

const MAX_BODY_BYTES = 512 * 1024

export interface AgentHooksCapability {
  /** The full spawn env for a PTY: hook endpoint + this terminal's derived
   *  token + CATE_TERMINAL_ID=ptyId. Agent-agnostic (the per-agent tri-state
   *  is enforced by prepareWorkspace, the only injection channel) and repo-free,
   *  so it is planted unconditionally: a hook file that was never written
   *  simply never reads it. Lazily boots the ingestion endpoint + hooks dir on
   *  first use; returns `env` unchanged when hook setup fails (a plain shell is
   *  always spawnable). */
  envForPty(ptyId: string, env: Record<string, string>): Promise<Record<string, string>>
  /** Write (or, for 'off', remove) workspace-scoped hook files for the PTY's
   *  cwd and keep the ones we wrote out of git status via .git/info/exclude.
   *  `config` carries per-agent tri-state overrides: 'auto' (default) injects
   *  only when the agent's own config folder already exists in the repo, 'on'
   *  always injects, 'off' strips any entries Cate previously wrote.
   *  Best-effort and idempotent; never touches the user's home dir (~/.codex,
   *  ~/.claude etc. are the CLIs' USER-GLOBAL config dirs — injection stays
   *  repo-local). */
  prepareWorkspace(cwd: string, config?: AgentHookConfig): Promise<void>
  /** Inspect a workspace's per-agent hook-file injection state (for the
   *  Settings UI): which agents write repo files, whether each one's config
   *  folder is already in the repo (the 'auto' signal), and whether Cate has
   *  injected there. Read-only; runs on the host that owns the workspace. */
  inspectWorkspace(cwd: string): Promise<AgentHookAgentState[]>
  /** Subscribe to normalized hook events. Returns an unsubscribe. */
  subscribe(onEvent: (event: AgentHookEvent) => void): () => void
  /** The ingestion endpoint (boots it if needed) — for tests/diagnostics.
   *  `tokenFor` derives the bearer token a given terminal's posts must carry. */
  endpoint(): Promise<{ url: string; dir: string; tokenFor: (terminalId: string) => string }>
  /** Close the ingestion endpoint. The stable hooks dir is left in place —
   *  repo hook files embed its bridge paths, which must survive restarts. */
  dispose(): void
}

export interface AgentHooksDeps {
  /** Override the stable hooks dir (tests). Default: ~/.cate/agent-hooks. */
  hooksDir?: string
  /** Poll cadence (ms) of the interrupt transcript tail-watch. Default 600 —
   *  well under the "a moment after the user hit Esc" tolerance, and it only
   *  ticks while a false-on-interrupt turn is actually in flight. Tests lower
   *  it for speed. */
  interruptPollMs?: number
  /** Called on every AUTHENTICATED post for a known agent — including ones
   *  whose payload normalizes to null — with the poster's lineage claim
   *  (`pid`: the bridge's parent / the in-process agent itself; undefined
   *  when the poster didn't send one). AWAITED before the HTTP response goes
   *  out: the presence tracker's ancestry walk needs the bridge's process
   *  chain alive, and the bridge holds it exactly until it hears back. */
  onPost?: (post: { terminalId: string; agentId: AgentId; pid?: number }) => void | Promise<void>
}

interface HookState {
  dir: string
  url: string
  /** Per-boot secret the per-terminal bearer tokens derive from. */
  secret: string
  server: http.Server
  /** Per-agent injection context (the bridge wrapper path). */
  contexts: Map<AgentId, HookInjectionContext>
}

/** The bearer token a terminal's hook posts must carry: HMAC-SHA256 of the
 *  pty id under the per-boot secret. Binding the token to the terminal id
 *  means a process can only post events for ITS OWN terminal — reading the
 *  env of one PTY yields nothing that spoofs another. */
export function hookTokenForTerminal(secret: string, terminalId: string): string {
  return createHmac('sha256', secret).update(terminalId).digest('hex')
}

/** Whether `cwd` is a place we may plant repo-local hook files: an absolute
 *  path that is NOT the user's home dir (~/.claude, ~/.codex etc. are the
 *  CLIs' USER-GLOBAL config dirs — off-limits) and not empty/relative (which
 *  would resolve against the daemon's own cwd). */
export function isRepoLocalCwd(cwd: string, home: string): boolean {
  return !!cwd && path.isAbsolute(cwd) && !!home && path.resolve(cwd) !== path.resolve(home)
}

/** True iff `dir` exists and is a directory — the 'auto' injection gate (an
 *  agent's repo-local config folder present means that agent is in use here). */
async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** The generic stdin→HTTP bridge all stdin-JSON CLIs share (claude, codex).
 *  No stdout on purpose: every CLI accepts silent exit-0. Always exits 0 — a
 *  hook failure must never surface into the user's agent turn. */
const BRIDGE_JS = `// Generated by the Cate runtime daemon (agent hook injection). Do not edit.
'use strict'
const http = require('http')
const agentId = process.argv[2] || ''
let data = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { data += c })
process.stdin.on('end', () => {
  const endpoint = process.env.${CATE_HOOK_ENDPOINT_ENV}
  const token = process.env.${CATE_HOOK_TOKEN_ENV}
  if (!endpoint || !token || !agentId) process.exit(0)
  // Cross-vendor guard. grok scans OTHER CLIs' hook files (.claude/settings
  // .local.json, .cursor/hooks.json) by default, so a grok session also spawns
  // the wrapper we injected for claude — with a grok payload. GROK_HOOK_EVENT
  // is a RESERVED var grok's hook runner injects into every hook process it
  // spawns (and strips from user-supplied env), so its presence is a
  // deterministic "grok ran me", not a heuristic: drop the post unless the
  // wrapper's baked-in agent id agrees. The grok-native wrapper still reports
  // the event, so nothing is lost.
  if (!!process.env.GROK_HOOK_EVENT !== (agentId === 'grok')) process.exit(0)
  let payload
  try { payload = JSON.parse(data) } catch { payload = { raw: data } }
  // pid: the bridge's PARENT — the agent CLI (or its sh hook-command layer),
  // never the bridge itself. The daemon walks the ancestry from here to find
  // the agent process for liveness tracking.
  const body = JSON.stringify({ agentId, terminalId: process.env.${CATE_TERMINAL_ID_ENV} || null, pid: process.ppid, payload })
  const req = http.request(endpoint + '/hook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'content-length': Buffer.byteLength(body) },
    timeout: 3000,
  }, (res) => { res.resume(); res.on('end', () => process.exit(0)) })
  req.on('timeout', () => { req.destroy(); process.exit(0) })
  req.on('error', () => process.exit(0))
  req.end(body)
})
// Hard cap so a wedged pipe can never hold the CLI's hook slot open.
setTimeout(() => process.exit(0), 10000)
`

export function createAgentHooksCapability(deps: AgentHooksDeps = {}): AgentHooksCapability {
  const listeners = new Set<(event: AgentHookEvent) => void>()
  let ready: Promise<HookState> | null = null
  let disposed = false

  const emit = (event: AgentHookEvent): void => {
    for (const cb of listeners) {
      try { cb(event) } catch { /* a subscriber must not break ingestion */ }
    }
  }

  // -------------------------------------------------------------------------
  // Interrupt recovery — the compensating channel for the CLIs that push NO
  // hook on a user interrupt (claude, codex; see AgentHookSpec.interruptRecovery
  // in shared/agentHooks.ts). While such an agent's turn is in flight we tail
  // its transcript; the instant its interrupt MARKER lands we synthesize the
  // turn-end the CLI never pushed, so the FSM idles just like it does for the
  // self-healing agents. Deterministic and file-based on purpose: no keystroke
  // sniffing, no screen scraping, no settle timer that GUESSES idle from
  // silence — this fires only on a definite marker in the transcript.
  // -------------------------------------------------------------------------
  interface InterruptWatch {
    agentId: AgentId
    sessionId: string | null
    cwd?: string
    transcriptPath: string
    marker: RegExp
    /** Transcript size at turn-start. Only bytes appended after it belong to
     *  the aborted turn, so a marker from an EARLIER turn in the same file is
     *  never re-detected. */
    baseline: number
  }
  const interruptWatches = new Map<string, InterruptWatch>()
  let interruptTimer: ReturnType<typeof setInterval> | null = null
  const INTERRUPT_TAIL_BYTES = 64 * 1024

  const fileSize = async (file: string): Promise<number> => {
    try { return (await stat(file)).size } catch { return 0 }
  }

  /** Read at most the last INTERRUPT_TAIL_BYTES of `file`, never before `from`.
   *  The marker is the last thing the CLI writes on abort, so a bounded tail
   *  read catches it however large the turn's output was. */
  const readTail = async (file: string, from: number): Promise<string> => {
    let fh: Awaited<ReturnType<typeof open>>
    try { fh = await open(file, 'r') } catch { return '' }
    try {
      const { size } = await fh.stat()
      const start = Math.max(from, size - INTERRUPT_TAIL_BYTES, 0)
      const len = size - start
      if (len <= 0) return ''
      const buf = Buffer.allocUnsafe(len)
      await fh.read(buf, 0, len, start)
      return buf.toString('utf8')
    } catch {
      return ''
    } finally {
      try { await fh.close() } catch { /* already gone */ }
    }
  }

  const stopInterruptTimerIfIdle = (): void => {
    if (interruptWatches.size === 0 && interruptTimer) {
      clearInterval(interruptTimer)
      interruptTimer = null
    }
  }

  const scanInterruptWatches = async (): Promise<void> => {
    for (const [terminalId, w] of [...interruptWatches]) {
      const tail = await readTail(w.transcriptPath, w.baseline)
      if (!tail || !w.marker.test(tail)) continue
      // Interrupted: the CLI pushed no hook, so emit the turn-end its
      // transcript now proves. sessionId/cwd carry through from turn-start so
      // the session-stamp tracker re-stamps the same (correct) session; the
      // raw marker lets a consumer tell this apart from a real hook turn-end.
      interruptWatches.delete(terminalId)
      emit({
        terminalId,
        agentId: w.agentId,
        kind: 'turn-end',
        sessionId: w.sessionId,
        cwd: w.cwd,
        transcriptPath: w.transcriptPath,
        raw: { __cateInterruptRecovery: true },
      })
    }
    stopInterruptTimerIfIdle()
  }

  const ensureInterruptTimer = (): void => {
    if (interruptTimer || disposed) return
    interruptTimer = setInterval(() => { void scanInterruptWatches() }, deps.interruptPollMs ?? 600)
    interruptTimer.unref?.()
  }

  /** Arm/disarm the transcript watch off the normalized event stream. A
   *  turn-start for a false-on-interrupt agent arms it (baselined at the
   *  current transcript size); a real turn-end/session-end disarms it (the
   *  turn ended through a hook — no recovery needed). turn-resume and
   *  permission-wait leave it armed: the turn is still in flight and still
   *  interruptible. */
  const updateInterruptWatch = async (event: AgentHookEvent): Promise<void> => {
    const rec = AGENT_HOOK_SPECS[event.agentId]?.interruptRecovery
    if (!rec) return
    switch (event.kind) {
      case 'turn-start':
        if (!event.transcriptPath) return
        interruptWatches.set(event.terminalId, {
          agentId: event.agentId,
          sessionId: event.sessionId,
          cwd: event.cwd,
          transcriptPath: event.transcriptPath,
          marker: rec.marker,
          baseline: await fileSize(event.transcriptPath),
        })
        ensureInterruptTimer()
        break
      case 'turn-end':
      case 'session-end':
        interruptWatches.delete(event.terminalId)
        stopInterruptTimerIfIdle()
        break
    }
  }

  /** Constant-time check of the presented bearer against the terminal's
   *  derived token. Length equality is checked first (timingSafeEqual throws
   *  on mismatched lengths; the expected length is public anyway). */
  const tokenMatches = (authorization: string | undefined, secret: string, terminalId: string): boolean => {
    if (!authorization?.startsWith('Bearer ')) return false
    const presented = Buffer.from(authorization.slice('Bearer '.length))
    const expected = Buffer.from(hookTokenForTerminal(secret, terminalId))
    return presented.length === expected.length && timingSafeEqual(presented, expected)
  }

  const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse, secret: string): void => {
    if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) { req.destroy(); return }
      chunks.push(c)
    })
    req.on('error', () => { /* client vanished mid-post */ })
    req.on('end', () => {
      void (async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            agentId?: unknown
            terminalId?: unknown
            pid?: unknown
            payload?: unknown
          }
          if (
            typeof body.agentId === 'string' &&
            typeof body.terminalId === 'string' &&
            body.terminalId &&
            typeof body.payload === 'object' &&
            body.payload !== null
          ) {
            // The token is PER TERMINAL (HMAC of the claimed terminalId), so it
            // can only be validated after the body names the terminal. A forged
            // terminalId fails here: its token lives only in that pty's env.
            if (!tokenMatches(req.headers.authorization, secret, body.terminalId)) {
              res.statusCode = 401
              res.end()
              return
            }
            // Presence lineage: every authenticated post from a known agent
            // counts, even one whose payload normalizes to null — the post
            // itself proves the agent is alive. Awaited BEFORE responding so
            // the bridge keeps its ancestry chain alive through the walk.
            if (deps.onPost && body.agentId in AGENT_HOOK_SPECS) {
              try {
                await deps.onPost({
                  terminalId: body.terminalId,
                  agentId: body.agentId as AgentId,
                  pid: typeof body.pid === 'number' ? body.pid : undefined,
                })
              } catch { /* presence tracking must never fail the hook */ }
            }
            const event = normalizeAgentHookPayload(body.agentId, body.terminalId, body.payload as Record<string, unknown>)
            if (event) {
              emit(event)
              // Awaited (a cheap local stat) so the watch is armed by the time
              // the bridge's post resolves — no window where the interrupt
              // marker could land before the baseline is taken.
              await updateInterruptWatch(event)
            }
          }
          res.statusCode = 204
          res.end()
        } catch {
          res.statusCode = 400
          res.end()
        }
      })()
    })
  }

  /** One-time (lazy) setup: hooks dir + bridge + wrappers + endpoint.
   *  Lazy so a daemon that never spawns a terminal binds no port. The dir is
   *  a STABLE per-user location (not a per-boot mkdtemp): its bridge paths
   *  are embedded in repo-scoped hook files, and codex keys its persisted
   *  hook trust on them — a churning path would rewrite user repos and
   *  re-prompt "modified since last trusted" on every restart. Contents are
   *  still (re)written on every boot; a partially-built dir left by a failed
   *  setup is harmless and overwritten by the retry. */
  const ensureReady = (): Promise<HookState> => {
    if (ready) return ready
    ready = buildState(deps.hooksDir ?? path.join(os.homedir(), '.cate', 'agent-hooks'))
    // A failed setup must not wedge every later PTY create on the same
    // rejection — reset so the next create retries.
    ready.catch(() => { ready = null })
    return ready
  }

  /** Populate the stable hooks dir and bind the ingestion endpoint. */
  const buildState = async (dir: string): Promise<HookState> => {
    await mkdir(dir, { recursive: true })

    const bridgeJs = path.join(dir, 'cate-hook-bridge.js')
    await writeFile(bridgeJs, BRIDGE_JS)

    const secret = randomBytes(32).toString('hex')
    const contexts = new Map<AgentId, HookInjectionContext>()

    for (const agent of AGENTS) {
      // Per-agent bridge wrapper: hook configs get ONE command path with no
      // args (codex runs the command string directly), so the agent id rides
      // as a baked-in argv of the wrapper. sh script on POSIX, .cmd on win32.
      // NOTE: the wrapper CONTENT embeds this daemon's node (process.execPath)
      // and is rewritten every boot — two daemons sharing this dir (dev build
      // + packaged app) flip-flop it between their node paths. Benign: both
      // are working node binaries, and codex's hook trust keys on the wrapper
      // PATH (via hooks.json), which never changes.
      const wrapper = path.join(dir, `cate-hook-bridge-${agent.id}${process.platform === 'win32' ? '.cmd' : ''}`)
      if (process.platform === 'win32') {
        await writeFile(wrapper, `@echo off\r\n"${process.execPath}" "${bridgeJs}" "${agent.id}" %*\r\n`)
      } else {
        await writeFile(wrapper, `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(bridgeJs)} ${shQuote(agent.id)} "$@"\n`)
        await chmod(wrapper, 0o755)
      }

      contexts.set(agent.id, { bridgeCommand: wrapper })
    }

    const server = http.createServer((req, res) => handleRequest(req, res, secret))
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    })
    server.unref()
    return { dir, url: `http://127.0.0.1:${port}`, secret, server, contexts }
  }

  return {
    async envForPty(ptyId, env) {
      if (disposed) return env
      let state: HookState
      try {
        state = await ensureReady()
      } catch {
        return env // hook setup failed — spawn a plain shell
      }
      const out = { ...env }
      out[CATE_HOOK_ENDPOINT_ENV] = state.url
      out[CATE_HOOK_TOKEN_ENV] = hookTokenForTerminal(state.secret, ptyId)
      out[CATE_TERMINAL_ID_ENV] = ptyId
      return out
    },

    async prepareWorkspace(cwd, config) {
      if (disposed) return
      // Never plant (or strip) agent files in the user's home dir or against a
      // non-absolute cwd — see isRepoLocalCwd.
      if (!isRepoLocalCwd(cwd, os.homedir())) return
      let state: HookState
      try {
        state = await ensureReady()
      } catch {
        return
      }
      const excludeRels: string[] = []
      for (const agent of AGENTS) {
        const spec = AGENT_HOOK_SPECS[agent.id]
        if (!spec.projectFiles) continue
        const mode = resolveAgentHookMode(config, agent.id)
        // 'off': reclaim anything we previously injected, then move on.
        if (mode === 'off') {
          for (const pf of spec.projectFiles) {
            const filePath = path.join(cwd, pf.relPath)
            let existing: string
            try {
              existing = await readFile(filePath, 'utf-8')
            } catch { continue /* absent — nothing to strip */ }
            try {
              const res = pf.strip?.(existing)
              if (res && 'delete' in res) await unlink(filePath)
              else if (res && 'content' in res && res.content !== existing) await writeFile(filePath, res.content)
            } catch { /* best-effort — never block the terminal spawn */ }
          }
          continue
        }
        // 'auto': inject only when the agent's config folder is already in the
        // repo (a "used here" signal). 'on': always inject.
        if (mode === 'auto') {
          const folder = agentHookFolder(agent.id)
          if (folder && !(await dirExists(path.join(cwd, folder)))) continue
        }
        const ctx = state.contexts.get(agent.id)!
        for (const pf of spec.projectFiles) {
          const filePath = path.join(cwd, pf.relPath)
          let existing: string | null = null
          try {
            existing = await readFile(filePath, 'utf-8')
          } catch { /* absent */ }
          let wrote = false
          try {
            const next = pf.build(existing, ctx)
            if (next !== null) {
              await mkdir(path.dirname(filePath), { recursive: true })
              await writeFile(filePath, next)
              wrote = true
            }
          } catch { /* best-effort — never block the terminal spawn */ }
          // Keep OUR file out of git status; a purely-user file we left alone
          // is not ours to hide.
          if (wrote || existing?.includes(CATE_HOOK_MARKER)) excludeRels.push(pf.relPath)
        }
      }
      if (excludeRels.length > 0) await ensureGitExcluded(cwd, excludeRels)
    },

    async inspectWorkspace(cwd) {
      const repoLocal = isRepoLocalCwd(cwd, os.homedir())
      const states: AgentHookAgentState[] = []
      for (const agent of AGENTS) {
        const spec = AGENT_HOOK_SPECS[agent.id]
        let folderPresent = false
        let injected = false
        // Only touch the filesystem for a real repo cwd (never ~ or a relative
        // path — same policy as prepareWorkspace).
        if (repoLocal) {
          const folder = agentHookFolder(agent.id)
          folderPresent = folder ? await dirExists(path.join(cwd, folder)) : false
          for (const pf of spec.projectFiles ?? []) {
            try {
              const content = await readFile(path.join(cwd, pf.relPath), 'utf-8')
              if (content.includes(CATE_HOOK_MARKER)) {
                injected = true
                break
              }
            } catch { /* absent — not injected via this path */ }
          }
        }
        states.push({ agentId: agent.id, displayName: agent.displayName, folderPresent, injected })
      }
      return states
    },

    subscribe(onEvent) {
      listeners.add(onEvent)
      return () => { listeners.delete(onEvent) }
    },

    async endpoint() {
      const state = await ensureReady()
      return {
        url: state.url,
        dir: state.dir,
        tokenFor: (terminalId: string) => hookTokenForTerminal(state.secret, terminalId),
      }
    },

    dispose() {
      disposed = true
      listeners.clear()
      interruptWatches.clear()
      if (interruptTimer) {
        clearInterval(interruptTimer)
        interruptTimer = null
      }
      const pending = ready
      ready = null
      // The stable hooks dir is deliberately NOT removed: repo hook files
      // embed its bridge paths, which must stay valid across restarts.
      if (pending) {
        void pending.then((state) => { state.server.close() }).catch(() => {})
      }
    },
  }
}

/**
 * Add `/<rel>` anchors for the hook files to the repo's .git/info/exclude
 * (NEVER .gitignore — user repos stay byte-identical). Handles worktrees: a
 * `.git` FILE points at .git/worktrees/<name>, whose `commondir` locates the
 * shared git dir where info/exclude lives. Best-effort throughout — on any
 * failure the hook files merely show up as untracked.
 */
export async function ensureGitExcluded(cwd: string, relPaths: string[]): Promise<void> {
  try {
    // Find the enclosing repo root (the dir holding `.git`).
    let repoRoot: string | null = null
    let dotGit: string | null = null
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, '.git')
      try {
        await stat(candidate)
        repoRoot = dir
        dotGit = candidate
        break
      } catch { /* keep walking up */ }
      if (dir === path.dirname(dir)) return // hit fs root — not a repo
    }
    // Resolve the git dir: a directory, or a worktree's `gitdir:` pointer file
    // (then its commondir for the shared info/ dir).
    let gitDir = dotGit!
    if ((await stat(dotGit!)).isFile()) {
      const m = (await readFile(dotGit!, 'utf-8')).match(/^gitdir:\s*(.+)\s*$/m)
      if (!m) return
      gitDir = path.resolve(repoRoot!, m[1].trim())
    }
    try {
      const common = (await readFile(path.join(gitDir, 'commondir'), 'utf-8')).trim()
      gitDir = path.resolve(gitDir, common)
    } catch { /* no commondir — gitDir IS the common dir */ }

    const excludePath = path.join(gitDir, 'info', 'exclude')
    let existing = ''
    try {
      existing = await readFile(excludePath, 'utf-8')
    } catch { /* absent — created below */ }
    const lines = relPaths
      .map((rel) => '/' + path.relative(repoRoot!, path.join(cwd, rel)).split(path.sep).join('/'))
      .filter((line) => !line.startsWith('/..')) // cwd outside the repo — never write a bogus anchor
      .filter((line) => !existing.split('\n').includes(line))
    if (lines.length === 0) return
    await mkdir(path.dirname(excludePath), { recursive: true })
    const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
    await writeFile(excludePath, existing + sep + lines.join('\n') + '\n')
  } catch { /* best-effort */ }
}
