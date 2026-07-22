// Shared chat-list primitives used by the sidebar tabs and floating panel.

import React from 'react'
import { chatDotColor } from '../../renderer/stores/chatsStore'
import type { ChatDragPayload } from '../../renderer/drag/fileDragPayload'
import type { Chat } from '../../shared/types'

export function chatDragPayload(chat: Chat, rootPath: string): ChatDragPayload {
  return { chatId: chat.id, rootPath }
}

/** A chat's current run state. Conversation and autonomous work are capabilities
 * of the same Cate Agent, so the glyph communicates activity rather than mode. */
export const ChatStatusGlyph: React.FC<{ chat: Chat }> = ({ chat }) => (
  <span
    aria-hidden
    className="h-2 w-2 flex-shrink-0 rounded-full"
    style={{ backgroundColor: chatDotColor(chat) }}
  />
)
