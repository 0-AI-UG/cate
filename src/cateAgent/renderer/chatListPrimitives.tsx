// =============================================================================
// chatListPrimitives — the shared building blocks the two chat-switcher surfaces
// (the right-sidebar tab strip in CateAgentChatTabs and the floating panel's rail
// in CateAgentPanelSidebar) both used to duplicate: the chat drag payload, the coding/loop
// mode glyph, and the portalled New-chat chooser. One definition, two hosts.
// =============================================================================

import React from 'react'
import { createPortal } from 'react-dom'
import { ChatCircle, Eye } from '@phosphor-icons/react'
import { chatMode, chatDotColor } from '../../renderer/stores/chatsStore'
import type { ChatDragPayload } from '../../renderer/drag/fileDragPayload'
import type { Chat } from '../../shared/types'

/** The drag payload a chat row/tab hands off. Coding chats carry their optional
 *  agentKey/sessionFile/worktreeId so a drop can resume the pi session; a loop
 *  chat is just its durable id + mode + root. */
export function chatDragPayload(chat: Chat, rootPath: string): ChatDragPayload {
  const mode = chatMode(chat)
  if (mode === 'loop') return { chatId: chat.id, mode: 'loop', rootPath }
  return {
    chatId: chat.id,
    mode,
    rootPath,
    ...(chat.agentKey ? { agentKey: chat.agentKey } : {}),
    ...(chat.sessionFile ? { sessionFile: chat.sessionFile } : {}),
    ...(chat.worktreeId ? { worktreeId: chat.worktreeId } : {}),
  }
}

// The distinguishing glyph a chat leads with: loop chats keep their run-status
// dot; coding chats show a brand-tinted chat bubble so the two engines read apart.
export const ChatModeGlyph: React.FC<{ chat: Chat; size?: number }> = ({ chat, size = 12 }) =>
  chatMode(chat) === 'coding' ? (
    <ChatCircle size={size} weight="fill" className="flex-shrink-0" style={{ color: 'rgb(var(--agent-rgb))' }} />
  ) : (
    <span aria-hidden className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: chatDotColor(chat) }} />
  )

/** The New-chat chooser (Coding / Loop), portalled to <body> so it escapes any
 *  overflow-clipping host (the tab strip's overflow-x-auto clips both axes) and is
 *  anchored under the trigger via its rect. The trigger "+" button stays in each
 *  host — only this menu is shared. */
export const NewChatChooser: React.FC<{
  open: boolean
  onOpenChange: (open: boolean) => void
  onNewCoding: () => void
  onNewLoop: () => void
  anchorRef: React.RefObject<HTMLElement>
}> = ({ open, onOpenChange, onNewCoding, onNewLoop, anchorRef }) => {
  if (!open) return null
  const rect = anchorRef.current?.getBoundingClientRect()
  return createPortal(
    <>
      {/* Click-away backdrop. */}
      <div className="fixed inset-0 z-20" onClick={() => onOpenChange(false)} />
      <div
        role="menu"
        className="fixed z-30 min-w-[168px] rounded-lg border border-strong bg-surface-2 p-1 shadow-lg"
        style={{ top: (rect?.bottom ?? 0) + 4, left: rect?.left ?? 0 }}
      >
        <button
          role="menuitem"
          type="button"
          onClick={() => { onOpenChange(false); onNewCoding() }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-secondary hover:bg-hover hover:text-primary transition-colors"
        >
          <ChatCircle size={13} weight="fill" style={{ color: 'rgb(var(--agent-rgb))' }} />
          <span>New coding chat</span>
        </button>
        <button
          role="menuitem"
          type="button"
          onClick={() => { onOpenChange(false); onNewLoop() }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-secondary hover:bg-hover hover:text-primary transition-colors"
        >
          <Eye size={13} style={{ color: 'rgb(var(--agent-rgb))' }} />
          <span>New loop chat</span>
        </button>
      </div>
    </>,
    document.body,
  )
}
