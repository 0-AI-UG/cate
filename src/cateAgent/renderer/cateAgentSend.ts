import { useChatsStore } from '../../renderer/stores/chatsStore'
import { useCateAgentStore } from './cateAgentStore'
import {
  promptDirectChat,
  type DirectChatTurnOptions,
} from './directChatSession'

export function deriveChatTitle(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ')
  if (!normalized) return 'New chat'
  return normalized.length > 60 ? `${normalized.slice(0, 57)}…` : normalized
}

/** Create one durable chat and start its only main-agent session. */
export function sendDirectAgentMessage(
  wsId: string,
  rootPath: string,
  text: string,
  worktreeId?: string,
  options?: DirectChatTurnOptions,
  cwd?: string,
  hostPanelId?: string,
): string {
  const chats = useChatsStore.getState()
  const chat = chats.createChat(rootPath, deriveChatTitle(text), hostPanelId, worktreeId)
  if (!hostPanelId) useCateAgentStore.getState().setActiveChat(wsId, chat.id)
  void promptDirectChat(chat, wsId, rootPath, text, options, cwd)
  return chat.id
}
