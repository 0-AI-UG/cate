import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'

/** A session id safe to use as a path segment. */
export const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/

export const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

export async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/** Visit every complete JSON record of a JSONL session file in file order.
 *  Streams (Codex rollouts reach hundreds of MB with multi-MB lines) and skips
 *  unparseable lines, including the final line a CLI may still be appending.
 *  Resolves false when the file cannot be read. */
export async function forEachJsonlRecord(
  file: string,
  visit: (record: Record<string, unknown>) => void,
): Promise<boolean> {
  try {
    await stat(file)
  } catch {
    return false
  }
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line) continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record && typeof record === 'object' && !Array.isArray(record)) {
        visit(record as Record<string, unknown>)
      }
    }
    return true
  } catch {
    return false
  } finally {
    lines.close()
  }
}

/** Visit each `<root>/<workspace key>` dir of a CLI that buckets sessions by a
 *  per-workspace key, until `visit` yields a value. Null for an unsafe id. */
export async function firstInWorkspaceBuckets<T>(
  root: string,
  sessionId: string,
  visit: (bucketDir: string) => Promise<T | null>,
): Promise<T | null> {
  if (!SAFE_SESSION_ID.test(sessionId)) return null
  let buckets
  try {
    buckets = await readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    const found = await visit(path.join(root, bucket.name))
    if (found !== null) return found
  }
  return null
}

/** The first existing `<root>/<any workspace key>/<rel>`. */
export function findInWorkspaceBuckets(root: string, sessionId: string, rel: string): Promise<string | null> {
  return firstInWorkspaceBuckets(root, sessionId, async (bucketDir) => {
    const candidate = path.join(bucketDir, rel)
    return await exists(candidate) ? candidate : null
  })
}

/** Run one read against a CLI's SQLite store, opened read-only and closed
 *  immediately. WAL stores are safe to read concurrently with their writer;
 *  a busy, missing, or schema-changed store resolves null. No busy timeout:
 *  DatabaseSync would block the daemon's event loop (PTY I/O) while waiting. */
export async function withReadOnlySqlite<T>(
  file: string,
  read: (database: import('node:sqlite').DatabaseSync) => T,
): Promise<T | null> {
  try {
    await stat(file)
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(file, { readOnly: true })
    try {
      return read(database)
    } finally {
      database.close()
    }
  } catch {
    return null
  }
}

/** Epoch milliseconds or seconds (or an ISO string) as an ISO timestamp. */
export function isoTimestamp(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return new Date(value < 1e12 ? value * 1_000 : value).toISOString()
}
