import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { AgentConversationMessage } from '../../../shared/agentConversation'
import { SAFE_SESSION_ID, exists, forEachJsonlRecord, isoTimestamp, object, withReadOnlySqlite } from './storeFiles'
import type { AgentSessionContext, AgentSessionStore } from './types'

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

export const codexSessionStore: AgentSessionStore = { title, conversation }
