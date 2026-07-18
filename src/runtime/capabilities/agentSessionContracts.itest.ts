// =============================================================================
// LIVE agent-CLI session contracts — pins, against the real installed CLIs,
// every store behavior the terminal session-restore probe
// (src/runtime/capabilities/agentSessions.ts) relies on:
//
//   1. LAZY PERSISTENCE: no session is stored before the first prompt. This is
//      why the probe needs exact pid signals / the start-time gate — "newest
//      stored session" at agent launch is the PREVIOUS session (the off-by-one
//      this suite regression-guards).
//   2. After one prompt, exactly ONE stored session exists for the cwd, and it
//      yields the session id (filename / meta / dir name).
//   3. EXACT SIGNALS where the CLI offers one:
//        claude · ~/.claude/sessions/<pid>.json registry matches the stored
//                 session, and /clear rotates it IN PLACE (same pid file)
//        codex  · the agent process holds the rollout file OPEN (fd scan)
//   4. RESUME BY ID re-attaches to the SAME stored session — no fork.
//
// Store shapes:
//   claude  · ~/.claude/projects/<cwd-slug>/<uuid>.jsonl · claude --resume <id>
//   codex   · ~/.codex/sessions/**/rollout-*-<uuid>.jsonl · codex resume <id>
//   pi      · ~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl · pi --session <id>
//   opencode· ~/.local/share/opencode/opencode.db (sqlite session table) —
//             storage/session/*.json is legacy       · opencode --session <id>
//   cursor  · ~/.cursor/chats/<md5(cwd)>/<chatId>/store.db (hash dir IS the
//             cwd join)                              · cursor-agent --resume <id>
//
// A CLI update that breaks one of these must fail HERE (loudly, pre-release),
// so the app-side probe degrades to a plain shell restore instead of resuming
// the wrong session. Opt-in only: drives the real, locally-installed CLIs with
// the user's accounts (a few tiny prompts — cents). *.itest.ts is excluded from
// the normal vitest include. Needs Node >= 22.5 (node:sqlite).
//
// Run:  CATE_LIVE_AGENT_CLIS=1 npx vitest run --config vitest.live.config.ts \
//         agentSessionContracts
// =============================================================================

import { describe, test, expect, afterAll } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync,
} from 'node:fs'

const execFileAsync = promisify(execFile)

const LIVE = process.env.CATE_LIVE_AGENT_CLIS === '1'
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

function hasBin(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// A nested CLAUDECODE/ANTHROPIC env changes claude's persistence behavior
// (observed: interactive transcripts silently not written) — always drive the
// CLIs with the agent vars stripped, like a real Cate terminal.
function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([k, v]) => v !== undefined && !/^(CLAUDE|ANTHROPIC|CODEX)/i.test(k) && k !== 'CLAUDECODE',
    ),
  ) as Record<string, string>
}

// Fresh cwd per run so trust prompts / project slugs are deterministic and
// removable. Everything created here is cleaned in afterAll.
const RUN_TAG = `cate-agent-contract-${Date.now()}`
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

// --- tiny TUI driver ---------------------------------------------------------

