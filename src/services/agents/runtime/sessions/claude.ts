import path from 'node:path'
import type { AgentConversationMessage, UsageAgentLimits, UsageLimitWindow } from '../../contract'
import { isoInstant, parseJsonLine, recordedCost, tokenCount } from '../usage/records'
import { WEEK_WINDOW_MINS, SESSION_WINDOW_MINS, clampPercent, probeJsonLines, sortLimitWindows } from '../usage/probe'
import { SAFE_SESSION_ID, exists, findInWorkspaceBuckets, forEachJsonlRecord, isoTimestamp, object } from './storeFiles'
import type { AgentSessionContext, AgentSessionStore, AgentUsage, AgentUsageLineParser, AgentUsageRecord } from './types'

const MAX_SLUG_LENGTH = 200

/**
 * Claude Code 2.1.283 keeps one JSONL per session at
 * `~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl`, where the slug replaces
 * every non-alphanumeric character of the (realpath) cwd with `-`. Hooks hand
 * us that path directly; a persisted session stamp does not, so rebuild it and
 * fall back to scanning project dirs (slugs over 200 chars carry a hash).
 */
async function locateTranscript({ session, homeDir }: AgentSessionContext): Promise<string | null> {
  if (session.transcriptPath && await exists(session.transcriptPath)) return session.transcriptPath
  if (!SAFE_SESSION_ID.test(session.sessionId)) return null
  const projects = path.join(homeDir, '.claude', 'projects')
  const file = `${session.sessionId}.jsonl`
  if (session.cwd) {
    const slug = session.cwd.replace(/[^a-zA-Z0-9]/g, '-')
    if (slug.length <= MAX_SLUG_LENGTH && await exists(path.join(projects, slug, file))) {
      return path.join(projects, slug, file)
    }
  }
  return findInWorkspaceBuckets(projects, session.sessionId, file)
}

/**
 * Claude Code 2.1.222 writes its session-picker title into the session JSONL as
 * `{type:"ai-title", aiTitle:string, sessionId:string}`. Records are repeated
 * and may change, so the final matching record is authoritative.
 */
async function title(context: AgentSessionContext): Promise<string | null> {
  const { sessionId } = context.session
  if (!sessionId) return null
  const file = await locateTranscript(context)
  if (!file) return null
  let result: string | null = null
  await forEachJsonlRecord(file, (record) => {
    if (record.type === 'ai-title'
      && record.sessionId === sessionId
      && typeof record.aiTitle === 'string'
      && record.aiTitle.trim()) {
      result = record.aiTitle
    }
  })
  return result
}

