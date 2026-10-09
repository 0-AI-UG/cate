import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openCodeSessionStore } from './opencode'
import type { AgentSessionContext } from './types'

const nodeSqliteAvailable = typeof process.getBuiltinModule === 'function'
  && process.getBuiltinModule('node:sqlite') !== undefined

let homeDir = ''
let database: InstanceType<typeof import('node:sqlite').DatabaseSync> | null = null

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'cate-opencode-title-'))
})

afterEach(async () => {
  database?.close()
  database = null
  await rm(homeDir, { recursive: true, force: true })
})

function context(sessionId: string | null = 'ses_target'): AgentSessionContext {
  return { session: { agentId: 'opencode', sessionId: sessionId ?? '' }, homeDir }
}

async function createDatabase(): Promise<NonNullable<typeof database>> {
  const { DatabaseSync } = await import('node:sqlite')
  const dataDir = path.join(homeDir, '.local', 'share', 'opencode')
  await mkdir(dataDir, { recursive: true })
  database = new DatabaseSync(path.join(dataDir, 'opencode.db'))
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      time_updated INTEGER NOT NULL
    );
  `)
  return database
}

describe.runIf(nodeSqliteAvailable)('OpenCode session title', () => {
  it('reads OpenCode 1.18.3 session.title by primary-key session id', async () => {
    // Pinned from 1.18.3 packages/core/src/session/sql.ts. Release builds keep
    // the live SQLite store at ~/.local/share/opencode/opencode.db.
    const db = await createDatabase()
    const insert = db.prepare('INSERT INTO session (id, title, time_updated) VALUES (?, ?, ?)')
    insert.run('ses_other', 'Other chat', 1)
    insert.run('ses_target', 'Automatic terminal titles', 2)

    await expect(openCodeSessionStore.title(context()))
      .resolves.toBe('Automatic terminal titles')
  })

  it('reads the latest in-place title update from OpenCode\'s live WAL store', async () => {
    const db = await createDatabase()
    db.prepare('INSERT INTO session (id, title, time_updated) VALUES (?, ?, ?)')
      .run('ses_target', 'New session - 2026-09-03T10:00:00.000Z', 1)

    await expect(openCodeSessionStore.title(context()))
      .resolves.toBe('New session - 2026-09-03T10:00:00.000Z')

    db.prepare('UPDATE session SET title = ?, time_updated = ? WHERE id = ?')
      .run('Generated chat title', 2, 'ses_target')

    await expect(openCodeSessionStore.title(context()))
      .resolves.toBe('Generated chat title')
  })

  it('returns null for absent sessions, blank titles, and unavailable state', async () => {
    await expect(openCodeSessionStore.title(context(null))).resolves.toBeNull()
    await expect(openCodeSessionStore.title(context())).resolves.toBeNull()

    const db = await createDatabase()
    db.prepare('INSERT INTO session (id, title, time_updated) VALUES (?, ?, ?)')
      .run('ses_target', '   ', 1)

    await expect(openCodeSessionStore.title(context())).resolves.toBeNull()
    await expect(openCodeSessionStore.title(context('ses_missing'))).resolves.toBeNull()
  })
})

async function createConversationDatabase(withSessionMessage = true): Promise<NonNullable<typeof database>> {
  const db = await createDatabase()
  db.exec(`
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `)
  if (withSessionMessage) {
    db.exec('CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);')
  }
  return db
}

describe.runIf(nodeSqliteAvailable)('OpenCode session conversation', () => {
  it('joins text parts per message in id order, skipping synthetic, ignored, and non-text parts', async () => {
    // Pinned against OpenCode 1.18.30: message.data.role + part.data.type.
    const db = await createConversationDatabase()
    const message = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
    const part = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
    message.run('msg_002', 'ses_target', 1789119601000, 0, JSON.stringify({ role: 'assistant' }))
    message.run('msg_001', 'ses_target', 1789119600864, 0, JSON.stringify({ role: 'user' }))
    message.run('msg_003', 'ses_other', 1789119602000, 0, JSON.stringify({ role: 'user' }))
    message.run('msg_004', 'ses_target', 1789119603000, 0, JSON.stringify({ role: 'assistant', error: { name: 'Auth' } }))
    part.run('prt_001', 'msg_001', 'ses_target', 0, 0, JSON.stringify({ type: 'text', text: 'Fix the bug' }))
    part.run('prt_002', 'msg_001', 'ses_target', 0, 0, JSON.stringify({ type: 'text', text: 'The following tool was executed by the user', synthetic: true }))
    part.run('prt_003', 'msg_002', 'ses_target', 0, 0, JSON.stringify({ type: 'reasoning', text: 'thinking' }))
    part.run('prt_004', 'msg_002', 'ses_target', 0, 0, JSON.stringify({ type: 'text', text: 'Done, ' }))
    part.run('prt_005', 'msg_002', 'ses_target', 0, 0, JSON.stringify({ type: 'tool', tool: 'edit' }))
    part.run('prt_006', 'msg_002', 'ses_target', 0, 0, JSON.stringify({ type: 'text', text: 'fixed.' }))
    part.run('prt_007', 'msg_002', 'ses_target', 0, 0, JSON.stringify({ type: 'text', text: 'ignored', ignored: true }))
    part.run('prt_008', 'msg_003', 'ses_other', 0, 0, JSON.stringify({ type: 'text', text: 'other session' }))

    await expect(openCodeSessionStore.conversation(context())).resolves.toEqual([
      { role: 'user', text: 'Fix the bug', createdAt: new Date(1789119600864).toISOString() },
      { role: 'assistant', text: 'Done, fixed.', createdAt: new Date(1789119601000).toISOString() },
    ])
  })

  it('falls back to session_message rows ordered by seq', async () => {
    const db = await createConversationDatabase()
    const row = db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)')
    row.run('b', 'ses_target', 'assistant', 2, 1789119602000, JSON.stringify({ content: [{ type: 'text', text: 'Hello' }, { type: 'tool', tool: 'x' }] }))
    row.run('a', 'ses_target', 'user', 1, 1789119601000, JSON.stringify({ text: 'Hi' }))
    row.run('c', 'ses_target', 'system', 3, 1789119603000, JSON.stringify({ text: 'system' }))

    await expect(openCodeSessionStore.conversation(context())).resolves.toEqual([
      { role: 'user', text: 'Hi', createdAt: new Date(1789119601000).toISOString() },
      { role: 'assistant', text: 'Hello', createdAt: new Date(1789119602000).toISOString() },
    ])
  })

  it('returns an empty conversation without messages and null without a store', async () => {
    await expect(openCodeSessionStore.conversation(context())).resolves.toBeNull()
    await createConversationDatabase(false)
    await expect(openCodeSessionStore.conversation(context())).resolves.toEqual([])
  })
})