interface Tui {
  pid: number
  send: (line: string) => Promise<void>
  settle: (ms: number) => Promise<void>
  waitFor: (pred: () => boolean, timeoutMs: number, label: string) => Promise<void>
  peek: () => string
  waitExit: (timeoutMs: number) => Promise<boolean>
  kill: () => void
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function driveTui(bin: string, args: string[], cwd: string): Promise<Tui> {
  const { spawn } = await import('node-pty')
  const p = spawn(bin, args, { name: 'xterm-256color', cols: 120, rows: 40, cwd, env: cleanEnv() })
  let buf = ''
  let exited = false
  let trusted = false
  p.onData((d) => { buf += d })
  p.onExit(() => { exited = true })
  cleanups.push(() => { if (!exited) p.kill() })

  // First-run interstitials, checked on every poll tick (settle AND waitFor):
  // folder-trust prompts (claude, codex, and cursor all ask in a fresh cwd;
  // default choice is "yes, trust") and codex's update banner. NEVER Enter
  // through the update banner — Enter ACCEPTS the self-update (brew upgrade).
  // Esc dismisses it.
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

  const tui: Tui = {
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
    waitExit: async (timeoutMs) => {
      const start = Date.now()
      while (!exited && Date.now() - start < timeoutMs) await sleep(250)
      return exited
    },
    kill: () => p.kill(),
  }
  return tui
}

// --- filesystem probes -------------------------------------------------------

/** Paths a pid holds open, via lsof (the probe's macOS shape; on Linux the app
 *  uses /proc — byte-equivalent output for this purpose). */
function openFilePaths(pid: number): string[] {
  try {
    const out = execFileSync('lsof', ['-p', String(pid), '-Fn'], { encoding: 'utf8' })
    return out.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1))
  } catch (err) {
    // lsof exits 1 for unresolvable fd types while still printing the rest.
    const out = (err as { stdout?: string }).stdout ?? ''
    return out.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1))
  }
}

/** Remove a session file and, when that leaves the per-project slug dir the
 *  CLI created for our throwaway cwd holding nothing but empty scaffolding
 *  dirs (claude adds an empty memory/), the slug dir too. Any remaining FILE
 *  means the dir is shared — keep it. */
function removeSessionFile(file: string): void {
  rmSync(file, { force: true })
  const parent = dirname(file)
  try {
    const leftovers = readdirSync(parent)
    if (leftovers.every((n) => readdirSync(join(parent, n)).length === 0)) {
      rmSync(parent, { recursive: true, force: true })
    }
  } catch { /* a leftover is a file (readdirSync throws) or dir vanished: keep */ }
}

// --- the uniform contract, one adapter per CLI -------------------------------

/** One stored session as the probe sees it. */
interface SessionHit {
  /** The resume id (from meta, filename, or dir name — adapter's choice). */
  id: string
  /** id encoded in the filename when the store ALSO puts it there — asserted
   *  to agree with `id`. */
  idFromName?: string | null
  /** last-write time, ms epoch — the "session grew" signal. */
  updatedAt: number
  /** backing file for file-based stores (content assertions). */
  file?: string
}

interface CliAdapter {
  bin: string
  /** argv for a fresh interactive session (cheap model where selectable). */
  launchArgs: string[]
  /** argv that re-attaches to session `id` interactively. */
  resumeArgs: (id: string) => string[]
  /** Stored sessions for THIS cwd written/updated after `since` — the
   *  app-side probe's store lookup, verbatim. */
  sessionsFor: (cwd: string, since: number) => SessionHit[]
  /** register removal of a session the test created (afterAll, best-effort). */
  registerCleanup: (s: SessionHit, cwd: string) => void
  /** Pin the CLI's exact pid signal (registry / held fd), when it has one.
   *  Runs after the first prompt, while the TUI is still alive. */
  exactSignal?: (tui: Tui, cwd: string, s: SessionHit) => Promise<void>
  /** Interactive resume-by-id is allowed to FORK a new session record while
   *  continuing the conversation (claude: thin shadow session whose leaf chain
   *  points into the original transcript; cursor TUI observed doing the same).
   *  The app copes: its next probe stamps whatever the fork produced. When
   *  unset, resume must re-attach with NO new session record. */
  resumeMayFork?: boolean
  /** Extra post-resume pinning, runs while the resumed TUI is alive. */
  postResume?: (tui2: Tui, cwd: string, originalId: string, since: number) => Promise<void>
  /** --help smoke: argv to run and substrings the restore path relies on. */
  help: { argv: string[]; expects: string[] }
}

/** First parseable JSONL line for which pick() returns a value. */
function scanJsonl<T>(file: string, pick: (o: unknown) => T | null): T | null {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const v = pick(JSON.parse(line))
      if (v !== null) return v
    } catch { /* partial write / non-JSON line */ }
  }
  return null
}

type FileMeta = { id: string | null; cwd: string | null }

/** sessionsFor for the file-backed stores: recursive walk of root, cwd from
 *  each file's meta. */
