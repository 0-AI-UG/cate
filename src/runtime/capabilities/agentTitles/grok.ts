import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentTitleResolver } from './types'

interface GrokSessionSummary {
  generated_title?: unknown
}

/**
 * Grok Build 0.2.106 keeps the title shown by its session picker in
 * `summary.json.generated_title`, next to the hook-provided `updates.jsonl`.
 * `/rename` overwrites that same field and sets `title_is_manual`; therefore
 * reading the current summary also picks up the latest manual rename.
 * `session_summary` is separate conversation metadata, not the picker title.
 */
export const resolveGrokTitle: AgentTitleResolver = async ({ event }) => {
  if (!event.sessionId || !event.transcriptPath) return null

  try {
    const raw = await readFile(path.join(path.dirname(event.transcriptPath), 'summary.json'), 'utf8')
    const summary: unknown = JSON.parse(raw)
    if (typeof summary !== 'object' || summary === null) return null

    const title = (summary as GrokSessionSummary).generated_title
    return typeof title === 'string' && title.trim() ? title : null
  } catch {
    return null
  }
}