/** Slash-command echoes and local-command output Claude records as user text. */
const COMMAND_ECHO = /^<(command-name|command-message|local-command-stdout|local-command-stderr|local-command-caveat)>/
const INTERRUPT_MARKER = /^\[Request interrupted by user/

function userText(record: Record<string, unknown>): string | null {
  if (record.isMeta === true || record.isSidechain === true || record.isCompactSummary === true) return null
  const origin = object(record.origin)?.kind
  if (origin === 'peer' || origin === 'task-notification' || record.promptSource === 'system') return null
  const content = object(record.message)?.content
  const texts = typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.flatMap((block) => object(block)?.type === 'text' && typeof object(block)?.text === 'string'
        ? [object(block)!.text as string]
        : [])
      : []
  const text = texts.filter((part) => !INTERRUPT_MARKER.test(part.trim())).join('\n\n').trim()
  if (!text || COMMAND_ECHO.test(text)) return null
  return text
}

/**
 * Claude Code 2.1.283 transcript records (`type` discriminated):
 * - `user`: a typed/SDK prompt has string or `[{type:'text'}]` content. Tool
 *   results (all-`tool_result` arrays), `isMeta` injections, peer/task
 *   notifications, command echoes, and compaction summaries are not turns.
 * - `assistant`: ONE record per content block, repeating `message.id`; blocks
 *   are complete, so text blocks of consecutive same-id records concatenate.
 *   `thinking`/`tool_use` blocks and API-error records are dropped.
 * - everything else (`ai-title`, `attachment`, `system`, snapshots…) is meta.
 * Subagents live in separate files; `isSidechain` records are skipped anyway.
 */
async function conversation(context: AgentSessionContext): Promise<AgentConversationMessage[] | null> {
  const file = await locateTranscript(context)
  if (!file) return null
  const messages: AgentConversationMessage[] = []
  let assistantId: unknown
  let assistant: AgentConversationMessage | null = null
  const read = await forEachJsonlRecord(file, (record) => {
    if (record.type === 'user') {
      const text = userText(record)
      if (!text) return
      assistantId = undefined
      assistant = null
      messages.push({ role: 'user', text, createdAt: isoTimestamp(record.timestamp) })
      return
    }
    if (record.type !== 'assistant' || record.isSidechain === true || record.isApiErrorMessage === true) return
    const message = object(record.message)
    const id = message?.id
    if (id === undefined || id !== assistantId) {
      assistantId = id
      assistant = null
    }
    const content = Array.isArray(message?.content) ? message.content : []
    for (const block of content) {
      const text = object(block)?.type === 'text' ? object(block)?.text : undefined
      if (typeof text !== 'string' || !text.trim()) continue
      if (assistant) assistant.text += `\n\n${text}`
      else {
        assistant = { role: 'assistant', text, createdAt: isoTimestamp(record.timestamp) }
        messages.push(assistant)
      }
    }
  })
  return read ? messages : null
}

const files = async (context: AgentSessionContext): Promise<string[]> => {
  const file = await locateTranscript(context)
  return file ? [file] : []
}

// --- Usage ---------------------------------------------------------------------------

/**
 * Every content-block record of an assistant message repeats the message's
 * complete `usage`, and resumed or forked sessions copy records into their
 * own files: repeats share `message.id:requestId` (as in ccusage) and count
 * once. Thinking tokens are folded into `output_tokens`.
 */
export function claudeUsageRecord(text: string): AgentUsageRecord | null {
  if (!text.includes('"usage"')) return null
  const record = parseJsonLine(text)
  if (record?.type !== 'assistant') return null
  const message = object(record.message)
  const usage = object(message?.usage)
  const timestampMs = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
  const model = typeof message?.model === 'string' ? message.model : ''
  if (!message || !usage || Number.isNaN(timestampMs) || !model) return null
  const messageId = typeof message.id === 'string' ? message.id : null
  const requestId = typeof record.requestId === 'string' ? record.requestId : null
  return {
    timestampMs,
    model,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
    cwd: typeof record.cwd === 'string' ? record.cwd : null,
    totals: {
      uncachedInputTokens: tokenCount(usage.input_tokens),
      cachedInputTokens: tokenCount(usage.cache_read_input_tokens),
      cacheCreationTokens: tokenCount(usage.cache_creation_input_tokens),
      outputTokens: tokenCount(usage.output_tokens),
      reasoningTokens: 0,
    },
    reportedCostUsd: recordedCost(record.costUSD),
    dedupeKey: messageId === null && requestId === null ? null : `${messageId ?? ''}:${requestId ?? ''}`,
  }
}

const statelessParser: AgentUsageLineParser = {
  line: (text) => {
    const record = claudeUsageRecord(text)
    return record ? [record] : []
  },
  state: () => null,
}

/** `max`, `claude_max_20x_subscription`… as the plan Claude shows. */
export function claudePlanLabel(subscriptionType: unknown): string | undefined {
  if (typeof subscriptionType !== 'string' || !subscriptionType.trim()) return undefined
  const key = subscriptionType.toLowerCase().replace(/[\s_-]+/g, '').replace(/^claude/, '').replace(/subscription$/, '')
  const label = ({ max: 'Max', maxplan: 'Max', max5: 'Max 5x', max5x: 'Max 5x', max20: 'Max 20x', max20x: 'Max 20x', enterprise: 'Enterprise', team: 'Team', pro: 'Pro', free: 'Free' } as Record<string, string>)[key]
    ?? subscriptionType.split(/[\s_-]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase()).join(' ')
  return `Claude ${label} Subscription`
}

/** A `get_usage` control response: the account windows, plus model-scoped
 *  weeklies under `rate_limits.model_scoped`. Percentages are 0-100. */
export function claudeUsageLimits(response: Record<string, unknown>, account: Record<string, unknown> | undefined, checkedAt: string): UsageAgentLimits {
  const email = typeof account?.email === 'string' ? account.email : undefined
  const plan = claudePlanLabel(response.subscription_type ?? account?.subscriptionType)
  const base = { agent: 'claude-code' as const, checkedAt, ...(email ? { email } : {}), ...(plan ? { plan } : {}) }
  const rateLimits = object(response.rate_limits)
  if (response.rate_limits_available !== true || !rateLimits) return { ...base, windows: [], unavailable: { reason: 'unsupported' } }
  const windows: UsageLimitWindow[] = []
  const add = (id: string, kind: UsageLimitWindow['kind'], label: string, mins: number, raw: unknown) => {
    const window = object(raw)
    if (typeof window?.utilization !== 'number') return
    const resetsAt = isoInstant(window.resets_at)
    windows.push({ id, kind, label, windowDurationMins: mins, usedPercent: clampPercent(window.utilization), ...(resetsAt ? { resetsAt } : {}) })
  }
  add('five_hour', 'session', 'Session', SESSION_WINDOW_MINS, rateLimits.five_hour)
  add('seven_day', 'weekly', 'Weekly', WEEK_WINDOW_MINS, rateLimits.seven_day)
  for (const scoped of Array.isArray(rateLimits.model_scoped) ? rateLimits.model_scoped : []) {
    const name = object(scoped)?.display_name
    if (typeof name === 'string') add(`seven_day_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, 'weekly', `Weekly · ${name}`, WEEK_WINDOW_MINS, scoped)
  }
  return { ...base, windows: sortLimitWindows(windows) }
}

/** Claude Code's stream-json control protocol: `initialize` (the account) and
 *  `get_usage`. No prompt is written, so no model request starts. */
const claudeUsage: AgentUsage = {
  source: {
    kind: 'transcripts',
    root: (homeDir) => path.join(homeDir, '.claude', 'projects'),
    parser: (_file, state) => state === undefined || state === null ? statelessParser : null,
  },
  async limits({ cwd, env, now }) {
    let account: Record<string, unknown> | undefined
    const usage = await probeJsonLines<Record<string, unknown>>({
      command: 'claude',
      args: ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--strict-mcp-config', '--setting-sources', ''],
      cwd,
      env: { ...env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_AUTO_CONNECT_IDE: '0', CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1' },
      converse: (send, line) => {
        if (line) return
        send({ type: 'control_request', request_id: 'cate-init', request: { subtype: 'initialize' } })
        send({ type: 'control_request', request_id: 'cate-usage', request: { subtype: 'get_usage' } })
      },
      answer: (line) => {
        const response = line.type === 'control_response' ? object(line.response) : undefined
        if (response?.request_id === 'cate-init') account = object(object(response.response)?.account)
        if (response?.request_id !== 'cate-usage') return undefined
        if (response.subtype !== 'success') throw new Error(typeof response.error === 'string' ? response.error : 'Claude Code could not read usage.')
        return object(response.response) ?? {}
      },
    })
    return claudeUsageLimits(usage, account, now.toISOString())
  },
}

export const claudeSessionStore: AgentSessionStore = { title, conversation, files, usage: claudeUsage }
