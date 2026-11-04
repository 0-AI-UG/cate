import path from 'node:path'
import { readdir } from 'node:fs/promises'
import type { AgentConversationMessage } from '../../contract'
import { parseJsonLine, recordedCost, tokenCount } from '../usage/records'
import { exists, firstInWorkspaceBuckets, forEachJsonlRecord, isoTimestamp, object } from './storeFiles'
import type { AgentSessionContext, AgentSessionStore, AgentUsageLineParser, AgentUsageRecord } from './types'

async function locate({ session, homeDir }: AgentSessionContext): Promise<string | null> {
  if (session.transcriptPath && await exists(session.transcriptPath)) return session.transcriptPath
  return firstInWorkspaceBuckets(path.join(homeDir, '.pi/agent/sessions'), session.sessionId, async (directory) => {
    const names = await readdir(directory)
    const name = names.find((name) => name.endsWith(`_${session.sessionId}.jsonl`))
    return name ? path.join(directory, name) : null
  })
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.flatMap((block) => {
    const value = object(block)
    return value?.type === 'text' && typeof value.text === 'string' ? [value.text] : []
  }).join('\n') : ''
}

async function title(context: AgentSessionContext): Promise<string | null> {
  const file = await locate(context)
  if (!file) return null
  let name: string | null = null
  let firstPrompt: string | null = null
  await forEachJsonlRecord(file, (entry) => {
    if (entry.type === 'session_info' && typeof entry.name === 'string') name = entry.name.trim() || null
    const message = object(entry.message)
    if (entry.type === 'message' && message?.role === 'user' && !firstPrompt) firstPrompt = textOf(message.content).trim() || null
  })
  return name ?? firstPrompt
}

async function conversation(context: AgentSessionContext): Promise<AgentConversationMessage[] | null> {
  const file = await locate(context)
  if (!file) return null
  const entries = new Map<string, Record<string, unknown>>()
  let last: string | null = null
  if (!await forEachJsonlRecord(file, (entry) => {
    if (entry.type !== 'session' && typeof entry.id === 'string') { entries.set(entry.id, entry); last = entry.id }
  })) return null
  const branch: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let id = context.session.leafId === undefined ? last : context.session.leafId
  while (id && !seen.has(id)) {
    seen.add(id)
    const entry = entries.get(id)
    if (!entry) break
    branch.push(entry)
    id = typeof entry.parentId === 'string' ? entry.parentId : null
  }
  return branch.reverse().flatMap((entry): AgentConversationMessage[] => {
    const message = object(entry.message)
    if (entry.type !== 'message' || (message?.role !== 'user' && message?.role !== 'assistant')) return []
    const text = textOf(message.content).trim()
    return text ? [{ role: message.role, text, createdAt: isoTimestamp(message.timestamp) ?? isoTimestamp(entry.timestamp) }] : []
  })
}

/** Pi input excludes cache reads/writes. Count every paid response, including
 * abandoned branches and compaction/summary/standalone usage, exactly once. */
export function piUsageParser(saved?: unknown): AgentUsageLineParser | null {
  const state = object(saved)
  if (saved !== undefined && (!state || state.version !== 1)) return null
  let sessionId = typeof state?.sessionId === 'string' ? state.sessionId : ''
  let cwd = typeof state?.cwd === 'string' ? state.cwd : null
  let model = typeof state?.model === 'string' ? state.model : ''
  return {
    line(text): AgentUsageRecord[] {
      const entry = parseJsonLine(text)
      if (!entry) return []
      if (entry.type === 'session') {
        sessionId = typeof entry.id === 'string' ? entry.id : ''
        cwd = typeof entry.cwd === 'string' ? entry.cwd : null
        return []
      }
      if (entry.type === 'model_change' && typeof entry.modelId === 'string') model = entry.modelId
      const message = object(entry.message)
      const response = entry.type === 'message' && message?.role === 'assistant' ? message
        : ['usage', 'compaction', 'branch_summary'].includes(String(entry.type)) ? entry : null
      const usage = object(response?.usage)
      const timestamp = isoTimestamp(entry.timestamp)
      if (!response || !usage || !sessionId || !timestamp) return []
      return [{ sessionId, cwd, model: typeof response.model === 'string' ? response.model : model || 'unknown',
        timestampMs: Date.parse(timestamp), // Forks copy entries under a new session header; those responses were paid once.
        dedupeKey: typeof entry.id === 'string' ? `${entry.id}:${timestamp}:${response.model ?? model}` : null,
        totals: { uncachedInputTokens: tokenCount(usage.input), cachedInputTokens: tokenCount(usage.cacheRead),
          cacheCreationTokens: tokenCount(usage.cacheWrite), outputTokens: tokenCount(usage.output), reasoningTokens: 0 },
        reportedCostUsd: recordedCost(object(usage.cost)?.total) }]
    },
    state: () => ({ version: 1, sessionId, cwd, model }),
  }
}

export const piSessionStore: AgentSessionStore = {
  title, conversation,
  files: async (context) => { const file = await locate(context); return file ? [file] : [] },
  usage: { source: { kind: 'transcripts', root: (home) => path.join(home, '.pi/agent/sessions'), parser: (_file, saved) => piUsageParser(saved) } },
}
