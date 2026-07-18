// =============================================================================
// Agent session probe — resolves which stored agent-CLI session a terminal is
// running, so session-restore can re-attach it after an app restart.
//
// Every CLI persists its session lazily (no file/row until the first prompt),
// so "newest stored session for this cwd" alone systematically returns the
// PREVIOUS session for a freshly-launched agent. The probe therefore uses the
// strongest signal each CLI offers, in this order:
//
//   claude  · EXACT: ~/.claude/sessions/<agentPid>.json live registry
//             (pid → sessionId/cwd, present from launch, rotated in place by
//             /clear, removed on clean exit). Only stamped once the session's
//             transcript exists — an empty session has nothing to resume.
//   codex   · EXACT: the rollout-*.jsonl under ~/.codex/sessions the agent
//             process holds OPEN (fd scan). No fd → no session yet.
//   pi      · newest ~/.pi/agent/sessions/<slug>/*.jsonl whose head cwd
//             matches, GATED by the agent's process start time — a session not
//             touched since the agent started cannot be its session.
//   opencode· newest sqlite session row (id/directory/time_updated in
//             ~/.local/share/opencode/opencode.db) matching the cwd, same gate.
//   cursor  · newest chat under ~/.cursor/chats/<md5(cwd)>/<chatId>/store.db
//             (the workspace dir IS the cwd join), same gate; resume by the
//             chatId dir name.
//
// These contracts are pinned LIVE against the installed CLIs by
// agentSessionContracts.itest.ts — a CLI update that changes a store shape
// fails there, loudly, pre-release, and the probe degrades to "no session"
// (plain-shell restore) rather than resuming the wrong session.
//
// Electron-free: runs inside the runtime daemon, so local and remote
// workspaces probe identically on whichever host owns the terminal. Agents
// with no adapter here (antigravity) probe to null.
// =============================================================================

import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { open, readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'
import type { AgentId } from '../../shared/agents'
import { getStartTimeProc, openFilePathsProc } from './procfs'

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

// Sessions store metadata in their head; transcripts can grow to many MB, so
// never read a whole file just to learn its cwd.
const HEAD_BYTES = 64 * 1024

// Newest-first scan cap: bounds worst-case work on stores with years of
// accumulated sessions. The probe runs while the agent is alive and writing,
// so its session is at — or within a hand's reach of — the top of the scan.
const SCAN_CAP = 100

// Slack subtracted from the agent's start time when gating session recency —
// absorbs the 1s resolution of `ps -o lstart=` and fs timestamp rounding.
// Kept SMALL on purpose: "exit claude, immediately re-run claude" must not let
// the previous session (touched moments before the relaunch) pass the gate.
const START_GATE_SLACK_MS = 1500

export interface AgentSessionProbe {
  agentId: string
  /** Pid of the agent CLI process itself (the shell's child), NOT the shell. */
  agentPid: number
  /** The agent process's cwd — the session join key. */
  cwd: string
  /** ms epoch the agent process started, or null when unknown. Sessions not
   *  updated after this moment cannot belong to this process. */
  agentStartMs: number | null
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface FileMeta {
  sessionId: string | null
  cwd: string | null
}

export interface FileStoreSpec {
  isSessionFile(name: string): boolean
  /** id + cwd parsed from the file's head (first HEAD_BYTES). */
  meta(head: string): FileMeta
}

/** First parseable JSONL line in `head` for which pick() returns a value. The
 *  last line may be truncated by the HEAD_BYTES cut and fails parse harmlessly. */
function scanJsonlHead(head: string, pick: (o: unknown) => FileMeta | null): FileMeta | null {
  for (const line of head.split('\n')) {
    if (!line.trim()) continue
    try {
      const v = pick(JSON.parse(line))
      if (v !== null) return v
    } catch { /* truncated / non-JSON line */ }
  }
  return null
}

async function readHead(path: string): Promise<string | null> {
  let fh
  try {
    fh = await open(path, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0)
    return buf.toString('utf-8', 0, bytesRead)
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** Recursive walk collecting matching files with their mtimes. */
async function walkFiles(
  root: string,
  matches: (name: string) => boolean,
): Promise<{ path: string; mtimeMs: number }[]> {
  const files: { path: string; mtimeMs: number }[] = []
  const walk = async (dir: string): Promise<void> => {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return // root missing (CLI never used) or dir vanished mid-walk
    }
    await Promise.all(
      names.map(async (name) => {
        const p = join(dir, name)
        let st
        try {
          st = await stat(p)
        } catch {
          return
        }
        if (st.isDirectory()) await walk(p)
        else if (matches(name)) files.push({ path: p, mtimeMs: st.mtimeMs })
      }),
    )
  }
  await walk(root)
  return files
}

/** Paths a process holds open: /proc fds on Linux, `lsof -Fn` elsewhere. */
async function openFilePathsForPid(pid: number): Promise<string[]> {
  if (process.platform === 'linux') return openFilePathsProc(pid)
  return new Promise((resolve) => {
    execFile('lsof', ['-p', String(pid), '-Fn'], { encoding: 'utf-8', timeout: 5000 }, (err, stdout) => {
      // lsof exits non-zero for some fd types it can't resolve while still
      // printing the rest — parse whatever arrived.
      if (!stdout) return resolve([])
      resolve(stdout.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1)))
    })
  })
}

/** Agent process start time: /proc on Linux, `ps -o lstart=` elsewhere. */
export async function startTimeForPid(pid: number): Promise<number | null> {
  if (process.platform === 'win32') return null
  if (process.platform === 'linux') return getStartTimeProc(pid)
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf-8', timeout: 3000 }, (err, stdout) => {
      if (err || !stdout.trim()) return resolve(null)
      const ms = Date.parse(stdout.trim()) // "Thu Jul 16 20:34:45 2026"
      resolve(isNaN(ms) ? null : ms)
    })
  })
}

