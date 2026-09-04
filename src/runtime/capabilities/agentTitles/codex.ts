import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentTitleResolver } from './types'

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
export const resolveCodexTitle: AgentTitleResolver = async ({ event, homeDir }) => {
  if (!event.sessionId) return null

  let contents: string
  try {
    contents = await readFile(path.join(homeDir, '.codex', 'session_index.jsonl'), 'utf8')
  } catch {
    return null
  }

  let title: string | null = null
  for (const line of contents.split('\n')) {
    if (!line) continue
    try {
      const entry: unknown = JSON.parse(line)
      if (isSessionIndexEntry(entry) && entry.id === event.sessionId) {
        title = entry.thread_name
      }
    } catch {
      // A concurrently appended final line may be incomplete. Earlier complete
      // entries remain usable, and the title tracker retries this resolver.
    }
  }
  return title
}
