import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { AgentConversationMessage } from '../../contract'
import { recordedCost, tokenCount, totalTokens } from '../usage/records'
import { isoTimestamp, withReadOnlySqlite } from './storeFiles'
import type { AgentSessionContext, AgentSessionStore, AgentUsage, AgentUsageRecord } from './types'

const SAFE_PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

/**
 * Hermes Agent 2026.9.24 (state.db schema v30) keeps one SQLite store per
 * profile: `~/.hermes/state.db` for the default profile and
 * `~/.hermes/profiles/<name>/state.db` for a named one. The hook's `profile`
 * is Hermes's own profile name; `custom` means HERMES_HOME points elsewhere,
 * which cannot be derived, so it resolves no store.
 */
function databasePath(homeDir: string, profile: string | undefined): string | null {
  if (!profile || profile === 'default') return path.join(homeDir, '.hermes', 'state.db')
  if (profile === 'custom' || !SAFE_PROFILE_NAME.test(profile)) return null
  return path.join(homeDir, '.hermes', 'profiles', profile, 'state.db')
}

/**
 * `sessions.title` is written synchronously at the first turn (a derived
 * title) and upgraded asynchronously by an LLM title call; there is no title
 * hook, so the title tracker's post-hook retries pick up both.
 */
async function title({ session, homeDir }: AgentSessionContext): Promise<string | null> {
  const file = databasePath(homeDir, session.profile)
  if (!file || !session.sessionId) return null
  const row = await withReadOnlySqlite(file, (database) =>
    database.prepare('SELECT title FROM sessions WHERE id = ? LIMIT 1')
      .get(session.sessionId) as { title?: unknown } | undefined)
  return typeof row?.title === 'string' && row.title.trim() ? row.title : null
}

interface MessageRow {
  role: string
  content: unknown
  timestamp: unknown
  display_kind?: unknown
}

/** Mirrors Hermes's own display-history query: live rows plus rows archived by
 *  in-place compaction, deduplicated per `display_order` (highest `active`,
 *  then newest id), without hidden, model-only, or compression-summary rows. */
const DISPLAY_QUERY = `
  SELECT role, CAST(content AS BLOB) AS content, timestamp, display_kind FROM (
    SELECT m.*, ROW_NUMBER() OVER (PARTITION BY display_order ORDER BY active DESC, id DESC) AS rn
    FROM messages m
    WHERE session_id = ?
      AND (active = 1 OR compacted = 1)
      AND role IN ('user', 'assistant')
      AND _compressed_summary = 0
      AND COALESCE(display_kind, '') <> 'hidden'
      AND COALESCE(CASE WHEN json_valid(display_metadata)
                        THEN json_extract(display_metadata, '$.model_only') END, 0) = 0
  ) WHERE rn = 1
  ORDER BY display_order, id`

/** Stores that predate the display columns: live rows in insertion order
 *  (and, before in-place compaction existed, every row). */
const LEGACY_QUERIES = [
  `SELECT role, CAST(content AS BLOB) AS content, timestamp FROM messages
   WHERE session_id = ? AND active = 1 AND role IN ('user', 'assistant')
   ORDER BY id`,
  `SELECT role, CAST(content AS BLOB) AS content, timestamp FROM messages
   WHERE session_id = ? AND role IN ('user', 'assistant')
   ORDER BY id`,
]

/** User rows Hermes itself hides from history as machine-generated turns. */
const MACHINE_USER_KINDS = new Set([
  'auto_continue',
  'internal_notification',
  'model_switch',
  'personality_switch',
  'async_delegation_complete',
  'process_complete',
])

const CONTENT_JSON_PREFIX = '\x00json:'

/** Hermes stores list/multimodal content as `\x00json:` + JSON parts. It is
 *  read as a BLOB: Node 22's `node:sqlite` cuts TEXT off at the NUL byte. */
function contentText(raw: unknown): string {
  const content = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw
  if (typeof content !== 'string') return ''
  if (!content.startsWith(CONTENT_JSON_PREFIX)) return content
  let parts: unknown
  try {
    parts = JSON.parse(content.slice(CONTENT_JSON_PREFIX.length))
  } catch {
    return ''
  }
  if (typeof parts === 'string') return parts
  if (!Array.isArray(parts)) return ''
  return parts.map((part) => {
    if (typeof part === 'string') return part
    if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
      return (part as { text: string }).text
    }
    return ''
  }).join('')
}

