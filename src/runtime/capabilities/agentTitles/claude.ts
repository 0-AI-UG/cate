import { readFile } from 'node:fs/promises'
import type { AgentTitleResolver } from './types'

interface ClaudeAiTitleRecord {
  type: 'ai-title'
  aiTitle: string
  sessionId: string
}

function isAiTitleRecord(value: unknown): value is ClaudeAiTitleRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.type === 'ai-title'
    && typeof record.aiTitle === 'string'
    && typeof record.sessionId === 'string'
}

/**
 * Claude Code 2.1.222 writes its session-picker title into the session JSONL as
 * `{type:"ai-title", aiTitle:string, sessionId:string}`. Records are repeated
 * and may change, so the final matching record is authoritative.
 */
export const resolveClaudeTitle: AgentTitleResolver = async ({ event }) => {
  if (!event.sessionId || !event.transcriptPath) return null

  let contents: string
  try {
    contents = await readFile(event.transcriptPath, 'utf8')
  } catch {
    return null
  }

  const lines = contents.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line) continue
    try {
      const record: unknown = JSON.parse(line)
      if (isAiTitleRecord(record)
        && record.sessionId === event.sessionId
        && record.aiTitle.trim()) {
        return record.aiTitle
      }
    } catch {
      // Claude may be appending the final JSONL record while a hook is handled.
    }
  }
  return null
}
