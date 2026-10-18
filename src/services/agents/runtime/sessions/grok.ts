import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentConversationMessage } from '../../contract'
import { parseJsonLine, tokenCount, totalTokens, totalsFromInclusiveInput } from '../usage/records'
import { exists, findInWorkspaceBuckets, forEachJsonlRecord, isoTimestamp, object } from './storeFiles'
import type { AgentSessionContext, AgentSessionStore, AgentUsage, AgentUsageRecord } from './types'

interface GrokSessionSummary {
  generated_title?: unknown
}

/**
 * Grok Build keeps a session at
 * `~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/`, with the hook's
 * `transcriptPath` pointing at its `updates.jsonl` from the first prompt on.
 * Without that path, scan the per-cwd buckets for the session id.
 */
async function locateTranscript({ session, homeDir }: AgentSessionContext): Promise<string | null> {
  // Not written yet, or moved: fall back to the bucket scan.
  if (session.transcriptPath && await exists(session.transcriptPath)) return session.transcriptPath
  return findInWorkspaceBuckets(path.join(homeDir, '.grok', 'sessions'), session.sessionId, path.join(session.sessionId, 'updates.jsonl'))
}

/**
 * Grok Build 0.2.106 keeps the title shown by its session picker in
 * `summary.json.generated_title`, next to the hook-provided `updates.jsonl`.
 * `/rename` overwrites that same field and sets `title_is_manual`; therefore
 * reading the current summary also picks up the latest manual rename.
 * `session_summary` is separate conversation metadata, not the picker title.
 */
async function title(context: AgentSessionContext): Promise<string | null> {
  if (!context.session.sessionId) return null
  const transcript = await locateTranscript(context)
  if (!transcript) return null

  try {
    const raw = await readFile(path.join(path.dirname(transcript), 'summary.json'), 'utf8')
    const summary: unknown = JSON.parse(raw)
    if (typeof summary !== 'object' || summary === null) return null

    const value = (summary as GrokSessionSummary).generated_title
    return typeof value === 'string' && value.trim() ? value : null
  } catch {
    return null
  }
}

/**
 * Grok Build 1.0.41 documents `updates.jsonl` as the authoritative
 * conversation log: an append-only ACP stream of
 * `{timestamp, method, params:{update:{sessionUpdate, content}, _meta}}`.
 * - `user_message_chunk` carries the raw prompt;
 * - `agent_message_chunk` streams the reply; consecutive chunks of the same
 *   `_meta.promptId` concatenate until any other update (tool call, thought,
 *   turn end) intervenes.
 * Thoughts, tool calls, hook executions, and `turn_completed` are not turns.
 */
async function conversation(context: AgentSessionContext): Promise<AgentConversationMessage[] | null> {
  const file = await locateTranscript(context)
  if (!file) return null
  const messages: AgentConversationMessage[] = []
  let current: { message: AgentConversationMessage; promptId: unknown } | null = null
  const read = await forEachJsonlRecord(file, (record) => {
    const params = object(record.params)
    const update = object(params?.update)
    const kind = update?.sessionUpdate
    const role = kind === 'user_message_chunk' ? 'user' : kind === 'agent_message_chunk' ? 'assistant' : null
    if (!role) {
      if (kind !== undefined) current = null
      return
    }
    const content = object(update?.content)
    const text = content?.type === 'text' && typeof content.text === 'string' ? content.text : ''
    if (!text) return
    const promptId = object(params?._meta)?.promptId
    if (current && current.message.role === role && current.promptId === promptId) {
      current.message.text += text
      return
    }
    const createdAt = isoTimestamp(object(params?._meta)?.agentTimestampMs) ?? isoTimestamp(record.timestamp)
    current = { message: { role, text, createdAt }, promptId }
    messages.push(current.message)
  })
  if (!read) return null
  return messages.flatMap((message) => {
    const text = message.text.trim()
    return text ? [{ ...message, text }] : []
  })
}

const files = async (context: AgentSessionContext): Promise<string[]> => {
  const file = await locateTranscript(context)
  return file ? [file] : []
}

// --- Usage ---------------------------------------------------------------------------

