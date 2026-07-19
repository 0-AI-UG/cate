// =============================================================================
// Agent hooks capability — the daemon-side mechanism that turns the per-agent
// declarations in src/shared/agentHooks.ts into a live push event stream:
//
//   1. materialize a STABLE per-user hooks dir (~/.cate/agent-hooks — same
//      convention as the extensions root): the stdin→HTTP bridge, per-agent
//      bridge wrappers, and the opencode in-process support file. Stable on
//      purpose: the bridge paths are embedded in repo-scoped hook files
//      (.codex/hooks.json, .claude/settings.local.json), where a per-boot
//      path would rewrite user repos every boot and re-trigger codex's
//      "modified since last trusted" hook review on every restart. Contents
//      are regenerated on every boot; stale files are harmless.
//   2. plant the hook env on every PTY (endpoint + per-boot token +
//      CATE_TERMINAL_ID — the terminal↔event correlation contract — plus the
//      opencode ambient config);
//   3. prepare workspace-scoped hook files (claude, codex, pi) at PTY create
//      time;
//   4. ingest hook posts on a daemon-owned loopback HTTP endpoint, normalize
//      them (shared code), and emit AgentHookEvents to subscribers (the
//      rpcServer forwards them to the client as evt frames).
//
// Transport choice: loopback HTTP with a per-boot bearer token. Hook handlers
// always run on the daemon's own host (they are children of PTYs this daemon
// spawned), so loopback suffices even for remote workspaces — the daemon
// ingests locally and the normalized events ride the existing LF-JSON pipe to
// the app. HTTP over a unix socket was rejected because the in-process
// injections (pi extension, opencode plugin) post with plain `fetch`, which
// cannot target a unix socket without extra dependencies. (The pi extension
// is a workspace file — pi discovers <cwd>/.pi/extensions/*.ts itself — not
// a hooks-dir support file.)
//
// Bridge choice: a tiny sh wrapper exec'ing the daemon's OWN node binary
// (process.execPath) on a daemon-written JS file. Node is NOT guaranteed on
// the user's PATH, but the daemon is always a working node on this host; the
// bundled `cate` CLI was rejected as the bridge because it is absent in
// dev/direct mode and its runtime is gated on the CATE_API setting.
//
// Electron-free; POSIX-only (win32 degrades to a no-op — PTYs spawn plain).
// =============================================================================

import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import http from 'http'
import os from 'os'
import path from 'path'
import { chmod, mkdir, readFile, stat, writeFile } from 'fs/promises'
import { AGENTS, type AgentId } from '../../shared/agents'
import {
  AGENT_HOOK_SPECS,
  CATE_HOOK_MARKER,
  CATE_HOOK_ENDPOINT_ENV,
  CATE_HOOK_TOKEN_ENV,
  CATE_TERMINAL_ID_ENV,
  normalizeAgentHookPayload,
  type AgentHookEvent,
  type AgentHookSpec,
  type HookInjectionContext,
} from '../../shared/agentHooks'

const MAX_BODY_BYTES = 512 * 1024

export interface AgentHooksCapability {
  /** The full spawn env for a PTY: hook endpoint/token, CATE_TERMINAL_ID=ptyId,
   *  and ambient per-agent vars. Lazily boots the ingestion endpoint + hooks
   *  dir on first use. Returns `env` unchanged on win32 or when hook setup
   *  fails (a plain shell is always spawnable). */
  envForPty(ptyId: string, env: Record<string, string>): Promise<Record<string, string>>
  /** Write workspace-scoped hook files (claude, codex, pi) for the PTY's cwd
   *  and keep them out of git status via .git/info/exclude. Best-effort and
   *  idempotent; no-op on win32, and never touches the user's home dir
   *  (~/.codex, ~/.claude etc. are the CLIs' USER-GLOBAL config dirs —
   *  injection stays repo-local). */
  prepareWorkspace(cwd: string): Promise<void>
  /** Subscribe to normalized hook events. Returns an unsubscribe. */
  subscribe(onEvent: (event: AgentHookEvent) => void): () => void
  /** The ingestion endpoint (boots it if needed) — for tests/diagnostics. */
  endpoint(): Promise<{ url: string; token: string; dir: string }>
  /** Close the ingestion endpoint. The stable hooks dir is left in place —
   *  repo hook files embed its bridge paths, which must survive restarts. */
  dispose(): void
}

export interface AgentHooksDeps {
  /** Binary-presence probe for gating workspace file writes (tests inject). */
  hasBin?: (command: string) => Promise<boolean>
  /** Override the stable hooks dir (tests). Default: ~/.cate/agent-hooks. */
  hooksDir?: string
}

interface HookState {
  dir: string
  url: string
  token: string
  server: http.Server
  /** Ambient env vars (spec.env), applied only where the key isn't set yet. */
  ambientVars: Record<string, string>
  /** Per-agent injection context (bridge wrapper + support file paths). */
  contexts: Map<AgentId, HookInjectionContext>
}

