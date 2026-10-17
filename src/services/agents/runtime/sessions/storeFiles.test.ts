import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withReadOnlySqlite } from './storeFiles'

const nodeSqliteAvailable = typeof process.getBuiltinModule === 'function'
  && process.getBuiltinModule('node:sqlite') !== undefined

let dir = ''
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'cate-store-files-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe.skipIf(!nodeSqliteAvailable)('withReadOnlySqlite', () => {
  it('fails fast on a locked store instead of blocking the daemon event loop', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const file = path.join(dir, 'state.db')
    const writer = new DatabaseSync(file)
    writer.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1); BEGIN EXCLUSIVE; INSERT INTO t VALUES (2);')
    try {
      const started = performance.now()
      const result = await withReadOnlySqlite(file, (database) => database.prepare('SELECT count(*) AS n FROM t').get())
      expect(result).toBeNull()
      expect(performance.now() - started).toBeLessThan(250)
    } finally {
      writer.exec('ROLLBACK')
      writer.close()
    }
  })
})
