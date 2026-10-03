import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentConversationMessage } from '../../contract'
import { SAFE_SESSION_ID, exists, findInWorkspaceBuckets, firstInWorkspaceBuckets, forEachJsonlRecord, object } from './storeFiles'
import type { AgentSessionContext, AgentSessionStore } from './types'

interface CursorChatMeta {
  title?: unknown
}

/**
 * Cursor Agent stores each conversation at:
 *   ~/.cursor/chats/<opaque-workspace-key>/<conversation-id>/meta.json
 *
 * The workspace key is an internal 32-hex identifier, not the project-path
 * slug used by agent transcripts. The hook's session_id is the conversation
 * directory name, so search the shallow workspace directories by that stable
 * key instead of duplicating Cursor's opaque workspace-key derivation.
 *
 * Observed with Cursor Agent 2026.07.16-899851b: meta.json schemaVersion 1
 * carries createdAtMs, updatedAtMs, hasConversation, cwd, and an optional
 * title. Cursor adds title only after it has generated the chat title.
 */
async function title({ session, homeDir }: AgentSessionContext): Promise<string | null> {
  const { sessionId } = session
  return firstInWorkspaceBuckets(path.join(homeDir, '.cursor', 'chats'), sessionId, async (bucketDir) => {
    try {
      const meta = JSON.parse(await readFile(path.join(bucketDir, sessionId, 'meta.json'), 'utf8')) as CursorChatMeta
      return typeof meta.title === 'string' && meta.title.trim() !== '' ? meta.title : null
    } catch {
      // The conversation belongs to another workspace, or this entry is
      // incomplete/corrupt. Keep looking for the matching conversation id.
      return null
    }
  })
}

/**
 * Agent transcripts live at
 * `~/.cursor/projects/<slug(cwd)>/agent-transcripts/<id>/<id>.jsonl`, where the
 * slug collapses every non-alphanumeric run of the cwd into `-` and trims
 * dashes. The hook carries this path from the first turn on.
 */
async function locateTranscript({ session, homeDir }: AgentSessionContext): Promise<string | null> {
  if (session.transcriptPath && await exists(session.transcriptPath)) return session.transcriptPath
  if (!SAFE_SESSION_ID.test(session.sessionId)) return null
  const projects = path.join(homeDir, '.cursor', 'projects')
  const leaf = path.join('agent-transcripts', session.sessionId, `${session.sessionId}.jsonl`)
  if (session.cwd) {
    const slug = session.cwd.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    if (slug && await exists(path.join(projects, slug, leaf))) return path.join(projects, slug, leaf)
  }
  return findInWorkspaceBuckets(projects, session.sessionId, leaf)
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** `Sunday, Sep 27, 2026, 12:36 PM (UTC+2)` → ISO. Minute precision. */
export function parseCursorTimestamp(value: string): string | undefined {
  const match = value.match(/([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) (AM|PM) \(UTC(?:([+-])(\d{1,2})(?::?(\d{2}))?)?\)/)
  if (!match) return undefined
  const month = MONTHS.indexOf(match[1].toLowerCase())
  if (month < 0) return undefined
  const hour12 = Number(match[4]) % 12
  const hour = match[6] === 'PM' ? hour12 + 12 : hour12
  const sign = match[7] === '-' ? -1 : 1
  const offsetMinutes = sign * (Number(match[8] ?? 0) * 60 + Number(match[9] ?? 0))
  const utc = Date.UTC(Number(match[3]), month, Number(match[2]), hour, Number(match[5])) - offsetMinutes * 60_000
  return new Date(utc).toISOString()
}

function blockText(record: Record<string, unknown>): string {
  const content = object(record.message)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((part) => {
    const block = object(part)
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  }).join('\n\n')
}

/**
 * Cursor Agent 2026.09.02 transcripts have no envelope and no per-record
 * timestamps:
 * - `{role:'user', message:{content:[{type:'text', text}]}}` whose text wraps
 *   the prompt as `<timestamp>…</timestamp>\n<user_query>…</user_query>`;
 * - `{role:'assistant', message:{content:[text | tool_use…]}}`, one record per
 *   model step, so a turn's assistant text concatenates until the next prompt
 *   or `{type:'turn_ended'}`. Older builds append `[REDACTED]` reasoning.
 * Assistant turns inherit their prompt's timestamp; tool results aren't kept.
 */
async function conversation(context: AgentSessionContext): Promise<AgentConversationMessage[] | null> {
  const file = await locateTranscript(context)
  if (!file) return null
  const messages: AgentConversationMessage[] = []
  let turnCreatedAt: string | undefined
  let assistant: AgentConversationMessage | null = null
  const read = await forEachJsonlRecord(file, (record) => {
    if (record.type === 'turn_ended') {
      assistant = null
      return
    }
    if (record.role === 'user') {
      assistant = null
      const raw = blockText(record)
      const stamp = raw.match(/<timestamp>([\s\S]*?)<\/timestamp>/)?.[1]
      turnCreatedAt = stamp ? parseCursorTimestamp(stamp) : undefined
      const query = raw.match(/<user_query>([\s\S]*?)<\/user_query>/)?.[1]
      const text = (query ?? raw.replace(/<timestamp>[\s\S]*?<\/timestamp>/, '')).trim()
      if (text) messages.push({ role: 'user', text, createdAt: turnCreatedAt })
      return
    }
    if (record.role !== 'assistant') return
    const text = blockText(record).replace(/\s*\[REDACTED\]\s*$/, '').trim()
    if (!text) return
    if (assistant) assistant.text += `\n\n${text}`
    else {
      assistant = { role: 'assistant', text, createdAt: turnCreatedAt }
      messages.push(assistant)
    }
  })
  return read ? messages : null
}

export const cursorSessionStore: AgentSessionStore = { title, conversation }