// ---------------------------------------------------------------------------
// Per-store lookups (roots injected — unit-tested with fixture stores; the
// top-level probe supplies the real ones)
// ---------------------------------------------------------------------------

export const FILE_STORES: Record<'claude-code' | 'codex' | 'pi', FileStoreSpec> = {
  // Every transcript entry carries sessionId + cwd; take the first that has both.
  'claude-code': {
    isSessionFile: (n) => n.endsWith('.jsonl') && UUID_RE.test(n.slice(0, -6)),
    meta: (head) =>
      scanJsonlHead(head, (o) => {
        const e = o as { sessionId?: unknown; cwd?: unknown }
        return typeof e.sessionId === 'string' && typeof e.cwd === 'string'
          ? { sessionId: e.sessionId, cwd: e.cwd }
          : null
      }) ?? { sessionId: null, cwd: null },
  },
  // First line is session meta: {payload: {id | session_id, cwd}}.
  codex: {
    isSessionFile: (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'),
    meta: (head) =>
      scanJsonlHead(head, (o) => {
        const p = (o as { payload?: { id?: unknown; session_id?: unknown; cwd?: unknown } }).payload
        if (!p || typeof p.cwd !== 'string') return null
        const sessionId =
          typeof p.session_id === 'string' ? p.session_id : typeof p.id === 'string' ? p.id : null
        return { sessionId, cwd: p.cwd }
      }) ?? { sessionId: null, cwd: null },
  },
  // First line: {type: "session", id, cwd}.
  pi: {
    isSessionFile: (n) => n.endsWith('.jsonl') && UUID_RE.test(n),
    meta: (head) =>
      scanJsonlHead(head, (o) => {
        const e = o as { type?: unknown; id?: unknown; cwd?: unknown }
        return e.type === 'session' && typeof e.id === 'string' && typeof e.cwd === 'string'
          ? { sessionId: e.id, cwd: e.cwd }
          : null
      }) ?? { sessionId: null, cwd: null },
  },
}

/** Newest session file under `root` whose recorded cwd equals `cwd` AND whose
 *  mtime is >= sinceMs (0 disables the gate), scanning newest-first with early
 *  exit. */
export async function newestFileSessionFor(
  root: string,
  spec: FileStoreSpec,
  cwd: string,
  sinceMs = 0,
): Promise<string | null> {
  const files = (await walkFiles(root, spec.isSessionFile)).filter((f) => f.mtimeMs >= sinceMs)
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const f of files.slice(0, SCAN_CAP)) {
    const head = await readHead(f.path)
    if (head === null) continue
    const meta = spec.meta(head)
    if (meta.cwd === cwd && meta.sessionId) return meta.sessionId
  }
  return null
}

/** claude's live pid registry: <registryRoot>/<agentPid>.json. The EXACT
 *  current session of that process — present from launch (before any
 *  transcript exists) and rotated in place by /clear. Returns:
 *  - the sessionId when the entry is valid AND its transcript file exists
 *    under projectsRoot (an empty, never-prompted session has nothing to
 *    resume — stamping it would make restore fail on a ghost id);
 *  - null when the entry is valid but no transcript exists yet;
 *  - undefined when there is no usable registry entry for this pid (registry
 *    absent/unreadable — the caller falls back to the gated file scan). */
export async function claudeRegistrySession(
  registryRoot: string,
  projectsRoot: string,
  agentPid: number,
): Promise<string | null | undefined> {
  let entry: { pid?: unknown; sessionId?: unknown }
  try {
    entry = JSON.parse(await readFile(join(registryRoot, `${agentPid}.json`), 'utf-8'))
  } catch {
    return undefined // no registry (older claude / mid-rotation write) — fall back
  }
  if (entry.pid !== agentPid || typeof entry.sessionId !== 'string') return undefined
  const sessionId = entry.sessionId
  const transcript = `${sessionId}.jsonl`
  const hits = await walkFiles(projectsRoot, (n) => n === transcript)
  return hits.length > 0 ? sessionId : null
}

