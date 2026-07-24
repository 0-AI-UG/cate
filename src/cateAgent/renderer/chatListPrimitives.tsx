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

export const ChatDropGhost: React.FC<{ chat: Chat; compact?: boolean }> = ({ chat, compact = false }) => (
  <div
    data-chat-drop-ghost
    aria-hidden
    className={`pointer-events-none flex min-w-0 items-center gap-1.5 rounded-md border border-dashed border-agent/60 bg-agent/10 text-primary opacity-70 ${
      compact ? 'h-7 max-w-[168px] flex-shrink-0 px-2.5 text-[12px]' : 'mx-1 px-2 py-1 text-[11.5px]'
    }`}
  >
    <ChatStatusGlyph chat={chat} />
    <span className="truncate">{chat.title}</span>
  </div>
)
