import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hermesSessionStore } from './hermes'
import type { AgentSessionContext } from './types'

const nodeSqliteAvailable = typeof process.getBuiltinModule === 'function'
  && process.getBuiltinModule('node:sqlite') !== undefined

const SESSION_ID = '20260928_101500_a1b2c3'
let homeDir = ''
const databases: Array<InstanceType<typeof import('node:sqlite').DatabaseSync>> = []

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'cate-hermes-session-'))
})

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await rm(homeDir, { recursive: true, force: true })
})

function context(profile?: string, sessionId = SESSION_ID): AgentSessionContext {
  return { session: { agentId: 'hermes', sessionId, profile }, homeDir }
}

/** A subset of Hermes's schema v30 state.db (sessions + messages). */
async function createDatabase(dir: string, legacy = false) {
  const { DatabaseSync } = await import('node:sqlite')
  await mkdir(dir, { recursive: true })
  const database = new DatabaseSync(path.join(dir, 'state.db'))
  databases.push(database)
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, title_source TEXT);
    ${legacy
      ? `CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
           timestamp REAL, active INTEGER DEFAULT 1);`
      : `CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
           timestamp REAL, active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0,
           _compressed_summary INTEGER DEFAULT 0, display_kind TEXT, display_metadata TEXT, display_order INTEGER);`}
  `)
  return database
}

describe.runIf(nodeSqliteAvailable)('Hermes session title', () => {
  it('reads sessions.title from the default profile store', async () => {
    const db = await createDatabase(path.join(homeDir, '.hermes'))
    db.prepare('INSERT INTO sessions (id, title, title_source) VALUES (?, ?, ?)').run(SESSION_ID, 'Refactor hooks', 'llm')
    db.prepare('INSERT INTO sessions (id, title, title_source) VALUES (?, ?, ?)').run('other', 'Other', 'llm')

    await expect(hermesSessionStore.title(context())).resolves.toBe('Refactor hooks')
    await expect(hermesSessionStore.title(context('default'))).resolves.toBe('Refactor hooks')
  })

  it('resolves named profiles under ~/.hermes/profiles and rejects custom or unsafe profiles', async () => {
    const db = await createDatabase(path.join(homeDir, '.hermes', 'profiles', 'work'))
    db.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run(SESSION_ID, 'Work chat')

    await expect(hermesSessionStore.title(context('work'))).resolves.toBe('Work chat')
    await expect(hermesSessionStore.title(context('custom'))).resolves.toBeNull()
    await expect(hermesSessionStore.title(context('../work'))).resolves.toBeNull()
  })

  it('returns null for blank titles, unknown sessions, and a missing store', async () => {
    await expect(hermesSessionStore.title(context())).resolves.toBeNull()
    const db = await createDatabase(path.join(homeDir, '.hermes'))
    db.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run(SESSION_ID, '  ')
    await expect(hermesSessionStore.title(context())).resolves.toBeNull()
    await expect(hermesSessionStore.title(context(undefined, 'missing'))).resolves.toBeNull()
  })
})

describe.runIf(nodeSqliteAvailable)('Hermes session conversation', () => {
  it('follows Hermes display history: order, compaction dedupe, and hidden rows', async () => {
    const db = await createDatabase(path.join(homeDir, '.hermes'))
    // Content goes in as bytes so the NUL of `\x00json:` survives, as Hermes (Python) writes it.
    const insert = db.prepare(`INSERT INTO messages
      (session_id, role, content, timestamp, active, compacted, _compressed_summary, display_kind, display_metadata, display_order)
      VALUES (?, ?, CAST(? AS TEXT), ?, ?, ?, ?, ?, ?, ?)`)
    const row = (role: string, content: string, order: number, extra: Partial<{
      active: number; compacted: number; summary: number; kind: string | null; metadata: string | null; timestamp: number; session: string
    }> = {}) => insert.run(extra.session ?? SESSION_ID, role, Buffer.from(content), extra.timestamp ?? 1790590000 + order, extra.active ?? 1,
      extra.compacted ?? 0, extra.summary ?? 0, extra.kind ?? null, extra.metadata ?? null, order)

    row('user', 'Fix the hooks', 1)
    row('assistant', '', 2) // tool-call-only turn
    row('tool', 'tool output', 3)
    row('assistant', 'stale copy', 4, { active: 0, compacted: 1 })
    row('assistant', 'Fixed the hooks', 4)
    row('user', '[System: context refresh]', 5)
    row('user', 'continue', 6, { kind: 'auto_continue' })
    row('assistant', 'hidden', 7, { kind: 'hidden' })
    row('assistant', 'model only', 8, { metadata: JSON.stringify({ model_only: true }) })
    row('assistant', 'summary', 9, { summary: 1 })
    row('user', `\x00json:${JSON.stringify([{ type: 'text', text: 'Now ' }, 'add tests'])}`, 10, { kind: 'skill_invocation' })
    row('assistant', 'Archived but shown', 11, { active: 0, compacted: 1 })
    row('assistant', 'dropped', 12, { active: 0 })
    row('user', 'other session', 13, { session: 'other' })

    await expect(hermesSessionStore.conversation(context())).resolves.toEqual([
      { role: 'user', text: 'Fix the hooks', createdAt: new Date((1790590000 + 1) * 1000).toISOString() },
      { role: 'assistant', text: 'Fixed the hooks', createdAt: new Date((1790590000 + 4) * 1000).toISOString() },
      { role: 'user', text: 'Now add tests', createdAt: new Date((1790590000 + 10) * 1000).toISOString() },
      { role: 'assistant', text: 'Archived but shown', createdAt: new Date((1790590000 + 11) * 1000).toISOString() },
    ])
  })

  it('falls back to live rows in id order for stores without display columns', async () => {
    const db = await createDatabase(path.join(homeDir, '.hermes'), true)
    const insert = db.prepare('INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, ?, ?, ?, ?)')
    insert.run(SESSION_ID, 'user', 'Hi', 1790590001, 1)
    insert.run(SESSION_ID, 'assistant', 'old', 1790590002, 0)
    insert.run(SESSION_ID, 'assistant', 'Hello', 1790590003, 1)

    const messages = await hermesSessionStore.conversation(context())
    expect(messages?.map(({ role, text }) => [role, text])).toEqual([['user', 'Hi'], ['assistant', 'Hello']])
  })

  it('returns null without a resolvable store', async () => {
    await expect(hermesSessionStore.conversation(context())).resolves.toBeNull()
    await expect(hermesSessionStore.conversation(context('custom'))).resolves.toBeNull()
  })
})
