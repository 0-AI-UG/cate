import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { AgentConversationMessage, UsageAgentLimits, UsageLimitWindow } from '../../contract'
import { isoInstant, parseJsonLine, tokenCount, totalTokens, totalsFromInclusiveInput } from '../usage/records'
import { MONTH_WINDOW_MINS, SESSION_WINDOW_MINS, WEEK_WINDOW_MINS, clampPercent, probeJsonLines, sortLimitWindows } from '../usage/probe'
import { SAFE_SESSION_ID, exists, forEachJsonlRecord, isoTimestamp, object, withReadOnlySqlite } from './storeFiles'
import type { AgentSessionContext, AgentSessionStore, AgentUsage, AgentUsageLineParser, AgentUsageRecord } from './types'

interface CodexSessionIndexEntry {
  id: string
  thread_name: string
}

function isSessionIndexEntry(value: unknown): value is CodexSessionIndexEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string' && typeof entry.thread_name === 'string'
}

/**
 * Codex CLI 0.153 writes an append-only `~/.codex/session_index.jsonl` whose
 * SessionIndexEntry schema is `{ id, thread_name, updated_at }`. Renames append
 * another row for the same id, so physical file order — not `updated_at` — is
 * authoritative and the last valid matching row wins.
 */
async function title({ session, homeDir }: AgentSessionContext): Promise<string | null> {
  if (!session.sessionId) return null

  let contents: string
  try {
    contents = await readFile(path.join(homeDir, '.codex', 'session_index.jsonl'), 'utf8')
  } catch {
    return null
  }

  let result: string | null = null
  for (const line of contents.split('\n')) {
    if (!line) continue
    try {
      const entry: unknown = JSON.parse(line)
      if (isSessionIndexEntry(entry) && entry.id === session.sessionId) {
        result = entry.thread_name
      }
    } catch {
      // A concurrently appended final line may be incomplete. Earlier complete
      // entries remain usable, and the title tracker retries this resolver.
    }
  }
  return result
}

async function findRollout(dir: string, suffix: string): Promise<string | null> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = await findRollout(full, suffix)
      if (found) return found
    } else if (entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) {
      return full
    }
  }
  return null
}

/**
 * The hook's `transcript_path` is the rollout itself:
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<local ISO>-<sessionId>.jsonl`.
 * Without it, ask Codex's thread index (`state_5.sqlite` threads.rollout_path),
 * then search the dated tree and finally the flat archive.
 */
async function locateRollout({ session, homeDir }: AgentSessionContext): Promise<string | null> {
  if (session.transcriptPath && await exists(session.transcriptPath)) return session.transcriptPath
  if (!SAFE_SESSION_ID.test(session.sessionId)) return null
  const codexHome = path.join(homeDir, '.codex')
  const indexed = await withReadOnlySqlite(path.join(codexHome, 'state_5.sqlite'), (database) => {
    const row = database.prepare('SELECT rollout_path FROM threads WHERE id = ? LIMIT 1')
      .get(session.sessionId) as { rollout_path?: unknown } | undefined
    return typeof row?.rollout_path === 'string' ? row.rollout_path : null
  })
  if (indexed && await exists(indexed)) return indexed
  const suffix = `-${session.sessionId}.jsonl`
  return await findRollout(path.join(codexHome, 'sessions'), suffix)
    ?? await findRollout(path.join(codexHome, 'archived_sessions'), suffix)
}

function itemText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.flatMap((part) => {
    const block = object(part)
    return (block?.type === 'text' || block?.type === 'Text') && typeof block.text === 'string' ? [block.text] : []
  }).join('\n\n').trim()
}

/**
 * Codex 0.157 rollouts are `{timestamp, type, payload}` lines carrying two
 * parallel channels. The UI channel (`event_msg`) holds exactly what the user
 * saw, without the AGENTS.md / environment context the model channel
 * (`response_item`) injects, so it is the one read here:
 * - paginated threads (0.144+): `item_completed` with `item.type` `UserMessage`
 *   (`[{type:'text'}]`) or `AgentMessage` (`[{type:'Text'}]`, commentary or
 *   final_answer phase);
 * - legacy threads: `user_message {message}` / `agent_message {message}`.
 * Tool, reasoning, compaction, and file-change records are not turns.
 */
async function conversation(context: AgentSessionContext): Promise<AgentConversationMessage[] | null> {
  const file = await locateRollout(context)
  if (!file) return null
  const messages: AgentConversationMessage[] = []
  const read = await forEachJsonlRecord(file, (record) => {
    if (record.type !== 'event_msg') return
    const payload = object(record.payload)
    const createdAt = isoTimestamp(record.timestamp)
    let role: AgentConversationMessage['role'] | undefined
    let text = ''
    if (payload?.type === 'item_completed') {
      const item = object(payload.item)
      if (item?.type === 'UserMessage') role = 'user'
      else if (item?.type === 'AgentMessage') role = 'assistant'
      text = itemText(item?.content)
    } else if (payload?.type === 'user_message' || payload?.type === 'agent_message') {
      role = payload.type === 'user_message' ? 'user' : 'assistant'
      text = typeof payload.message === 'string' ? payload.message.trim() : ''
    }
    if (role && text) messages.push({ role, text, createdAt })
  })
  return read ? messages : null
}

