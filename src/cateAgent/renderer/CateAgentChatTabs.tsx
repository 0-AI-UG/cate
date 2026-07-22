// =============================================================================
// CateAgentChatTabs — the sidebar's chat switcher as a horizontal, scrollable tab
// strip (an editor-style row), replacing the drop-up picker. A leading "Feed" tab
// is the observer front door; each chat is a closeable tab — loop chats carry
// their run-status dot, coding chats a brand-tinted chat glyph — and a trailing
// "+" opens a Coding / Loop chooser for a fresh chat. All of it drives the SAME
// shared cateAgentStore + chatsStore, so switching here is mirrored in the
// floating card. The row scrolls horizontally (no wrap) once the tabs overflow.
// =============================================================================

import React from 'react'
import { Plus, X, Eye } from '@phosphor-icons/react'
import { useChatsStore, chatMode } from '../../renderer/stores/chatsStore'
import { useCateAgentStore, useCateAgentWs } from './cateAgentStore'
import { cateAgentController } from './cateAgentController'
import { createCodingChatSession, disposeCodingChat } from './codingSessionRegistry'
import { loadDefaultModel } from './codingModelPrefs'
import { setChatDrag } from '../../renderer/drag/fileDragPayload'
import { chatDragPayload, ChatModeGlyph, NewChatChooser } from './chatListPrimitives'
import type { Chat } from '../../shared/types'

const Tab: React.FC<{
  active: boolean
  onClick: () => void
  onClose?: () => void
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void
  children: React.ReactNode
}> = ({ active, onClick, onClose, onDragStart, children }) => (
  <div
    role="tab"
    aria-selected={active}
    draggable={!!onDragStart}
    onDragStart={onDragStart}
    onClick={onClick}
    className={`group/tab relative flex flex-shrink-0 items-center gap-1.5 h-7 max-w-[168px] pl-2.5 ${
      onClose ? 'pr-1' : 'pr-2.5'
    } rounded-[10px] text-[12px] cursor-pointer transition-colors ${
      active ? 'bg-surface-2 text-primary' : 'text-muted hover:text-secondary hover:bg-hover'
    }`}
  >
    <span className="flex min-w-0 items-center gap-1.5">{children}</span>
    {onClose && (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        title="Close chat"
        className={`flex-shrink-0 p-0.5 rounded-lg text-muted hover:text-red-400 hover:bg-hover transition-opacity ${
          active ? 'opacity-70' : 'opacity-0 group-hover/tab:opacity-100'
        }`}
      >
        <X size={11} />
      </button>
    )}
  </div>
)

export const CateAgentChatTabs: React.FC<{ wsId: string; rootPath: string }> = ({ wsId, rootPath }) => {
  const cateAgent = useCateAgentWs(wsId)
  const chats = useChatsStore((s) => s.chatsByRoot[rootPath]) ?? []
  const setObserverView = useCateAgentStore((s) => s.setObserverView)
  const setActiveChat = useCateAgentStore((s) => s.setActiveChat)
  const [chooserOpen, setChooserOpen] = React.useState(false)
  const plusRef = React.useRef<HTMLButtonElement>(null)

  const observer = cateAgent.observerView
  const activeId = cateAgent.activeChatId
  // Both engines share chats.json and now both live in this strip. Newest first,
  // matching the drop-up order they replace.
  const ordered = [...chats].reverse()

  // Close a chat by its engine: loop keeps its controller close; coding fully
  // deletes the durable record + pi session, matching the panel's per-tab close.
  const closeChat = (chat: Chat): void => {
    if (chatMode(chat) === 'coding') disposeCodingChat(rootPath, chat.id)
    else void cateAgentController.closeChat(wsId, rootPath, chat.id)
  }

  const newLoopChat = (): void => {
    // The existing lazy front-door path: observerView false so the fresh loop
    // composer shows.
    setActiveChat(wsId, '')
  }
  const newCodingChat = (): void => {
    const { chatId } = createCodingChatSession(rootPath, {
      workspaceId: wsId,
      cwd: rootPath,
      model: loadDefaultModel(),
    })
    setActiveChat(wsId, chatId)
  }

  return (
    <div className="flex items-center gap-1 overflow-x-auto no-scrollbar w-full">
      <Tab active={observer} onClick={() => setObserverView(wsId, true)}>
        <Eye size={12} weight={observer ? 'fill' : 'regular'} style={{ color: 'rgb(var(--agent-rgb))' }} />
        <span className="truncate">Feed</span>
      </Tab>
      {ordered.map((chat) => (
        <Tab
          key={chat.id}
          active={!observer && chat.id === activeId}
          onClick={() => setActiveChat(wsId, chat.id)}
          onClose={() => closeChat(chat)}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'copy'
            setChatDrag(e.dataTransfer, chatDragPayload(chat, rootPath))
          }}
        >
          <ChatModeGlyph chat={chat} />
          <span className="truncate">{chat.title}</span>
        </Tab>
      ))}
      <div className="relative flex-shrink-0">
        <button
          ref={plusRef}
          type="button"
          onClick={() => setChooserOpen((o) => !o)}
          title="New chat"
          aria-haspopup="menu"
          aria-expanded={chooserOpen}
          className="flex items-center justify-center w-7 h-7 rounded-[10px] text-muted hover:text-primary hover:bg-hover transition-colors"
        >
          <Plus size={14} />
        </button>
        <NewChatChooser
          open={chooserOpen}
          onOpenChange={setChooserOpen}
          onNewCoding={newCodingChat}
          onNewLoop={newLoopChat}
          anchorRef={plusRef}
        />
      </div>
    </div>
  )
}