/** `command -v` probe, cached per daemon (the PATH the daemon spawns shells
 *  with is fixed for its lifetime). */
function makeHasBin(): (command: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>()
  return (command) => {
    let hit = cache.get(command)
    if (!hit) {
      hit = new Promise<boolean>((resolve) => {
        execFile('/bin/sh', ['-c', 'command -v -- "$1"', 'sh', command], { timeout: 3000 }, (err) => resolve(!err))
      })
      cache.set(command, hit)
    }
    return hit
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
  let payload
  try { payload = JSON.parse(data) } catch { payload = { raw: data } }
  const body = JSON.stringify({ agentId, terminalId: process.env.${CATE_TERMINAL_ID_ENV} || null, payload })
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
  const hasBin = deps.hasBin ?? makeHasBin()
  const listeners = new Set<(event: AgentHookEvent) => void>()
  let ready: Promise<HookState> | null = null
  let disposed = false

  const emit = (event: AgentHookEvent): void => {
    for (const cb of listeners) {
      try { cb(event) } catch { /* a subscriber must not break ingestion */ }
    }
  }

  const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse, token: string): void => {
    if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
    if (req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; res.end(); return }
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) { req.destroy(); return }
      chunks.push(c)
    })
    req.on('error', () => { /* client vanished mid-post */ })
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          agentId?: unknown
          terminalId?: unknown
          payload?: unknown
        }
        if (
          typeof body.agentId === 'string' &&
          typeof body.terminalId === 'string' &&
          body.terminalId &&
          typeof body.payload === 'object' &&
          body.payload !== null
        ) {
          const event = normalizeAgentHookPayload(body.agentId, body.terminalId, body.payload as Record<string, unknown>)
          if (event) emit(event)
        }
        res.statusCode = 204
        res.end()
      } catch {
        res.statusCode = 400
        res.end()
      }
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

    const token = randomBytes(24).toString('hex')
    const contexts = new Map<AgentId, HookInjectionContext>()
    const ambientVars: Record<string, string> = {}

    for (const agent of AGENTS) {
      const spec: AgentHookSpec = AGENT_HOOK_SPECS[agent.id]
      // Per-agent bridge wrapper: hook configs get ONE command path with no
      // args (codex runs the command string directly), so the agent id
      // rides as a baked-in argv of the wrapper.
      const wrapper = path.join(dir, `cate-hook-bridge-${agent.id}`)
      await writeFile(wrapper, `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(bridgeJs)} ${shQuote(agent.id)} "$@"\n`)
      await chmod(wrapper, 0o755)

      const supportFile = spec.env?.file
      let filePath = ''
      if (supportFile) {
        filePath = path.join(dir, supportFile.name)
        await writeFile(filePath, supportFile.content())
      }
      const ctx: HookInjectionContext = { bridgeCommand: wrapper, filePath }
      contexts.set(agent.id, ctx)

      if (spec.env) Object.assign(ambientVars, spec.env.vars(ctx))
    }

    const server = http.createServer((req, res) => handleRequest(req, res, token))
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    })
    server.unref()
    return { dir, url: `http://127.0.0.1:${port}`, token, server, ambientVars, contexts }
  }

  return {
    async envForPty(ptyId, env) {
      if (process.platform === 'win32' || disposed) return env
      let state: HookState
      try {
        state = await ensureReady()
      } catch {
        return env // hook setup failed — spawn a plain shell
      }
      const out = { ...env }
      // Ambient per-agent vars never clobber a value the caller/user set.
      for (const [k, v] of Object.entries(state.ambientVars)) {
        if (out[k] === undefined) out[k] = v
      }
      out[CATE_HOOK_ENDPOINT_ENV] = state.url
      out[CATE_HOOK_TOKEN_ENV] = state.token
      out[CATE_TERMINAL_ID_ENV] = ptyId
      return out
    },

    async prepareWorkspace(cwd) {
      if (process.platform === 'win32' || disposed) return
      // Never plant agent files in the user's home directory: ~/.codex and
      // ~/.claude are the CLIs' USER-GLOBAL config dirs, and writing there
      // would violate the repo-local-only injection policy. Bail on an
      // empty/relative cwd too — resolving those against the daemon's own
      // cwd would write files somewhere the user never asked for.
      const home = os.homedir()
      if (!cwd || !path.isAbsolute(cwd) || !home || path.resolve(cwd) === path.resolve(home)) return
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
        // Only touch workspaces of users who actually have this CLI — no
        // hook-file litter for everyone else.
        if (!(await hasBin(agent.command).catch(() => false))) continue
        const ctx = state.contexts.get(agent.id)!
        for (const pf of spec.projectFiles ?? []) {
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

    subscribe(onEvent) {
      listeners.add(onEvent)
      return () => { listeners.delete(onEvent) }
    },

    async endpoint() {
      const state = await ensureReady()
      return { url: state.url, token: state.token, dir: state.dir }
    },

    dispose() {
      disposed = true
      listeners.clear()
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
