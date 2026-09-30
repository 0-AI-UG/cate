import path from 'node:path'
import type { AgentConversationMessage } from '../../../shared/agentConversation'
import { isoTimestamp, withReadOnlySqlite } from './storeFiles'
import type { AgentSessionContext, AgentSessionStore } from './types'

function databasePath(homeDir: string): string {
  return path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db')
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * OpenCode 1.18.3 stores the session-picker title in the `title` column of the
 * `session` table in `~/.local/share/opencode/opencode.db`. Session ids are the
 * table's primary key, and generated titles replace the value in place.
 */
async function title({ session, homeDir }: AgentSessionContext): Promise<string | null> {
  if (!session.sessionId) return null
  const row = await withReadOnlySqlite(databasePath(homeDir), (database) =>
    database.prepare('SELECT title FROM session WHERE id = ? LIMIT 1')
      .get(session.sessionId) as { title?: unknown } | undefined)
  return typeof row?.title === 'string' && row.title.trim() ? row.title : null
}

interface MessageRow { id: string; time_created: number; data: string }
interface PartRow { message_id: string; data: string }
interface SessionMessageRow { type: string; time_created: number; data: string }

/** Visible text of an OpenCode message: its text parts, excluding synthetic
 *  (tool-announcement) and ignored parts. */
function textFromParts(parts: Record<string, unknown>[]): string {
  return parts
    .filter((part) => part.type === 'text' && part.synthetic !== true && part.ignored !== true && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
}

/** OpenCode's newer `session_message` rows carry text directly (user) or as
 *  content parts (assistant). */
function textFromSessionMessage(data: Record<string, unknown>): string {
  if (typeof data.text === 'string') return data.text
  if (typeof data.content === 'string') return data.content
  if (Array.isArray(data.content)) {
    return textFromParts(data.content.filter((part): part is Record<string, unknown> =>
      !!part && typeof part === 'object' && !Array.isArray(part)))
  }
  return ''
}

/**
 * OpenCode 1.18 keeps every session in one SQLite store. A message is a
 * `message` row (`data.role` user/assistant) whose visible text lives in its
 * `part` rows of `data.type: 'text'`; ids are monotonic, so id order is
 * conversation order. Some 1.18.3 sessions instead store turns in
 * `session_message` (ordered by `seq`) with no `message` rows; that table is
 * the fallback.
 */
async function conversation({ session, homeDir }: AgentSessionContext): Promise<AgentConversationMessage[] | null> {
  if (!session.sessionId) return null
  return withReadOnlySqlite(databasePath(homeDir), (database) => {
    const rows = database.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY id')
      .all(session.sessionId) as unknown as MessageRow[]
    if (rows.length > 0) {
      const partRows = database.prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY id')
        .all(session.sessionId) as unknown as PartRow[]
      const partsByMessage = new Map<string, Record<string, unknown>[]>()
      for (const row of partRows) {
        const part = parseJson(row.data)
        if (!part) continue
        const parts = partsByMessage.get(row.message_id) ?? []
        parts.push(part)
        partsByMessage.set(row.message_id, parts)
      }
      const messages: AgentConversationMessage[] = []
      for (const row of rows) {
        const role = parseJson(row.data)?.role
        if (role !== 'user' && role !== 'assistant') continue
        const text = textFromParts(partsByMessage.get(row.id) ?? [])
        if (!text.trim()) continue
        const createdAt = isoTimestamp(row.time_created)
        messages.push({ role, text, ...(createdAt ? { createdAt } : {}) })
      }
      return messages
    }

    let sessionRows: SessionMessageRow[]
    try {
      sessionRows = database.prepare('SELECT type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq')
        .all(session.sessionId) as unknown as SessionMessageRow[]
    } catch {
      // Older stores have no session_message table.
      return []
    }
    const messages: AgentConversationMessage[] = []
    for (const row of sessionRows) {
      if (row.type !== 'user' && row.type !== 'assistant') continue
      const data = parseJson(row.data)
      if (!data) continue
      const text = textFromSessionMessage(data)
      if (!text.trim()) continue
      const createdAt = isoTimestamp(row.time_created)
      messages.push({ role: row.type, text, ...(createdAt ? { createdAt } : {}) })
    }
    return messages
  })
}

export const openCodeSessionStore: AgentSessionStore = { title, conversation }