const files = async (context: AgentSessionContext): Promise<string[]> => {
  const file = await locateRollout(context)
  return file ? [file] : []
}

// --- Usage ---------------------------------------------------------------------------

/** A rollout's reading state: `token_count` events carry no model or cwd, so
 *  they carry forward from `session_meta` and `turn_context`. */
export interface CodexUsageState {
  model: string
  sessionId: string
  cwd: string | null
  lastUsage: string | null
  sawSessionMeta: boolean
  /** While true, leading usage events are copies of a parent's history. */
  inForkCopies: boolean
  forkCopyAnchorMs: number
}

/** A forked or subagent rollout opens with the parent's history copied in one
 *  burst (gaps of 0-40ms); the child's first real usage follows a model turn
 *  (5s+). One second splits them, as in ccusage. */
const FORK_COPY_MAX_GAP_MS = 1000

function isCodexUsageState(value: unknown): value is CodexUsageState {
  const s = object(value)
  return !!s && typeof s.model === 'string' && typeof s.sessionId === 'string' && (s.cwd === null || typeof s.cwd === 'string')
    && (s.lastUsage === null || typeof s.lastUsage === 'string') && typeof s.sawSessionMeta === 'boolean'
    && typeof s.inForkCopies === 'boolean' && typeof s.forkCopyAnchorMs === 'number'
}

function isForkedSession(payload: Record<string, unknown>): boolean {
  return typeof payload.forked_from_id === 'string'
    || typeof object(object(object(payload.source)?.subagent)?.thread_spawn)?.parent_thread_id === 'string'
}

/**
 * Codex 0.160 rollouts: usage deltas are `event_msg` `token_count` events'
 * `info.last_token_usage` (`input_tokens` includes the cached part). Codex
 * re-emits an unchanged event on some stream boundaries (dropped), and a fork
 * copies its parent's events (already counted from the parent's file).
 */
export function codexUsageParser(saved?: CodexUsageState): AgentUsageLineParser {
  const state: CodexUsageState = saved
    ? { ...saved }
    : { model: '', sessionId: '', cwd: null, lastUsage: null, sawSessionMeta: false, inForkCopies: false, forkCopyAnchorMs: 0 }
  const line = (text: string): AgentUsageRecord[] => {
    if (!text.includes('"token_count"') && !text.includes('"turn_context"') && !text.includes('"session_meta"')) return []
    const record = parseJsonLine(text)
    const payload = object(record?.payload)
    if (!record || !payload) return []
    const timestampMs = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
    if (record.type === 'session_meta') {
      // Only the first meta is this file's session; a fork repeats its ancestors'.
      if (state.sawSessionMeta) return []
      state.sawSessionMeta = true
      const id = payload.id ?? payload.session_id
      if (typeof id === 'string') state.sessionId = id
      if (typeof payload.cwd === 'string') state.cwd = payload.cwd
      if (!Number.isNaN(timestampMs) && isForkedSession(payload)) {
        state.inForkCopies = true
        state.forkCopyAnchorMs = timestampMs
      }
      return []
    }
    if (record.type === 'turn_context') {
      if (typeof payload.model === 'string') state.model = payload.model
      if (typeof payload.cwd === 'string') state.cwd = payload.cwd
      return []
    }
    const last = payload.type === 'token_count' ? object(object(payload.info)?.last_token_usage) : undefined
    // An event before its turn_context (no model yet) must not consume the
    // duplicate check, or its re-emission once the model is known is lost.
    if (!last || Number.isNaN(timestampMs) || !state.model) return []
    const signature = JSON.stringify(last)
    if (signature === state.lastUsage) return []
    state.lastUsage = signature
    if (state.inForkCopies) {
      if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
        state.forkCopyAnchorMs = timestampMs
        return []
      }
      state.inForkCopies = false
    }
    const totals = totalsFromInclusiveInput(
      tokenCount(last.input_tokens), tokenCount(last.cached_input_tokens), tokenCount(last.cache_write_input_tokens),
      tokenCount(last.output_tokens), tokenCount(last.reasoning_output_tokens),
    )
    if (totalTokens(totals) === 0) return []
    return [{ timestampMs, model: state.model, sessionId: state.sessionId, cwd: state.cwd, totals, reportedCostUsd: null, dedupeKey: null }]
  }
  return { line, state: () => ({ ...state }) }
}

