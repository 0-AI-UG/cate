import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { AgentTitleResolver } from './types'

interface KiroSessionMetadata {
  id?: unknown
  title?: unknown
}

/**
 * Kiro CLI 2.19 stores session-picker metadata at:
 *   ~/.kiro/sessions/<opaque-workspace-key>/<session-id>/session.json
 *
 * The schema-1 metadata's `title` is the label Kiro shows for the chat. Kiro
 * rewrites this file when the title changes, so reading it on each hook also
 * observes the latest rename.
 */
export const resolveKiroTitle: AgentTitleResolver = async ({ event, homeDir }) => {
  const sessionId = event.sessionId
  if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null

  const sessionsDir = path.join(homeDir, '.kiro', 'sessions')
  let workspaces
  try {
    workspaces = await readdir(sessionsDir, { withFileTypes: true })
  } catch {
    return null
  }

  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    try {
      const raw = await readFile(
        path.join(sessionsDir, workspace.name, sessionId, 'session.json'),
        'utf8',
      )
      const metadata = JSON.parse(raw) as KiroSessionMetadata
      if (metadata.id !== sessionId) continue
      if (typeof metadata.title === 'string' && metadata.title.trim()) return metadata.title
    } catch {
      // The session belongs to another workspace, or Kiro is currently
      // rewriting this entry. Keep looking; the title tracker also retries.
    }
  }

  return null
}
