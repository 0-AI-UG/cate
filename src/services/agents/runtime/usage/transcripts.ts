// Reading JSONL transcripts for usage, whatever the agent: a file is streamed
// a buffer at a time and fed to the agent's line parser. Transcripts are
// append-only, so a parse records the byte offset it stopped at and the
// parser's state there; a file that only grew resumes from that offset,
// guarded by a hash of the bytes before it (a rewritten file restarts from 0).

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AgentUsageLineParser, AgentUsageRecord } from '../sessions/types'

export interface TranscriptFile {
  path: string
  size: number
  mtimeMs: number
}

export interface TranscriptPosition {
  /** Byte offset just past the last newline-terminated line read. */
  offset: number
  /** Length and FNV-1a hash of the bytes ending at `offset`. */
  guardLength: number
  guardHash: number
  /** The parser's state at `offset`. */
  state: unknown
}

export interface TranscriptRead {
  /** Records of newline-terminated lines. */
  records: AgentUsageRecord[]
  /** Records of a last line the CLI has not finished: counted now, but read
   *  again by the next scan, so kept apart. */
  tailRecords: AgentUsageRecord[]
  position: TranscriptPosition
  resumed: boolean
}

export type CreateParser = (file: string, state?: unknown) => AgentUsageLineParser | null

export const GUARD_LENGTH = 64
const NEWLINE = 0x0a
const CARRIAGE_RETURN = 0x0d

function fnv1a(buffer: Buffer): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < buffer.length; i++) {
    hash ^= buffer[i]
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** The `.jsonl` files (or the basename `fileName`) under `root` changed at or
 *  after `sinceMs`. Entries that vanish mid-walk are skipped. */
export async function listTranscripts(root: string, sinceMs: number, fileName?: string): Promise<TranscriptFile[]> {
  const found: TranscriptFile[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(child)
        continue
      }
      if (fileName !== undefined ? entry.name !== fileName : !entry.name.endsWith('.jsonl')) continue
      try {
        const stats = await fs.stat(child)
        if (stats.mtimeMs >= sinceMs) found.push({ path: child, size: stats.size, mtimeMs: stats.mtimeMs })
      } catch {
        // Vanished between readdir and stat.
      }
    }
  }
  await walk(root)
  return found
}

async function guardMatches(handle: fs.FileHandle, position: TranscriptPosition): Promise<boolean> {
  if (position.guardLength <= 0 || position.guardLength > GUARD_LENGTH) return false
  try {
    const window = Buffer.alloc(position.guardLength)
    const { bytesRead } = await handle.read(window, 0, position.guardLength, position.offset - position.guardLength)
    return bytesRead === position.guardLength && fnv1a(window) === position.guardHash
  } catch {
    return false
  }
}

/** The usage records of one transcript, or null when it could not be read
 *  (which must not be cached as an empty transcript). */
export async function readTranscript(file: string, createParser: CreateParser, resumeFrom?: TranscriptPosition): Promise<TranscriptRead | null> {
  let handle: fs.FileHandle
  try {
    handle = await fs.open(file, 'r')
  } catch {
    return null
  }
  try {
    let parser: AgentUsageLineParser | null = null
    let start = 0
    if (resumeFrom && resumeFrom.offset > 0 && await guardMatches(handle, resumeFrom)) {
      parser = createParser(file, resumeFrom.state)
      if (parser) start = resumeFrom.offset
    }
    parser ??= createParser(file)
    if (!parser) return null
    const resumed = start > 0
    const toText = (buffer: Buffer): string =>
      (buffer.length > 0 && buffer[buffer.length - 1] === CARRIAGE_RETURN ? buffer.subarray(0, -1) : buffer).toString('utf8')

    const records: AgentUsageRecord[] = []
    let offset = start
    let pending: Buffer[] = []
    for await (const chunk of handle.createReadStream({ start, autoClose: false }) as AsyncIterable<Buffer>) {
      if (!chunk.includes(NEWLINE)) {
        pending.push(chunk)
        continue
      }
      // Line splitting on bytes: resuming needs byte-exact offsets.
      const buffer = pending.length === 0 ? chunk : Buffer.concat([...pending, chunk])
      pending = []
      let lineStart = 0
      for (;;) {
        const newline = buffer.indexOf(NEWLINE, lineStart)
        if (newline === -1) break
        records.push(...parser.line(toText(buffer.subarray(lineStart, newline))))
        lineStart = newline + 1
      }
      offset += lineStart
      if (lineStart < buffer.length) pending.push(buffer.subarray(lineStart))
    }

    const state = parser.state()
    let tailRecords: AgentUsageRecord[] = []
    const tail = pending.length === 0 ? null : Buffer.concat(pending)
    // A copy of the parser reads the unfinished line, so `state` stays at `offset`.
    if (tail && tail.length > 0) tailRecords = createParser(file, state)?.line(toText(tail)) ?? []

    const guardLength = Math.min(GUARD_LENGTH, offset)
    let guardHash = 0
    if (guardLength > 0) {
      const window = Buffer.alloc(guardLength)
      await handle.read(window, 0, guardLength, offset - guardLength)
      guardHash = fnv1a(window)
    }
    return { records, tailRecords, position: { offset, guardLength, guardHash, state }, resumed }
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}
