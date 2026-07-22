// =============================================================================
// createSeededChatPanel — the drop half of chat drag-and-drop. Given a
// ChatDragPayload (from readChatDrag), mint a fresh agent panel and stamp it to
// open THAT chat. Shared by Canvas (floating node) and DockZone (dock tab) so the
// two surfaces seed a panel identically; dropping the same chat twice yields two
// panels that adopt the same durable chat (a live mirror).
//
// Touches only appStore + chatsStore (both terminal-free) — no cateAgentController
// import, so this stays out of the coding panel's xterm boundary.
// =============================================================================

import { useAppStore } from '../stores/appStore'
import { useChatsStore } from '../stores/chatsStore'
import type { Point } from '../../shared/types'
import type { PanelPlacement } from '../stores/appStore/types'
import type { ChatDragPayload } from './fileDragPayload'

/** Resolve the durable chat id to seed. Coding chats dragged from the recents
 *  list may lack a durable record — mint one bound to the session file so the
 *  seeded panel resumes it under a stable agentKey. */
function resolveSeedChatId(payload: ChatDragPayload): string | undefined {
  if (payload.chatId) return payload.chatId
  if (payload.mode !== 'coding' || !payload.sessionFile) return undefined
  const chats = useChatsStore.getState()
  const existing = chats
    .getChatsByMode(payload.rootPath, 'coding')
    .find((c) => c.sessionFile === payload.sessionFile)
  if (existing) return existing.id
  const agentKey = `agent-drop-${
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }`
  return chats.createCodingChat(payload.rootPath, {
    agentKey,
    sessionFile: payload.sessionFile,
    ...(payload.worktreeId ? { worktreeId: payload.worktreeId } : {}),
    title: 'Chat',
  }).id
}

export function createSeededChatPanel(
  wsId: string,
  payload: ChatDragPayload,
  position?: Point,
  placement?: PanelPlacement,
): string | null {
  if (!wsId) return null
  const chatId = resolveSeedChatId(payload)
  const store = useAppStore.getState()
  const panelId = store.createAgent(wsId, position, placement)
  if (!panelId) return null
  if (chatId) store.setPanelInitialChat(wsId, panelId, chatId)
  // A coding chat's worktree is its checkout — spawn pi there. Loop chats manage
  // their own worktrees on the run, so their panel takes no worktree tag.
  if (payload.mode === 'coding' && payload.worktreeId) {
    store.setPanelWorktreeId(wsId, panelId, payload.worktreeId)
  }
  return panelId
}
