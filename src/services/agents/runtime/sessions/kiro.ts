import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { AgentConversationMessage } from '../../contract'
import { SAFE_SESSION_ID, exists, findInWorkspaceBuckets, firstInWorkspaceBuckets, forEachJsonlRecord, isoTimestamp } from './storeFiles'
import type { AgentSessionContext, AgentSessionStore } from './types'

interface KiroSessionMetadata {
  id?: unknown
  title?: unknown
}

function sessionsRoot(homeDir: string): string {
  return path.join(homeDir, '.kiro', 'sessions')
}

/**
 * Kiro CLI 2.19 stores session-picker metadata at:
 *   ~/.kiro/sessions/<opaque-workspace-key>/<session-id>/session.json
 *
 * The schema-1 metadata's `title` is the label Kiro shows for the chat. Kiro
 * rewrites this file when the title changes, so reading it on each hook also
 * observes the latest rename.
 */
async function title({ session, homeDir }: AgentSessionContext): Promise<string | null> {
  const { sessionId } = session
  return firstInWorkspaceBuckets(sessionsRoot(homeDir), sessionId, async (bucketDir) => {
    try {
      const metadata = JSON.parse(await readFile(path.join(bucketDir, sessionId, 'session.json'), 'utf8')) as KiroSessionMetadata
      return metadata.id === sessionId && typeof metadata.title === 'string' && metadata.title.trim() ? metadata.title : null
    } catch {
      // Another workspace's bucket, or Kiro is rewriting this entry. Keep
      // looking; the title tracker also retries.
      return null
    }
  })
}

/** Kiro's workspace key is sha256(realpath(workspacePaths[0])) truncated to 16
 *  hex chars (verified on Kiro CLI 2.19 data). Falls back to scanning buckets. */
async function messagesFile({ session, homeDir }: AgentSessionContext): Promise<string | null> {
  const { sessionId, cwd } = session
  if (!sessionId || !SAFE_SESSION_ID.test(sessionId)) return null
  const root = sessionsRoot(homeDir)
  if (cwd) {
    let resolved = cwd
    try { resolved = await realpath(cwd) } catch { /* keep the hook's cwd */ }
    const key = createHash('sha256').update(resolved).digest('hex').slice(0, 16)
    const candidate = path.join(root, key, sessionId, 'messages.jsonl')
    if (await exists(candidate)) return candidate
  }
  return findInWorkspaceBuckets(root, sessionId, path.join(sessionId, 'messages.jsonl'))
}

/**
 * Kiro CLI 2.19 `messages.jsonl` records are `{ id, timestamp, payload }`.
 * User turns are `payload.type: 'user'` with string content; the assistant's
 * visible reply is `payload.type: 'assistant'` with `operationType: 'Say'`
 * (one complete record per execution). Reasoning, tool calls, turn markers and
 * session metadata are skipped. File order is authoritative (timestamps can
 * invert slightly around turn boundaries).
 */
async function conversation(context: AgentSessionContext): Promise<AgentConversationMessage[] | null> {
  const file = await messagesFile(context)
  if (!file) return null
  const messages: AgentConversationMessage[] = []
  const ok = await forEachJsonlRecord(file, (record) => {
    const payload = record.payload
    if (!payload || typeof payload !== 'object') return
    const { type, content, operationType } = payload as Record<string, unknown>
    if (typeof content !== 'string' || !content.trim()) return
    let role: AgentConversationMessage['role']
    if (type === 'user') role = 'user'
    else if (type === 'assistant' && operationType === 'Say') role = 'assistant'
    else return
    const createdAt = isoTimestamp(record.timestamp)
    messages.push({ role, text: content, ...(createdAt ? { createdAt } : {}) })
  })
  return ok ? messages : null
}

export const kiroSessionStore: AgentSessionStore = { title, conversation }
