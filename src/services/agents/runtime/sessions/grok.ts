import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentConversationMessage } from '../../contract'
import { exists, findInWorkspaceBuckets, forEachJsonlRecord, isoTimestamp, object } from './storeFiles'
import type { AgentSessionContext, AgentSessionStore } from './types'

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

export const grokSessionStore: AgentSessionStore = { title, conversation }
