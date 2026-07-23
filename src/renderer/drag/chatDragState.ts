import { create } from 'zustand'
import type { Chat } from '../../shared/types'
import { setChatDrag } from './fileDragPayload'

export interface ChatDragPreview {
  chat: Chat
  rootPath: string
  /** null is the workspace sidebar; a string is an Agent panel. */
  sourceHostPanelId: string | null
}

interface ChatDragState {
  active: ChatDragPreview | null
  /** undefined means the pointer is not over a chat host. */
  destinationHostPanelId: string | null | undefined
  setDestination: (hostPanelId: string | null | undefined) => void
  clear: () => void
}

export const useChatDragState = create<ChatDragState>((set) => ({
  active: null,
  destinationHostPanelId: undefined,
  setDestination: (destinationHostPanelId) => set({ destinationHostPanelId }),
  clear: () => set({ active: null, destinationHostPanelId: undefined }),
}))

export function beginChatDrag(dataTransfer: DataTransfer, preview: ChatDragPreview): void {
  setChatDrag(dataTransfer, { chatId: preview.chat.id, rootPath: preview.rootPath })
  useChatDragState.setState({ active: preview, destinationHostPanelId: undefined })
}

export function endChatDrag(): void {
  useChatDragState.getState().clear()
}

export function showChatDropGhost(
  active: ChatDragPreview | null,
  destinationHostPanelId: string | null | undefined,
  rootPath: string,
  hostPanelId: string | null,
): active is ChatDragPreview {
  return !!active
    && active.rootPath === rootPath
    && active.sourceHostPanelId !== hostPanelId
    && destinationHostPanelId === hostPanelId
}
