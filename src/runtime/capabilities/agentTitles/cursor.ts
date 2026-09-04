import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { AgentTitleResolver } from './types'

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
export const resolveCursorTitle: AgentTitleResolver = async ({ event, homeDir }) => {
  const sessionId = event.sessionId
  if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null

  let workspaces
  try {
    workspaces = await readdir(path.join(homeDir, '.cursor', 'chats'), { withFileTypes: true })
  } catch {
    return null
  }

  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    try {
      const raw = await readFile(
        path.join(homeDir, '.cursor', 'chats', workspace.name, sessionId, 'meta.json'),
        'utf8',
      )
      const meta = JSON.parse(raw) as CursorChatMeta
      if (typeof meta.title === 'string' && meta.title.trim() !== '') return meta.title
    } catch {
      // The conversation belongs to another workspace, or this entry is
      // incomplete/corrupt. Keep looking for the matching conversation id.
    }
  }

  return null
}
