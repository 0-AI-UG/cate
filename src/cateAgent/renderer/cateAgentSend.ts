// =============================================================================
// One chat, two explicit send paths:
// - sendDirectAgentMessage starts the normal full-capability front agent.
// - sendCateAgentMessage continues a chat after iteration engineering owns it.
// Only the approved engineering_task handoff crosses between those layers.
// =============================================================================

import { useChatsStore } from '../../renderer/stores/chatsStore'
import { useCateAgentStore } from './cateAgentStore'
import { cateAgentController } from './cateAgentController'
import { deriveTopic } from './cateAgentTools'
import { setTargetWorktree } from './cateAgentWorktreeTarget'
import type { CateAgentTurnOptions } from './cateAgentController'
import { promptDirectChat } from './directChatSession'

/** Start a normal full-capability chat turn. This is the only entry point used
 * before a chat has explicitly handed ownership to iteration engineering. */
export function sendDirectAgentMessage(
  wsId: string,
  rootPath: string,
  text: string,
  worktreeId?: string,
  options?: CateAgentTurnOptions,
  cwd?: string,
  hostPanelId?: string,
): string {
  const chats = useChatsStore.getState()
  const chat = hostPanelId
    ? chats.createChat(rootPath, deriveTopic(text), hostPanelId)
    : chats.createChat(rootPath, deriveTopic(text))
  if (worktreeId) setTargetWorktree(chat.id, worktreeId)
  if (!hostPanelId) useCateAgentStore.getState().setActiveChat(wsId, chat.id)
  void promptDirectChat(chat, wsId, rootPath, text, options, cwd)
  return chat.id
}

export function sendCateAgentMessage(
  wsId: string,
  rootPath: string,
  text: string,
  worktreeId?: string,
  /** undefined follows the workspace selection; null explicitly starts a chat. */
  selectedChatId?: string | null,
  options?: CateAgentTurnOptions,
): string {
  const chats = useChatsStore.getState()
  const cate = useCateAgentStore.getState()
  const ws = cate.byWs[wsId]
  // From the observer front door, a message always starts a NEW chat (you don't
  // reply to the observer). Otherwise it composes into the selected chat.
  let chatId = selectedChatId === undefined
    ? ws?.observerView ? '' : ws?.activeChatId ?? ''
    : selectedChatId ?? ''
  let targetChat = chatId ? chats.getChat(rootPath, chatId) : undefined
  if (!targetChat) {
    targetChat = chats.createChat(rootPath, deriveTopic(text))
    chatId = targetChat.id
  }
  // Bind the composer's chosen worktree to the (possibly just-minted) chat, so its
  // run branches off — and lands back into — that worktree even when the pick
  // predated the chat.
  if (worktreeId) setTargetWorktree(chatId, worktreeId)
  if (selectedChatId === undefined) cate.setActiveChat(wsId, chatId)
  const chat = targetChat
  // Keep the architectural boundary enforced at the send primitive too: an
  // untransferred (or newly created) chat always goes through the direct agent.
  // Typed messages/runs are accepted for loop-first records created by older
  // builds, which have no explicit engineeringTask marker.
  if (chat && !chat.engineeringTask && chat.messages.length === 0 && !chat.run) {
    void promptDirectChat(chat, wsId, rootPath, text, options)
    return chatId
  }
  if (options) void cateAgentController.sendMessage(wsId, rootPath, chatId, text, options)
  else void cateAgentController.sendMessage(wsId, rootPath, chatId, text)
  return chatId
}
