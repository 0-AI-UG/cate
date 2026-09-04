import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentHookEvent } from '../../../shared/agentHooks'
import { resolveOpenCodeTitle } from './opencode'

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

function event(sessionId: string | null = 'ses_target'): AgentHookEvent {
  return {
    terminalId: 'pty-1',
    agentId: 'opencode',
    kind: 'turn-end',
    sessionId,
    raw: {},
  }
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

describe.runIf(nodeSqliteAvailable)('resolveOpenCodeTitle', () => {
  it('reads OpenCode 1.18.3 session.title by primary-key session id', async () => {
    // Pinned from 1.18.3 packages/core/src/session/sql.ts. Release builds keep
    // the live SQLite store at ~/.local/share/opencode/opencode.db.
    const db = await createDatabase()
    const insert = db.prepare('INSERT INTO session (id, title, time_updated) VALUES (?, ?, ?)')
    insert.run('ses_other', 'Other chat', 1)
    insert.run('ses_target', 'Automatic terminal titles', 2)

    await expect(resolveOpenCodeTitle({ event: event(), homeDir }))
      .resolves.toBe('Automatic terminal titles')
  })

  it('reads the latest in-place title update from OpenCode\'s live WAL store', async () => {
    const db = await createDatabase()
    db.prepare('INSERT INTO session (id, title, time_updated) VALUES (?, ?, ?)')
      .run('ses_target', 'New session - 2026-09-03T10:00:00.000Z', 1)

    await expect(resolveOpenCodeTitle({ event: event(), homeDir }))
      .resolves.toBe('New session - 2026-09-03T10:00:00.000Z')

    db.prepare('UPDATE session SET title = ?, time_updated = ? WHERE id = ?')
      .run('Generated chat title', 2, 'ses_target')

    await expect(resolveOpenCodeTitle({ event: event(), homeDir }))
      .resolves.toBe('Generated chat title')
  })

  it('returns null for absent sessions, blank titles, and unavailable state', async () => {
    await expect(resolveOpenCodeTitle({ event: event(null), homeDir })).resolves.toBeNull()
    await expect(resolveOpenCodeTitle({ event: event(), homeDir })).resolves.toBeNull()

    const db = await createDatabase()
    db.prepare('INSERT INTO session (id, title, time_updated) VALUES (?, ?, ?)')
      .run('ses_target', '   ', 1)

    await expect(resolveOpenCodeTitle({ event: event(), homeDir })).resolves.toBeNull()
    await expect(resolveOpenCodeTitle({ event: event('ses_missing'), homeDir })).resolves.toBeNull()
  })
})