/** Grok records cost in ticks, `1 USD = 10^10` ticks. */
const TICKS_PER_DOLLAR = 10_000_000_000
const ticksToUsd = (ticks: unknown): number | null => typeof ticks === 'number' && Number.isFinite(ticks) && ticks >= 0 ? ticks / TICKS_PER_DOLLAR : null

const grokTotals = (usage: Record<string, unknown>) => totalsFromInclusiveInput(
  tokenCount(usage.inputTokens), tokenCount(usage.cachedReadTokens), tokenCount(usage.cacheCreationTokens),
  tokenCount(usage.outputTokens), tokenCount(usage.reasoningTokens),
)

/**
 * Grok Build 0.2.106 `updates.jsonl`: usage lands on `turn_completed`
 * updates (`inputTokens` includes the cached part), split per model under
 * `usage.modelUsage`. A model without its own cost gets a token-share slice
 * of what the aggregate cost leaves. The session's cwd is its bucket folder.
 */
export function grokUsageRecords(text: string, cwd: string | null): AgentUsageRecord[] {
  if (!text.includes('"turn_completed"')) return []
  const record = parseJsonLine(text)
  const params = object(record?.params)
  const update = object(params?.update)
  const usage = object(update?.usage)
  if (!record || !params || update?.sessionUpdate !== 'turn_completed' || !usage) return []
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
  const promptId = typeof update.prompt_id === 'string' ? update.prompt_id : null
  const agentClock = object(params._meta)?.agentTimestampMs
  const timestampMs = typeof agentClock === 'number' && Number.isFinite(agentClock) ? agentClock
    : typeof record.timestamp === 'number' && Number.isFinite(record.timestamp) ? (record.timestamp > 1e12 ? record.timestamp : record.timestamp * 1000) : null
  if (timestampMs === null) return []
  const make = (model: string, usageOf: Record<string, unknown>, cost: number | null): AgentUsageRecord =>
    ({ timestampMs, model, sessionId, cwd, totals: grokTotals(usageOf), reportedCostUsd: cost, dedupeKey: promptId === null ? null : `${sessionId}:${promptId}:${model}` })

  const models = Object.entries(object(usage.modelUsage) ?? {}).flatMap(([model, raw]) => {
    const usageOf = object(raw)
    return model && usageOf && totalTokens(grokTotals(usageOf)) > 0 ? [{ model, usage: usageOf }] : []
  })
  if (models.length === 0) return totalTokens(grokTotals(usage)) > 0 ? [make('grok', usage, ticksToUsd(usage.costUsdTicks))] : []

  const ticked = models.reduce((sum, m) => sum + (ticksToUsd(m.usage.costUsdTicks) ?? 0), 0)
  const untickedTokens = models.reduce((sum, m) => sum + (ticksToUsd(m.usage.costUsdTicks) === null ? totalTokens(grokTotals(m.usage)) : 0), 0)
  const aggregate = ticksToUsd(usage.costUsdTicks)
  const remaining = aggregate === null ? null : Math.max(0, aggregate - ticked)
  return models.map((m) => {
    const own = ticksToUsd(m.usage.costUsdTicks)
    const share = own ?? (remaining !== null && untickedTokens > 0 ? remaining * (totalTokens(grokTotals(m.usage)) / untickedTokens) : null)
    return make(m.model, m.usage, share)
  })
}

/** `<root>/<encodeURIComponent(cwd)>/<session>/updates.jsonl` names its cwd. */
function bucketCwd(file: string): string | null {
  try {
    return decodeURIComponent(path.basename(path.dirname(path.dirname(file))))
  } catch {
    return null
  }
}

const grokUsage: AgentUsage = {
  source: {
    kind: 'transcripts',
    root: (homeDir) => path.join(homeDir, '.grok', 'sessions'),
    fileName: 'updates.jsonl',
    parser: (file, state) => {
      if (state !== undefined && state !== null) return null
      const cwd = bucketCwd(file)
      return { line: (text) => grokUsageRecords(text, cwd), state: () => null }
    },
  },
}

export const grokSessionStore: AgentSessionStore = { title, conversation, files, usage: grokUsage }
