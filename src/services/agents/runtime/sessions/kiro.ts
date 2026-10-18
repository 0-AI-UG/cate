import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AgentConversationMessage } from '../../contract'
import { SAFE_SESSION_ID, exists, findInWorkspaceBuckets, firstInWorkspaceBuckets, forEachJsonlRecord, isoTimestamp } from './storeFiles'
import type { AgentSessionContext, AgentSessionStore, AgentUsage, AgentUsageScope } from './types'

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
 * (one complete record per execution). Kiro CLI V3 (2.32) can write several
 * Say records for one execution (a retried, continued reply) and shows them as
 * one reply: they are joined, keeping the first one's time. Reasoning, tool
 * calls, turn markers and session metadata are skipped. File order is
 * authoritative (timestamps can invert slightly around turn boundaries).
 */
async function conversation(context: AgentSessionContext): Promise<AgentConversationMessage[] | null> {
  const file = await messagesFile(context)
  if (!file) return null
  const messages: AgentConversationMessage[] = []
  let replyExecution: unknown
  const ok = await forEachJsonlRecord(file, (record) => {
    const payload = record.payload
    if (!payload || typeof payload !== 'object') return
    const { type, content, operationType, executionId } = payload as Record<string, unknown>
    if (typeof content !== 'string' || !content.trim()) return
    let role: AgentConversationMessage['role']
    if (type === 'user') role = 'user'
    else if (type === 'assistant' && operationType === 'Say') role = 'assistant'
    else return
    const last = messages.at(-1)
    if (role === 'assistant' && last?.role === 'assistant' && executionId !== undefined && executionId === replyExecution) {
      last.text += content
      return
    }
    replyExecution = role === 'assistant' ? executionId : undefined
    const createdAt = isoTimestamp(record.timestamp)
    messages.push({ role, text: content, ...(createdAt ? { createdAt } : {}) })
  })
  return ok ? messages : null
}

const files = async (context: AgentSessionContext): Promise<string[]> => {
  const file = await messagesFile(context)
  return file ? [file] : []
}

/**
 * Kiro CLI 2.19 records no tokens: a turn's `usage_summary` in
 * `messages.jsonl` holds only the credits it cost, and `session.json`'s
 * `workspacePaths` says where the session ran. The note totals the
 * workspace's credits in the window.
 */
async function kiroCredits(homeDir: string, scope: AgentUsageScope): Promise<{ credits: number; sessions: number }> {
  let credits = 0
  let sessions = 0
  const root = sessionsRoot(homeDir)
  for (const bucket of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!bucket.isDirectory()) continue
    for (const session of await readdir(path.join(root, bucket.name), { withFileTypes: true }).catch(() => [])) {
      const dir = path.join(root, bucket.name, session.name)
      const file = path.join(dir, 'messages.jsonl')
      if (!session.isDirectory() || ((await stat(file).catch(() => null))?.mtimeMs ?? 0) < scope.sinceMs) continue
      let cwd: unknown
      try {
        cwd = (JSON.parse(await readFile(path.join(dir, 'session.json'), 'utf8')) as { workspacePaths?: unknown[] }).workspacePaths?.[0]
      } catch {
        continue
      }
      if (typeof cwd !== 'string' || !await scope.contains(cwd)) continue
      let spent = 0
      await forEachJsonlRecord(file, (record) => {
        const payload = record.payload as { type?: unknown; promptTurnSummaries?: unknown } | undefined
        const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
        if (payload?.type !== 'usage_summary' || !(at >= scope.sinceMs && at < scope.untilMs) || !Array.isArray(payload.promptTurnSummaries)) return
        for (const turn of payload.promptTurnSummaries as Array<{ unit?: unknown; usage?: unknown }>) {
          if (turn?.unit === 'credit' && typeof turn.usage === 'number' && Number.isFinite(turn.usage)) spent += turn.usage
        }
      })
      if (spent > 0) {
        credits += spent
        sessions++
      }
    }
  }
  return { credits, sessions }
}

const kiroUsage: AgentUsage = {
  source: {
    kind: 'none',
    location: sessionsRoot,
    async note(homeDir, scope) {
      const { credits, sessions } = await kiroCredits(homeDir, scope)
      const spent = sessions === 0 ? '' : `: ${credits.toFixed(2)} credits across ${sessions} ${sessions === 1 ? 'session' : 'sessions'}`
      return `Kiro records credits, not tokens${spent}.`
    },
  },
}

export const kiroSessionStore: AgentSessionStore = { title, conversation, files, usage: kiroUsage }
