// =============================================================================
// createSeededChatPanel — the drop half of chat drag-and-drop. Given a
// ChatDragPayload (from readChatDrag), mint a fresh agent panel and stamp it to
// open THAT chat. Shared by Canvas (floating node) and DockZone (dock tab) so the
// two surfaces seed a panel identically. The chat moves to the new panel; it is
// no longer rendered by its source panel/sidebar.
//
// Panel placement lives in appStore; durable chat ownership lives in chatsStore.
// =============================================================================

import { useAppStore } from '../stores/appStore'
import { useChatsStore } from '../stores/chatsStore'
import type { Point } from '../../shared/types'
import type { PanelPlacement } from '../stores/appStore/types'
import type { ChatDragPayload } from './fileDragPayload'

export function createSeededChatPanel(
  wsId: string,
  payload: ChatDragPayload,
  position?: Point,
  placement?: PanelPlacement,
): string | null {
  if (!wsId) return null
  const store = useAppStore.getState()
  const workspace = store.workspaces.find((candidate) => candidate.id === wsId)
  if (!workspace || workspace.rootPath !== payload.rootPath) return null
  const panelId = store.createCateAgent(wsId, position, placement)
  if (!panelId) return null
  store.setPanelInitialChat(wsId, panelId, payload.chatId)
  const chats = useChatsStore.getState()
  if (chats.loadedRoots[payload.rootPath]) {
    chats.moveChat(payload.rootPath, payload.chatId, panelId)
  } else {
    void chats.loadChats(payload.rootPath)
      .then(() => useChatsStore.getState().moveChat(payload.rootPath, payload.chatId, panelId))
      .catch(() => {
        // The new panel still opens; its normal load state will surface the
        // unavailable workspace without corrupting the source chat.
      })
  }
  return panelId
}