/** Codex's `planType` slugs as the plan ChatGPT shows. */
export function codexPlanLabel(planType: unknown): string | undefined {
  switch (planType) {
    case 'free': return 'ChatGPT Free Subscription'
    case 'go': return 'ChatGPT Go Subscription'
    case 'plus': return 'ChatGPT Plus Subscription'
    case 'pro': return 'ChatGPT Pro 20x Subscription'
    case 'prolite': return 'ChatGPT Pro 5x Subscription'
    case 'team': return 'ChatGPT Team Subscription'
    case 'business': case 'self_serve_business_prolite': case 'self_serve_business_usage_based': return 'ChatGPT Business Subscription'
    case 'enterprise': case 'ent26': case 'enterprise_cbp_automation': case 'enterprise_cbp_usage_based': return 'ChatGPT Enterprise Subscription'
    case 'edu': case 'edu_plus': case 'edu_pro': return 'ChatGPT Edu Subscription'
    case 'unknown': return 'ChatGPT Subscription'
    default: return undefined
  }
}

/** `account/read` and `account/rateLimits/read` answers. `primary` and
 *  `secondary` are positions, not durations: without an explicit length, paid
 *  plans have the five-hour and weekly pair and Free/Go a monthly allowance.
 *  Only the main `codex` bucket is shown. */
export function codexUsageLimits(accountAnswer: Record<string, unknown>, ratesAnswer: Record<string, unknown>, checkedAt: string): UsageAgentLimits {
  const account = object(accountAnswer.account)
  const email = typeof account?.email === 'string' ? account.email : undefined
  const plan = codexPlanLabel(account?.planType)
  const base = { agent: 'codex' as const, checkedAt, ...(email ? { email } : {}), ...(plan ? { plan } : {}) }
  if (account?.type !== 'chatgpt') return { ...base, windows: [], unavailable: { reason: 'unsupported' } }
  const snapshot = object(object(ratesAnswer.rateLimitsByLimitId)?.codex) ?? object(ratesAnswer.rateLimits) ?? {}
  const windows: UsageLimitWindow[] = []
  if (!snapshot.limitId || snapshot.limitId === 'codex') {
    const monthly = snapshot.planType === 'free' || snapshot.planType === 'go'
    for (const [id, fallbackMins] of [['primary', monthly ? MONTH_WINDOW_MINS : SESSION_WINDOW_MINS], ['secondary', WEEK_WINDOW_MINS]] as const) {
      const window = object(snapshot[id])
      if (typeof window?.usedPercent !== 'number') continue
      const mins = typeof window.windowDurationMins === 'number' ? window.windowDurationMins : fallbackMins
      const kind = mins >= MONTH_WINDOW_MINS ? 'monthly' : mins >= WEEK_WINDOW_MINS ? 'weekly' : 'session'
      const resetsAt = isoInstant(window.resetsAt)
      windows.push({ id, kind, label: kind === 'session' ? 'Session' : kind === 'weekly' ? 'Weekly' : 'Monthly', usedPercent: clampPercent(window.usedPercent), windowDurationMins: mins, ...(resetsAt ? { resetsAt } : {}) })
    }
  }
  const credits = object(ratesAnswer.rateLimitResetCredits)
  let resetCredits: UsageAgentLimits['resetCredits']
  if (typeof credits?.availableCount === 'number') {
    const expiries = (Array.isArray(credits.credits) ? credits.credits : []).flatMap((c) => object(c)?.status === 'available' && typeof object(c)?.expiresAt === 'number' ? [object(c)!.expiresAt as number] : [])
    const nextExpiresAt = expiries.length > 0 ? isoInstant(Math.min(...expiries)) : undefined
    resetCredits = { availableCount: Math.max(0, credits.availableCount), ...(nextExpiresAt ? { nextExpiresAt } : {}) }
  }
  return { ...base, windows: sortLimitWindows(windows), ...(resetCredits ? { resetCredits } : {}) }
}

const codexUsage: AgentUsage = {
  source: {
    kind: 'transcripts',
    root: (homeDir) => path.join(homeDir, '.codex', 'sessions'),
    parser: (_file, state) => state === undefined ? codexUsageParser() : isCodexUsageState(state) ? codexUsageParser(state) : null,
  },
  /** `codex app-server` JSON-RPC: initialize, then the account and its rate limits. */
  async limits({ cwd, env, now }) {
    let account: Record<string, unknown> = {}
    const rates = await probeJsonLines<Record<string, unknown>>({
      command: 'codex',
      args: ['app-server'],
      cwd,
      env,
      converse: (send, line) => {
        if (!line) return send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'cate', title: 'Cate', version: '1.0.0' } } })
        if (line.id !== 1) return
        send({ method: 'initialized' })
        send({ id: 2, method: 'account/read', params: {} })
        send({ id: 3, method: 'account/rateLimits/read' })
      },
      answer: (line) => {
        if (line.id === 2) account = object(line.result) ?? {}
        if (line.id !== 3) return undefined
        // Signed out: no account, so no limits (reported as unsupported).
        if (line.error && !object(account.account)) return {}
        if (line.error) throw new Error(`Codex could not read usage (JSON-RPC ${object(line.error)?.code ?? 'error'}).`)
        return object(line.result) ?? {}
      },
    })
    return codexUsageLimits(account, rates, now.toISOString())
  },
}

export const codexSessionStore: AgentSessionStore = { title, conversation, files, usage: codexUsage }
