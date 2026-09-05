import path from 'node:path'
import type { AgentTitleResolver } from './types'

interface OpenCodeSessionRow {
  title?: unknown
}

/**
 * OpenCode 1.18.3 stores the session-picker title in the `title` column of the
 * `session` table in `~/.local/share/opencode/opencode.db`. Session ids are the
 * table's primary key, and generated titles replace the value in place.
 */
export const resolveOpenCodeTitle: AgentTitleResolver = async ({ event, homeDir }) => {
  if (!event.sessionId) return null

  try {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(
      path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db'),
      { readOnly: true },
    )
    try {
      const row = database.prepare('SELECT title FROM session WHERE id = ? LIMIT 1')
        .get(event.sessionId) as OpenCodeSessionRow | undefined
      return typeof row?.title === 'string' && row.title.trim() ? row.title : null
    } finally {
      database.close()
    }
  } catch {
    return null
  }
}
