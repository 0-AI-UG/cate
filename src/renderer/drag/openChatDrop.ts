// =============================================================================
// createSeededChatPanel — the drop half of chat drag-and-drop. Given a
// ChatDragPayload (from readChatDrag), mint a fresh agent panel and stamp it to
// open THAT chat. Shared by Canvas (floating node) and DockZone (dock tab) so the
// two surfaces seed a panel identically; dropping the same chat twice yields two
// panels that adopt the same durable chat (a live mirror).
//
// Touches only appStore; the durable chat remains owned by chatsStore.
// =============================================================================

import { useAppStore } from '../stores/appStore'
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
  const panelId = store.createCateAgent(wsId, position, placement)
  if (!panelId) return null
  store.setPanelInitialChat(wsId, panelId, payload.chatId)
  return panelId
}