/**
 * Messages live in `messages` (role, content, `timestamp` as epoch seconds).
 * `api_content` carries injected context (including Cate's prompt context),
 * so only `content` is read. `timestamp` is not monotonic, so order comes from
 * `display_order` / id. Tool, system and tool-call-only assistant rows are
 * skipped, as are `[System:` user rows and machine-generated user turns.
 */
async function conversation({ session, homeDir }: AgentSessionContext): Promise<AgentConversationMessage[] | null> {
  const file = databasePath(homeDir, session.profile)
  if (!file || !session.sessionId) return null
  const rows = await withReadOnlySqlite(file, (database) => {
    let lastError: unknown
    for (const query of [DISPLAY_QUERY, ...LEGACY_QUERIES]) {
      try {
        return database.prepare(query).all(session.sessionId) as unknown as MessageRow[]
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  })
  if (!rows) return null
  const messages: AgentConversationMessage[] = []
  for (const row of rows) {
    if (row.role !== 'user' && row.role !== 'assistant') continue
    const text = contentText(row.content)
    if (!text.trim()) continue
    if (row.role === 'user') {
      if (text.startsWith('[System:')) continue
      if (typeof row.display_kind === 'string' && MACHINE_USER_KINDS.has(row.display_kind)) continue
    }
    const createdAt = isoTimestamp(row.timestamp)
    messages.push({ role: row.role, text, ...(createdAt ? { createdAt } : {}) })
  }
  return messages
}

/** SQLite in WAL mode: a write lands in `-wal` first. */
const files = async ({ session, homeDir }: AgentSessionContext): Promise<string[]> => {
  const database = databasePath(homeDir, session.profile)
  return database ? [database, `${database}-wal`] : []
}

interface HermesUsageRow {
  session_id: string
  model: string
  task: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  estimated_cost_usd: number
  actual_cost_usd: number
  seen: number
  cwd: string | null
}

/**
 * Hermes (state.db v30) totals usage per session, model and task in
 * `session_model_usage` (`input_tokens` excludes the cache), with the
 * session's cwd on `sessions`. It keeps no per-turn rows, so a row lands on
 * its `last_seen` instant: a session that spans days counts on its last.
 */
export function hermesUsageRecord(row: HermesUsageRow, profile: string): AgentUsageRecord | null {
  const outputTokens = tokenCount(row.output_tokens)
  const totals = {
    uncachedInputTokens: tokenCount(row.input_tokens),
    cachedInputTokens: tokenCount(row.cache_read_tokens),
    cacheCreationTokens: tokenCount(row.cache_write_tokens),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(row.reasoning_tokens)),
  }
  if (!row.model || typeof row.seen !== 'number' || totalTokens(totals) === 0) return null
  return {
    timestampMs: row.seen * 1000,
    model: row.model,
    sessionId: row.session_id,
    cwd: row.cwd,
    totals,
    reportedCostUsd: recordedCost(row.actual_cost_usd, row.estimated_cost_usd),
    dedupeKey: `${profile}:${row.session_id}:${row.model}:${row.task}`,
  }
}

const USAGE_QUERY = `
  SELECT u.session_id, u.model, u.task, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens,
         u.reasoning_tokens, u.estimated_cost_usd, u.actual_cost_usd, COALESCE(u.last_seen, u.first_seen) AS seen, s.cwd
  FROM session_model_usage u LEFT JOIN sessions s ON s.id = u.session_id
  WHERE COALESCE(u.last_seen, u.first_seen, 0) * 1000 >= ?`

/** Every profile's store: the default and `profiles/<name>/state.db`. */
async function profiles(homeDir: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(homeDir, '.hermes', 'profiles'), { withFileTypes: true })
    return ['default', ...entries.filter((e) => e.isDirectory() && SAFE_PROFILE_NAME.test(e.name)).map((e) => e.name)]
  } catch {
    return ['default']
  }
}

const hermesUsage: AgentUsage = {
  source: {
    kind: 'store',
    location: (homeDir) => path.join(homeDir, '.hermes'),
    async records(homeDir, sinceMs) {
      const records: AgentUsageRecord[] = []
      for (const profile of await profiles(homeDir)) {
        const file = databasePath(homeDir, profile)
        const rows = file ? await withReadOnlySqlite(file, (database) => database.prepare(USAGE_QUERY).all(sinceMs) as unknown as HermesUsageRow[]) : null
        for (const row of rows ?? []) {
          const record = hermesUsageRecord(row, profile)
          if (record) records.push(record)
        }
      }
      return records
    },
  },
}

export const hermesSessionStore: AgentSessionStore = { title, conversation, files, usage: hermesUsage }
