// =============================================================================
// Agent session probe — fixture-backed unit tests. The LIVE counterparts of
// these fixtures (what the real CLIs write) are pinned by
// agentSessionContracts.itest.ts; here we pin the probe's own behavior.
//
// The load-bearing cases are the OFFSET regressions: every CLI persists its
// session lazily, so a freshly-launched agent must probe to its EXACT current
// session (claude registry / codex held fd) or to NOTHING (start-time gate) —
// never to the previous session in the same cwd, which is what "newest stored
// session" alone returns.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { closeSync, mkdtempSync, mkdirSync, openSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FILE_STORES,
  claudeRegistrySession,
  codexOpenRolloutSession,
  newestCursorSessionFor,
  newestFileSessionFor,
  newestOpencodeSessionFor,
  probeSessionForAgent,
  startTimeForPid,
} from './agentSessions'

let root: string
beforeEach(() => {
  // realpath: the fd-scan test compares against lsof output, which reports
  // fully-resolved paths (/private/var vs /var on macOS).
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-sessions-test-')))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Write a file and pin its mtime (seconds since epoch) so newest-wins
 *  ordering and the start-time gate are deterministic. */
function writeStamped(relPath: string, content: string, mtimeSec: number): void {
  const p = join(root, relPath)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
  utimesSync(p, mtimeSec, mtimeSec)
}

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'
const claudeLine = (sessionId: string, cwd: string): string =>
  JSON.stringify({ type: 'user', sessionId, cwd, message: {} }) + '\n'

describe('claude registry (exact pid signal)', () => {
  it('returns the registry session even when an older session file has a newer mtime', async () => {
    // THE reported offset: previous session A freshly touched, current session
    // B (registry) — the registry must win over mtime ordering.
    writeStamped(`projects/p/${UUID_A}.jsonl`, claudeLine(UUID_A, '/work/app'), 2000)
    writeStamped(`projects/p/${UUID_B}.jsonl`, claudeLine(UUID_B, '/work/app'), 1000)
    writeStamped('sessions/123.json', JSON.stringify({ pid: 123, sessionId: UUID_B, cwd: '/work/app' }), 3000)
    await expect(
      claudeRegistrySession(join(root, 'sessions'), join(root, 'projects'), 123),
    ).resolves.toBe(UUID_B)
  })

  it('returns null (NOT the previous session) when the registry session has no transcript yet', async () => {
    // Fresh claude, nothing prompted: registry knows the new id but no
    // transcript exists. Stamping the previous session here was the bug.
    writeStamped(`projects/p/${UUID_A}.jsonl`, claudeLine(UUID_A, '/work/app'), 2000)
    writeStamped('sessions/123.json', JSON.stringify({ pid: 123, sessionId: UUID_B, cwd: '/work/app' }), 3000)
    await expect(
      claudeRegistrySession(join(root, 'sessions'), join(root, 'projects'), 123),
    ).resolves.toBeNull()
  })

  it('falls back (undefined) when the registry has no usable entry for the pid', async () => {
    await expect(
      claudeRegistrySession(join(root, 'sessions'), join(root, 'projects'), 123),
    ).resolves.toBeUndefined()
    // A stale file from a RE-USED pid whose recorded pid disagrees is not trusted.
    writeStamped('sessions/123.json', JSON.stringify({ pid: 999, sessionId: UUID_B }), 1000)
    await expect(
      claudeRegistrySession(join(root, 'sessions'), join(root, 'projects'), 123),
    ).resolves.toBeUndefined()
    writeStamped('sessions/124.json', 'partial-write{', 1000)
    await expect(
      claudeRegistrySession(join(root, 'sessions'), join(root, 'projects'), 124),
    ).resolves.toBeUndefined()
  })
})

describe('codex held-rollout (exact pid signal)', () => {
  it.skipIf(process.platform === 'win32')('resolves the rollout THIS process holds open', async () => {
    const rel = `2026/07/18/rollout-2026-07-18-${UUID_A}.jsonl`
    writeStamped(rel, '{}', 1000)
    const fd = openSync(join(root, rel), 'r')
    try {
      await expect(codexOpenRolloutSession(root, process.pid)).resolves.toBe(UUID_A)
    } finally {
      closeSync(fd)
    }
  })

  it.skipIf(process.platform === 'win32')('is undefined when no rollout under the root is held', async () => {
    writeStamped(`2026/rollout-x-${UUID_A}.jsonl`, '{}', 1000) // exists but not open
    await expect(codexOpenRolloutSession(root, process.pid)).resolves.toBeUndefined()
  })
})

describe('file stores + start-time gate', () => {
  it('returns the newest session whose cwd matches', () => {
    writeStamped(`p/${UUID_A}.jsonl`, claudeLine(UUID_A, '/work/app'), 1000)
    writeStamped(`p/${UUID_B}.jsonl`, claudeLine(UUID_B, '/work/app'), 2000)
    return expect(newestFileSessionFor(root, FILE_STORES['claude-code'], '/work/app')).resolves.toBe(UUID_B)
  })

  it('skips newer sessions belonging to other cwds', () => {
    writeStamped(`pa/${UUID_A}.jsonl`, claudeLine(UUID_A, '/work/app'), 1000)
    writeStamped(`pb/${UUID_B}.jsonl`, claudeLine(UUID_B, '/work/other'), 2000)
    return expect(newestFileSessionFor(root, FILE_STORES['claude-code'], '/work/app')).resolves.toBe(UUID_A)
  })

  it('OFFSET REGRESSION: a session untouched since the agent started is not returned', async () => {
    // pi/fallback path: only session on disk is the PREVIOUS one (mtime 1000s),
    // the agent started at 2000s → nothing to resume, NOT the old session.
    writeStamped(`p/${UUID_A}.jsonl`, claudeLine(UUID_A, '/work/app'), 1000)
    await expect(
      newestFileSessionFor(root, FILE_STORES['claude-code'], '/work/app', 2000_000),
    ).resolves.toBeNull()
    // A session written after the agent started passes the gate.
    writeStamped(`p/${UUID_B}.jsonl`, claudeLine(UUID_B, '/work/app'), 3000)
    await expect(
      newestFileSessionFor(root, FILE_STORES['claude-code'], '/work/app', 2000_000),
    ).resolves.toBe(UUID_B)
  })

  it('tolerates malformed leading lines and ignores non-session files', async () => {
    writeStamped(
      `p/${UUID_A}.jsonl`,
      'not-json\n' + JSON.stringify({ type: 'summary' }) + '\n' + claudeLine(UUID_A, '/work/app'),
      1000,
    )
    writeStamped('p/notes.jsonl', claudeLine(UUID_B, '/work/app'), 2000)
    await expect(newestFileSessionFor(root, FILE_STORES['claude-code'], '/work/app')).resolves.toBe(UUID_A)
  })

  it('degrades to null when the store root does not exist', () => {
    return expect(
      newestFileSessionFor(join(root, 'missing'), FILE_STORES['claude-code'], '/work/app'),
    ).resolves.toBeNull()
  })

  it('codex: reads id + cwd from the rollout meta line (both id key variants)', async () => {
    writeStamped(
      `2026/rollout-a-${UUID_A}.jsonl`,
      JSON.stringify({ payload: { id: UUID_A, cwd: '/work/app' } }) + '\n',
      1000,
    )
    writeStamped(
      `2026/rollout-b-${UUID_B}.jsonl`,
      JSON.stringify({ payload: { session_id: UUID_B, cwd: '/work/app' } }) + '\n',
      2000,
    )
    await expect(newestFileSessionFor(root, FILE_STORES.codex, '/work/app')).resolves.toBe(UUID_B)
  })

  it('pi: reads id + cwd from the first line', () => {
    writeStamped(
      `--work-app--/2026-01-01T00-00-00-000Z_${UUID_A}.jsonl`,
      JSON.stringify({ type: 'session', version: 3, id: UUID_A, cwd: '/work/app' }) + '\n',
      1000,
    )
    return expect(newestFileSessionFor(root, FILE_STORES.pi, '/work/app')).resolves.toBe(UUID_A)
  })
})

describe('opencode sqlite store', () => {
  async function makeDb(rows: [string, string, number][]): Promise<string> {
    const { DatabaseSync } = await import('node:sqlite')
    const dbPath = join(root, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_updated INTEGER NOT NULL)')
    const ins = db.prepare('INSERT INTO session (id, directory, time_updated) VALUES (?, ?, ?)')
    for (const r of rows) ins.run(...r)
    db.close()
    return dbPath
  }

  it('returns the newest row for the directory, gated by the agent start time', async () => {
    const dbPath = await makeDb([
      ['ses_old', '/work/app', 1000],
      ['ses_new', '/work/app', 2000],
      ['ses_other', '/work/other', 3000],
    ])
    await expect(newestOpencodeSessionFor(dbPath, '/work/app')).resolves.toBe('ses_new')
    // OFFSET REGRESSION: rows older than the gate are invisible.
    await expect(newestOpencodeSessionFor(dbPath, '/work/app', 1500)).resolves.toBe('ses_new')
    await expect(newestOpencodeSessionFor(dbPath, '/work/app', 2500)).resolves.toBeNull()
  })

  it('degrades to null when the db is missing or unreadable', async () => {
    await expect(newestOpencodeSessionFor(join(root, 'missing.db'), '/work/app')).resolves.toBeNull()
    writeFileSync(join(root, 'garbage.db'), 'not a database')
    await expect(newestOpencodeSessionFor(join(root, 'garbage.db'), '/work/app')).resolves.toBeNull()
  })
})

describe('cursor chat store', () => {
  const CWD = '/work/app'
  const hash = createHash('md5').update(CWD).digest('hex')

  it('returns the newest chat under the md5(cwd) workspace dir, gated', async () => {
    writeStamped(`${hash}/${UUID_A}/store.db`, 'x', 1000)
    writeStamped(`${hash}/${UUID_B}/store.db`, 'x', 2000)
    writeStamped(`${hash}/not-a-chat.txt`, 'x', 3000) // tolerated non-chat entry
    await expect(newestCursorSessionFor(root, CWD)).resolves.toBe(UUID_B)
    // OFFSET REGRESSION: chats untouched since the agent started are invisible.
    await expect(newestCursorSessionFor(root, CWD, 2500_000)).resolves.toBeNull()
  })

  it('WAL REGRESSION: a live TUI writing store.db-wal counts as recency', async () => {
    // The store is WAL-mode sqlite: turns append to store.db-wal while
    // store.db itself keeps its old mtime until a checkpoint. Recency must be
    // the newest file in the chat dir, else a running chat looks stale.
    writeStamped(`${hash}/${UUID_A}/store.db`, 'x', 1000)
    writeStamped(`${hash}/${UUID_A}/store.db-wal`, 'x', 5000)
    await expect(newestCursorSessionFor(root, CWD, 3000_000)).resolves.toBe(UUID_A)
  })

  it('returns null for a cwd with no workspace dir', () => {
    return expect(newestCursorSessionFor(root, '/work/none')).resolves.toBeNull()
  })
})

describe('probeSessionForAgent', () => {
  it('probes to null for agents with no session-store adapter', async () => {
    const probe = { agentPid: 1, cwd: '/work/app', agentStartMs: null }
    await expect(probeSessionForAgent({ ...probe, agentId: 'antigravity' })).resolves.toBeNull()
    await expect(probeSessionForAgent({ ...probe, agentId: 'unknown-agent' })).resolves.toBeNull()
  })
})

describe('startTimeForPid', () => {
  it.skipIf(process.platform === 'win32')('resolves a plausible start time for this process', async () => {
    const start = await startTimeForPid(process.pid)
    expect(start).not.toBeNull()
    expect(start!).toBeGreaterThan(0)
    expect(start!).toBeLessThanOrEqual(Date.now())
    // This vitest worker started moments ago, not hours ago.
    expect(Date.now() - start!).toBeLessThan(30 * 60_000)
  })
})