function fileStore(
  root: string,
  isSessionFile: (name: string) => boolean,
  fileId: (name: string) => string | null,
  meta: (file: string) => FileMeta,
): { sessionsFor: CliAdapter['sessionsFor']; registerCleanup: CliAdapter['registerCleanup'] } {
  const filesFor = (cwd: string, since: number): { path: string; hit: SessionHit }[] => {
    if (!existsSync(root)) return []
    const out: { path: string; hit: SessionHit }[] = []
    const walk = (dir: string): void => {
      let names: string[]
      try { names = readdirSync(dir) } catch { return }
      for (const name of names) {
        const p = join(dir, name)
        let st
        try { st = statSync(p) } catch { continue } // vanished mid-walk
        if (st.isDirectory()) walk(p)
        else if (isSessionFile(name) && st.mtimeMs > since) {
          const m = meta(p)
          if (m.cwd === cwd && m.id) {
            out.push({ path: p, hit: { id: m.id, idFromName: fileId(name), updatedAt: st.mtimeMs, file: p } })
          }
        }
      }
    }
    walk(root)
    return out
  }
  return {
    sessionsFor: (cwd, since) => filesFor(cwd, since).map((f) => f.hit),
    // Sweep EVERY session for the test cwd, not just the registered id — the
    // cwd is exclusively this test's, and resume forks / failed runs create
    // sessions whose ids are unknown at registration time.
    registerCleanup: (_s, cwd) =>
      cleanups.push(() => {
        for (const f of filesFor(cwd, 0)) removeSessionFile(f.path)
      }),
  }
}

const OPENCODE_DB = join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
const CURSOR_CHATS = join(homedir(), '.cursor', 'chats')
const CLAUDE_REGISTRY = join(homedir(), '.claude', 'sessions')
const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects')

function fileExistsUnder(root: string, name: string): boolean {
  if (!existsSync(root)) return false
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let names: string[]
    try { names = readdirSync(dir) } catch { continue }
    for (const n of names) {
      const p = join(dir, n)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) stack.push(p)
      else if (n === name) return true
    }
  }
  return false
}

function claudeRegistryEntry(pid: number): { pid?: unknown; cwd?: unknown; sessionId?: unknown } | null {
  try {
    return JSON.parse(readFileSync(join(CLAUDE_REGISTRY, `${pid}.json`), 'utf8'))
  } catch {
    return null // absent or mid-rotation partial write
  }
}

// Built outside the adapter literal so postResume can reuse the store lookup.
const claudeStore = fileStore(
  CLAUDE_PROJECTS,
  (n) => n.endsWith('.jsonl') && UUID_RE.test(n.slice(0, -6)),
  (n) => n.slice(0, -6).match(UUID_RE)?.[0] ?? null,
  // Every transcript entry carries sessionId + cwd; take the first that has both.
  (f) =>
    scanJsonl<FileMeta>(f, (o) => {
      const e = o as { sessionId?: unknown; cwd?: unknown }
      return typeof e.sessionId === 'string' && typeof e.cwd === 'string'
        ? { id: e.sessionId, cwd: e.cwd }
        : null
    }) ?? { id: null, cwd: null },
)

