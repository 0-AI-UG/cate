import { readFile } from 'node:fs/promises'
import type { AgentTitleResolver } from './types'

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } => (
      typeof block === 'object'
      && block !== null
      && (block as Record<string, unknown>).type === 'text'
      && typeof (block as Record<string, unknown>).text === 'string'
    ))
    .map((block) => block.text)
    .join(' ')
}

/**
 * Pi persists the active chat name in append-only `session_info` records. Its
 * session picker falls back to the first user message when the latest name is
 * absent or explicitly cleared.
 */
export const resolvePiTitle: AgentTitleResolver = async ({ event }) => {
  if (!event.sessionId || !event.transcriptPath) return null

  let contents: string
  try {
    contents = await readFile(event.transcriptPath, 'utf8')
  } catch {
    return null
  }

  let headerId: string | null = null
  let sessionName: string | undefined
  let firstUserMessage: string | null = null

  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Pi may be appending the final JSONL record while a hook is handled.
      continue
    }

    if (headerId === null) {
      if (entry.type !== 'session' || typeof entry.id !== 'string') return null
      headerId = entry.id
      continue
    }

    if (entry.type === 'session_info' && typeof entry.name === 'string') {
      sessionName = entry.name
      continue
    }

    if (firstUserMessage === null && entry.type === 'message') {
      const message = entry.message
      if (typeof message !== 'object' || message === null) continue
      const record = message as Record<string, unknown>
      if (record.role !== 'user') continue
      const text = extractMessageText(record.content)
      if (text) firstUserMessage = text
    }
  }

  if (headerId !== event.sessionId) return null
  if (sessionName?.trim()) return sessionName
  return firstUserMessage?.replace(/[\x00-\x1f\x7f]/g, ' ').trim() || null
}