/** The codex rollout the agent process itself holds open — the deterministic
 *  pid → session join. Undefined when the fd scan shows no rollout (no session
 *  yet, or fd scanning unavailable — the caller falls back to the gated scan). */
export async function codexOpenRolloutSession(
  sessionsRoot: string,
  agentPid: number,
): Promise<string | undefined> {
  const paths = await openFilePathsForPid(agentPid)
  for (const p of paths) {
    const name = basename(p)
    if (!p.startsWith(sessionsRoot + '/') || !name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
    const id = name.match(UUID_RE)?.[0]
    if (id) return id
  }
  return undefined
}

/** Newest opencode session row for `cwd` updated at/after sinceMs, straight
 *  from the sqlite store. Opened read-only per call so each probe sees the
 *  CLI's latest WAL commit. Any failure (no db, locked, node:sqlite
 *  unavailable on Node < 22.5) degrades to null. */
export async function newestOpencodeSessionFor(
  dbPath: string,
  cwd: string,
  sinceMs = 0,
): Promise<string | null> {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = db
        .prepare('SELECT id FROM session WHERE directory = ? AND time_updated >= ? ORDER BY time_updated DESC LIMIT 1')
        .get(cwd, sinceMs) as { id?: unknown } | undefined
      return typeof row?.id === 'string' ? row.id : null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

/** Newest cursor chat for `cwd`: chats are grouped per workspace under
 *  <chatsRoot>/<md5(cwd)>/<chatId>/store.db, so the hash dir IS the cwd join
 *  and the chatId dir name is the resume id. Recency = the NEWEST mtime of any
 *  file in the chat dir — the store is WAL-mode sqlite, so a live TUI appends
 *  to store.db-wal while store.db itself stays untouched until a checkpoint.
 *  Gated by sinceMs. */
export async function newestCursorSessionFor(
  chatsRoot: string,
  cwd: string,
  sinceMs = 0,
): Promise<string | null> {
  const workspaceDir = join(chatsRoot, createHash('md5').update(cwd).digest('hex'))
  let chatIds: string[]
  try {
    chatIds = await readdir(workspaceDir)
  } catch {
    return null // no chats for this cwd
  }
  let best: { id: string; mtimeMs: number } | null = null
  await Promise.all(
    chatIds.map(async (id) => {
      const mtimeMs = await newestMtimeIn(join(workspaceDir, id))
      if (mtimeMs !== null && mtimeMs >= sinceMs && (!best || mtimeMs > best.mtimeMs)) {
        best = { id, mtimeMs }
      }
    }),
  )
  return best ? (best as { id: string }).id : null
}

/** Newest mtime of any file directly inside `dir`, or null when it has none
 *  (or is not a directory). */
async function newestMtimeIn(dir: string): Promise<number | null> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  let newest: number | null = null
  await Promise.all(
    names.map(async (name) => {
      try {
        const st = await stat(join(dir, name))
        if (st.isFile() && (newest === null || st.mtimeMs > newest)) newest = st.mtimeMs
      } catch { /* vanished mid-scan */ }
    }),
  )
  return newest
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/** The session id the given agent process has open, or null when the agent has
 *  no adapter, has not persisted a session yet, or its store is absent. */
export async function probeSessionForAgent(probe: AgentSessionProbe): Promise<string | null> {
  const { agentPid, cwd } = probe
  const gate = probe.agentStartMs != null ? probe.agentStartMs - START_GATE_SLACK_MS : 0
  switch (probe.agentId as AgentId) {
    case 'claude-code': {
      const registry = await claudeRegistrySession(
        join(homedir(), '.claude', 'sessions'),
        join(homedir(), '.claude', 'projects'),
        agentPid,
      )
      if (registry !== undefined) return registry
      return newestFileSessionFor(join(homedir(), '.claude', 'projects'), FILE_STORES['claude-code'], cwd, gate)
    }
    case 'codex': {
      const held = await codexOpenRolloutSession(join(homedir(), '.codex', 'sessions'), agentPid)
      if (held !== undefined) return held
      return newestFileSessionFor(join(homedir(), '.codex', 'sessions'), FILE_STORES.codex, cwd, gate)
    }
    case 'pi':
      return newestFileSessionFor(join(homedir(), '.pi', 'agent', 'sessions'), FILE_STORES.pi, cwd, gate)
    case 'opencode':
      return newestOpencodeSessionFor(join(homedir(), '.local', 'share', 'opencode', 'opencode.db'), cwd, gate)
    case 'cursor':
      return newestCursorSessionFor(join(homedir(), '.cursor', 'chats'), cwd, gate)
    default:
      return null
  }
}
