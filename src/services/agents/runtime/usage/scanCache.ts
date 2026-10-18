// The per-file scan cache: an unchanged transcript yields the same records, so
// they are kept by `(size, mtime)` across scans and restarts. Per file rather
// than per day, so the reporting zone never invalidates it.

import path from 'node:path'
import { isAgentId, type AgentId } from '../../contract'
import type { AgentUsageRecord } from '../sessions/types'
import { GUARD_LENGTH, type TranscriptPosition } from './transcripts'

export const SCAN_CACHE_VERSION = 1

export interface CachedTranscript {
  size: number
  mtimeMs: number
  agent: AgentId
  records: AgentUsageRecord[]
  tailRecords: AgentUsageRecord[]
  position: TranscriptPosition
}

export type ScanCache = Map<string, CachedTranscript>

/** Positional rows with interned strings keep the file small. */
type Row = [timestampMs: number, model: number, session: number, cwd: number, uncached: number, cached: number, cacheCreation: number, output: number, reasoning: number, dedupeKey: string | null, reportedCostUsd: number | null]

interface SerializedFile {
  s: number
  m: number
  a: AgentId
  r: Row[]
  t: Row[]
  o: number
  gl: number
  gh: number
  st: unknown
}

interface SerializedCache {
  version: number
  strings: string[]
  files: Record<string, SerializedFile>
}

export function encodeScanCache(cache: ScanCache): SerializedCache {
  const strings: string[] = []
  const index = new Map<string, number>()
  const intern = (value: string): number => {
    let at = index.get(value)
    if (at === undefined) {
      at = strings.length
      strings.push(value)
      index.set(value, at)
    }
    return at
  }
  const row = (r: AgentUsageRecord): Row => [
    r.timestampMs, intern(r.model), intern(r.sessionId), r.cwd === null ? -1 : intern(r.cwd),
    r.totals.uncachedInputTokens, r.totals.cachedInputTokens, r.totals.cacheCreationTokens, r.totals.outputTokens, r.totals.reasoningTokens,
    r.dedupeKey, r.reportedCostUsd,
  ]
  const files: Record<string, SerializedFile> = {}
  for (const [file, entry] of cache) {
    files[file] = {
      s: entry.size, m: entry.mtimeMs, a: entry.agent, r: entry.records.map(row), t: entry.tailRecords.map(row),
      o: entry.position.offset, gl: entry.position.guardLength, gh: entry.position.guardHash, st: entry.position.state,
    }
  }
  return { version: SCAN_CACHE_VERSION, strings, files }
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Anything malformed costs a fresh parse, never a broken scan. A corrupt row
 *  drops its whole entry (the survivors would read as a valid warm hit). The
 *  parser state is the agent's to validate when it resumes. */
export function decodeScanCache(document: unknown): ScanCache {
  const cache: ScanCache = new Map()
  const root = document as Partial<SerializedCache> | null
  if (!root || typeof root !== 'object' || root.version !== SCAN_CACHE_VERSION || !root.files || typeof root.files !== 'object') return cache
  if (!Array.isArray(root.strings) || !root.strings.every((v) => typeof v === 'string')) return cache
  const strings = root.strings as string[]
  const text = (at: unknown): string | undefined => typeof at === 'number' ? strings[at] : undefined

  const rows = (raw: unknown): AgentUsageRecord[] | null => {
    if (!Array.isArray(raw)) return null
    const out: AgentUsageRecord[] = []
    for (const r of raw) {
      if (!Array.isArray(r) || r.length < 11) return null
      const [timestampMs, model, session, cwd, uncached, cached, cacheCreation, output, reasoning, dedupeKey, cost] = r as Row
      const modelName = text(model)
      if (!finite(timestampMs) || modelName === undefined || ![uncached, cached, cacheCreation, output, reasoning].every(finite)) return null
      out.push({
        timestampMs, model: modelName, sessionId: text(session) ?? '', cwd: cwd === -1 ? null : text(cwd) ?? null,
        totals: { uncachedInputTokens: uncached, cachedInputTokens: cached, cacheCreationTokens: cacheCreation, outputTokens: output, reasoningTokens: reasoning },
        dedupeKey: typeof dedupeKey === 'string' ? dedupeKey : null,
        reportedCostUsd: typeof cost === 'number' ? cost : null,
      })
    }
    return out
  }

  for (const [file, raw] of Object.entries(root.files)) {
    const e = raw as Partial<SerializedFile> | null
    if (!e || !finite(e.s) || !finite(e.m) || !isAgentId(e.a)) continue
    // Position fields feed byte offsets and a buffer allocation in the reader.
    if (!Number.isSafeInteger(e.o) || e.o! < 0 || !Number.isSafeInteger(e.gl) || e.gl! < 0 || e.gl! > GUARD_LENGTH || e.gl! > e.o! || !finite(e.gh)) continue
    const records = rows(e.r)
    const tailRecords = rows(e.t)
    if (!records || !tailRecords) continue
    cache.set(file, { size: e.s, mtimeMs: e.m, agent: e.a, records, tailRecords, position: { offset: e.o!, guardLength: e.gl!, guardHash: e.gh, state: e.st } })
  }
  return cache
}

/** Drops entries past retention, and files that disappeared inside the walked
 *  window (absence outside it proves nothing: a 7-day walk must not evict the
 *  30-day entries). Returns how many went. */
export function pruneScanCache(cache: ScanCache, options: { livePaths: ReadonlySet<string>; walkedRoots: readonly string[]; windowStartMs: number; retentionCutoffMs: number }): number {
  let removed = 0
  for (const [file, entry] of cache) {
    const underWalkedRoot = options.walkedRoots.some((root) => {
      const relative = path.relative(root, file)
      return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    })
    const deleted = underWalkedRoot && entry.mtimeMs >= options.windowStartMs && !options.livePaths.has(file)
    if (entry.mtimeMs < options.retentionCutoffMs || deleted) {
      cache.delete(file)
      removed++
    }
  }
  return removed
}

/** Drops repeats within one file before it is cached; one `seen` set spans the
 *  batches of a resumed parse. */
export function dedupeWithinFile(records: readonly AgentUsageRecord[], seen: Set<string> = new Set()): AgentUsageRecord[] {
  return records.filter((r) => {
    if (r.dedupeKey === null) return true
    if (seen.has(r.dedupeKey)) return false
    seen.add(r.dedupeKey)
    return true
  })
}
