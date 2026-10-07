import path from 'node:path'
import type { AgentConversationMessage } from '../../contract'
import { SAFE_SESSION_ID, exists, findInWorkspaceBuckets, forEachJsonlRecord, isoTimestamp, object } from './storeFiles'
import type { AgentSessionContext, AgentSessionStore } from './types'

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

export const claudeSessionStore: AgentSessionStore = { title, conversation, files }
