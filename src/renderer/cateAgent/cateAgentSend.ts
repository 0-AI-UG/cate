// =============================================================================
// sendCateAgentMessage — the single entry point for composing a Cate Agent
// message, shared by the sidebar tabs and the sidebar footer. From the observer
// front door (or with no active chat) it mints a NEW chat titled from the prompt;
// otherwise it composes into the selected chat. Always selects the target chat
// (clearing the observer view) so the surface grows into that transcript.
// =============================================================================

import { useChatsStore } from '../stores/chatsStore'
import { useCateAgentStore } from './cateAgentStore'
import { cateAgentController } from './cateAgentController'
import { deriveTopic } from './cateAgentTools'
import { setTargetWorktree } from './cateAgentWorktreeTarget'

export function sendCateAgentMessage(wsId: string, rootPath: string, text: string, worktreeId?: string): void {
  const chats = useChatsStore.getState()
  const cate = useCateAgentStore.getState()
  const ws = cate.byWs[wsId]
  // From the observer front door, a message always starts a NEW chat (you don't
  // reply to the observer). Otherwise it composes into the selected chat.
  let chatId = ws?.observerView ? '' : ws?.activeChatId ?? ''
  if (!chatId || !chats.getChat(rootPath, chatId)) {
    chatId = chats.createChat(rootPath, deriveTopic(text)).id
  }
  // Bind the composer's chosen worktree to the (possibly just-minted) chat, so its
  // run branches off — and lands back into — that worktree even when the pick
  // predated the chat.
  if (worktreeId) setTargetWorktree(chatId, worktreeId)
  cate.setActiveChat(wsId, chatId)
  void cateAgentController.sendMessage(wsId, rootPath, chatId, text)
}