const ADAPTERS: CliAdapter[] = [
  {
    bin: 'claude',
    launchArgs: ['--model', 'haiku'],
    resumeArgs: (id) => ['--resume', id, '--model', 'haiku'],
    ...claudeStore,
    // The EXACT signal the app probe prefers: the live pid registry, keyed by
    // the claude process pid, carrying the CURRENT session id + cwd.
    exactSignal: async (tui, cwd, s) => {
      const entry = claudeRegistryEntry(tui.pid)
      expect(entry?.pid, 'registry pid').toBe(tui.pid)
      expect(entry?.cwd, 'registry cwd').toBe(cwd)
      expect(entry?.sessionId, 'registry sessionId matches the stored session').toBe(s.id)

      // /clear must rotate the sessionId IN PLACE (same <pid>.json) — this is
      // what keeps the probe correct across clears without any file scanning.
      await tui.send('/clear')
      await tui.waitFor(() => {
        const e = claudeRegistryEntry(tui.pid)
        return e?.pid === tui.pid && typeof e?.sessionId === 'string' && e.sessionId !== s.id
      }, 20_000, 'registry sessionId rotation after /clear')
      // Note: after /clear the REGISTRY id is ahead of the transcript files
      // (the new session is unwritten until its first prompt) — exactly the
      // lazy-persistence gap the app probe closes via the registry.
    },
    // Interactive --resume creates a thin shadow session (new id, meta-only
    // file) while appending the actual turns to the ORIGINAL transcript via
    // the leaf chain — observed live, and what the app's re-probe handles.
    resumeMayFork: true,
    postResume: async (tui2, cwd, originalId, since) => {
      // Continuation: the resumed turn is persisted in the project's slug dir —
      // usually appended to the ORIGINAL transcript via the leaf chain, but
      // observed occasionally landing only in the fork's file, so accept any
      // transcript beside the original.
      await tui2.waitFor(() => {
        const orig = claudeStore.sessionsFor(cwd, since).find((s) => s.id === originalId)
        if (!orig?.file) return false
        const slugDir = dirname(orig.file)
        try {
          return readdirSync(slugDir).some(
            (f) => f.endsWith('.jsonl') && readFileSync(join(slugDir, f), 'utf8').includes('ok again'),
          )
        } catch {
          return false
        }
      }, 120_000, 'resumed turn persisted in the project slug dir')
      // The resumed process's registry names a session whose transcript file
      // exists — i.e. the app's NEXT probe stamps a resumable id.
      await tui2.waitFor(() => {
        const e = claudeRegistryEntry(tui2.pid)
        return (
          e?.pid === tui2.pid &&
          typeof e?.sessionId === 'string' &&
          fileExistsUnder(CLAUDE_PROJECTS, `${e.sessionId}.jsonl`)
        )
      }, 30_000, 'resumed registry id backed by an existing transcript')
    },
    help: { argv: ['--help'], expects: ['--resume', '--continue'] },
  },
  {
    bin: 'codex',
    launchArgs: [],
    resumeArgs: (id) => ['resume', id],
    // First line is session meta: {payload: {id | session_id, cwd}}.
    ...fileStore(
      join(homedir(), '.codex', 'sessions'),
      (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'),
      (n) => n.match(UUID_RE)?.[0] ?? null,
      (f) =>
        scanJsonl<FileMeta>(f, (o) => {
          const p = (o as { payload?: { id?: unknown; session_id?: unknown; cwd?: unknown } }).payload
          if (!p || typeof p.cwd !== 'string') return null
          const id = typeof p.session_id === 'string' ? p.session_id : typeof p.id === 'string' ? p.id : null
          return { id, cwd: p.cwd }
        }) ?? { id: null, cwd: null },
    ),
    // The EXACT signal the app probe prefers: the codex process holds its
    // rollout open — pid → open fd → session file, no guessing.
    exactSignal: async (tui, _cwd, s) => {
      await tui.waitFor(
        () => openFilePaths(tui.pid).some((p) => p.includes('/sessions/') && p.includes(s.id)),
        15_000,
        'codex process holding the rollout fd',
      )
    },
    help: { argv: ['resume', '--help'], expects: ['--last', 'SESSION_ID'] },
  },
  {
    bin: 'pi',
    launchArgs: [],
    // --session takes a session file path or (partial) session UUID;
    // --resume is an interactive picker, so it's no use for restore.
    resumeArgs: (id) => ['--session', id],
    // First line: {type: "session", id, cwd}.
    ...fileStore(
      join(homedir(), '.pi', 'agent', 'sessions'),
      (n) => n.endsWith('.jsonl') && UUID_RE.test(n),
      (n) => n.match(UUID_RE)?.[0] ?? null,
      (f) =>
        scanJsonl<FileMeta>(f, (o) => {
          const e = o as { type?: unknown; id?: unknown; cwd?: unknown }
          return e.type === 'session' && typeof e.id === 'string' && typeof e.cwd === 'string'
            ? { id: e.id, cwd: e.cwd }
            : null
        }) ?? { id: null, cwd: null },
    ),
    help: { argv: ['--help'], expects: ['--session', '--continue'] },
  },
  {
    bin: 'opencode',
    launchArgs: [],
    resumeArgs: (id) => ['--session', id],
    // Sessions live in a WAL-mode sqlite db. Open read-only per call so each
    // query sees the CLI's latest commit.
    sessionsFor: (cwd, since) => {
      if (!existsSync(OPENCODE_DB)) return []
      const db = new DatabaseSync(OPENCODE_DB, { readOnly: true })
      try {
        const rows = db
          .prepare('SELECT id, time_updated FROM session WHERE directory = ? AND time_updated > ?')
          .all(cwd, since) as { id: string; time_updated: number }[]
        return rows.map((r) => ({ id: r.id, updatedAt: r.time_updated }))
      } finally {
        db.close()
      }
    },
    registerCleanup: (s) =>
      cleanups.push(() => {
        execFileSync('opencode', ['session', 'delete', s.id], { env: cleanEnv(), timeout: 30_000 })
        // diff-summary sidecar is not covered by `session delete`
        rmSync(join(homedir(), '.local', 'share', 'opencode', 'storage', 'session_diff', `${s.id}.json`), { force: true })
      }),
    // opencode prints help to stderr; the smoke test reads stdout+stderr.
    help: { argv: ['--help'], expects: ['--session', '--continue'] },
  },
  {
    bin: 'cursor-agent',
    launchArgs: [],
    resumeArgs: (id) => ['--resume', id],
    // Chats are grouped per workspace under <chats>/<md5(cwd)>/<chatId>/store.db
    // — the hash dir IS the cwd join and the chatId dir name is the resume id.
    // Recency = newest mtime of ANY file in the chat dir: the store is WAL-mode
    // sqlite, so a live TUI appends to store.db-wal while store.db itself stays
    // untouched until a checkpoint.
    sessionsFor: (cwd, since) => {
      const workspaceDir = join(CURSOR_CHATS, createHash('md5').update(cwd).digest('hex'))
      if (!existsSync(workspaceDir)) return []
      const out: SessionHit[] = []
      for (const chatId of readdirSync(workspaceDir)) {
        let newest = 0
        let isChat = false
        try {
          for (const f of readdirSync(join(workspaceDir, chatId))) {
            const st = statSync(join(workspaceDir, chatId, f))
            if (!st.isFile()) continue
            if (f.startsWith('store.db')) isChat = true
            if (st.mtimeMs > newest) newest = st.mtimeMs
          }
        } catch { continue /* not a chat dir */ }
        if (isChat && newest > since) out.push({ id: chatId, updatedAt: newest })
      }
      return out
    },
    // The whole hash dir belongs to our throwaway cwd — remove it wholesale.
    registerCleanup: (_s, cwd) =>
      cleanups.push(() =>
        rmSync(join(CURSOR_CHATS, createHash('md5').update(cwd).digest('hex')), { recursive: true, force: true }),
      ),
    // TUI resume was observed continuing the conversation in a NEW chat dir
    // (print-mode --resume re-attaches in place; the TUI may fork). The app's
    // re-probe stamps whichever chat the resumed turn landed in.
    resumeMayFork: true,
    help: { argv: ['--help'], expects: ['--resume', '--continue'] },
  },
]

// --- the uniform test, once per CLI ------------------------------------------

for (const cli of ADAPTERS) {
  describe.skipIf(!LIVE || !hasBin(cli.bin))(`${cli.bin} session contract`, () => {
    test('help lists the flags the restore path uses', async () => {
      // opencode prints help to stderr, the others to stdout — read both.
      const { stdout, stderr } = await execFileAsync(cli.bin, cli.help.argv, { env: cleanEnv() })
      const help = stdout + stderr
      for (const s of cli.help.expects) expect(help).toContain(s)
    })

    // retry 1: pty-driven TUIs occasionally mangle typed input during init
    // (observed: characters eaten by a slash-command menu). A contract break
    // fails twice; a one-off input flake heals on the retry.
    test('lazy persistence; id + exact signal after prompt; resume-by-id (no fork)', { retry: 1, timeout: 420_000 }, async () => {
      const cwd = makeCwd(cli.bin)
      const since = Date.now()
      const ourSessions = (): SessionHit[] => cli.sessionsFor(cwd, since)

      // 1. Launch, let the TUI paint — and pin LAZY PERSISTENCE: nothing is
      // stored for this cwd before the first prompt. (This is the root of the
      // resume-previous-session offset the app probe guards against; if a CLI
      // starts persisting eagerly, this fails and the probe gets simpler.)
      const tui = await driveTui(cli.bin, cli.launchArgs, cwd)
      await tui.waitFor(() => tui.peek().length > 0, 30_000, `${cli.bin} first paint`)
      await tui.settle(6_000) // absorb trust prompt / banners before typing
      expect(ourSessions(), 'no stored session before the first prompt').toEqual([])

      // 2. One tiny prompt → exactly one stored session for this cwd.
      await tui.send('Reply with exactly: ok')
      await tui.waitFor(() => ourSessions().length > 0, 120_000, 'stored session for the test cwd')
      const found = ourSessions()
      expect(found, 'exactly one stored session for this cwd').toHaveLength(1)
      cli.registerCleanup(found[0], cwd)
      const { id, idFromName } = found[0]
      if (idFromName) expect(id, 'store meta id agrees with filename id').toBe(idFromName)

      // 3. The CLI's exact pid signal (registry / held fd), where it has one.
      await cli.exactSignal?.(tui, cwd, found[0])

      // 4. Let the store go quiet, then simulate the app quitting: SIGKILL via
      // pty teardown, NOT a clean exit — restore always follows a kill.
      let last = 0
      let lastChange = Date.now()
      await tui.waitFor(() => {
        const at = ourSessions()[0]?.updatedAt ?? 0
        if (at !== last) {
          last = at
          lastChange = Date.now()
        }
        return Date.now() - lastChange >= 4_000
      }, 120_000, 'session store quiescence')
      tui.kill()
      await tui.waitExit(10_000)

      // 5. Re-attach by id: the store must advance (the resumed turn lands),
      // and unless the CLI is a known forker, with NO new session record.
      const beforeMax = Math.max(...ourSessions().map((s) => s.updatedAt))
      const tui2 = await driveTui(cli.bin, cli.resumeArgs(id), cwd)
      await tui2.waitFor(() => tui2.peek().length > 0, 30_000, `${cli.bin} resume paint`)
      await tui2.settle(6_000)
      await tui2.send('Reply with exactly: ok again')
      await tui2.waitFor(
        () => Math.max(0, ...ourSessions().map((s) => s.updatedAt)) > beforeMax,
        120_000,
        'resumed turn recorded in the store',
      )
      const after = ourSessions()
      if (cli.resumeMayFork) {
        expect(after.length, 'resume keeps at least the original session stored').toBeGreaterThanOrEqual(1)
        for (const s of after) if (s.id !== id) cli.registerCleanup(s, cwd)
      } else {
        expect(after, 'resume must not fork a second session').toHaveLength(1)
      }
      await cli.postResume?.(tui2, cwd, id, since)
      tui2.kill()
    })
  })
}

// Resuming a dead id must FAIL (not silently start a fresh session) — this is
// what lets the app fall back to a plain shell when a stored id has been
// deleted. Cheap to pin in print mode for claude; the other CLIs' behavior for
// a ghost id is intentionally unpinned until the app needs to rely on it.
describe.skipIf(!LIVE || !hasBin('claude'))('claude ghost-session resume', () => {
  test('print mode: resuming an unknown session id fails', async () => {
    const cwd = makeCwd('claude-badresume')
    const ghost = '99999999-9999-4999-8999-999999999999'
    await expect(
      execFileAsync('claude', ['-p', 'hi', '--resume', ghost, '--model', 'haiku'], { cwd, env: cleanEnv(), timeout: 120_000 }),
    ).rejects.toThrow()
  }, 240_000)
})
