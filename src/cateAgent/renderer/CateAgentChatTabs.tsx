// Horizontal switcher for durable main-agent chats.

import React from 'react'
import { Plus, X } from '@phosphor-icons/react'
import { isPanelChat, isSidebarChat, useChatsStore } from '../../renderer/stores/chatsStore'
import { useCateAgentStore, useCateAgentWs } from './cateAgentStore'
import { disposeDirectChatSession } from './directChatSession'
import {
  beginChatDrag,
  endChatDrag,
  showChatDropGhost,
  useChatDragState,
} from '../../renderer/drag/chatDragState'
import { ChatDropGhost, ChatStatusGlyph } from './chatListPrimitives'

const Tab: React.FC<{
  active: boolean
  onClick: () => void
  onClose?: () => void
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void
  onDragEnd?: () => void
  children: React.ReactNode
}> = ({ active, onClick, onClose, onDragStart, onDragEnd, children }) => (
  <div
    role="tab"
    aria-selected={active}
    draggable={!!onDragStart}
    onDragStart={onDragStart}
    onDragEnd={onDragEnd}
    onClick={onClick}
    className={`group/tab relative flex h-7 max-w-[168px] flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-[10px] pl-2.5 ${
      onClose ? 'pr-1' : 'pr-2.5'
    } text-[12px] transition-colors ${
      active ? 'bg-surface-2 text-primary' : 'text-muted hover:bg-hover hover:text-secondary'
    }`}
  >
    <span className="flex min-w-0 items-center gap-1.5">{children}</span>
    {onClose && (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onClose() }}
        title="Close chat"
        className={`flex-shrink-0 rounded-lg p-0.5 text-muted transition-opacity hover:bg-hover hover:text-red-400 ${
          active ? 'opacity-70' : 'opacity-0 group-hover/tab:opacity-100'
        }`}
      >
        <X size={11} />
      </button>
    )}
  </div>
)

type CateAgentChatTabsProps = {
  wsId: string
  rootPath: string
} & ({
  panelId: string
  activeChatId: string | null
  onActiveChatChange: (chatId: string | null) => void
} | {
  panelId?: undefined
  activeChatId?: never
  onActiveChatChange?: never
})

export const CateAgentChatTabs: React.FC<CateAgentChatTabsProps> = (props) => {
  const { wsId, rootPath, panelId } = props
  const cateAgent = useCateAgentWs(wsId)
  const chats = (useChatsStore((s) => s.chatsByRoot[rootPath]) ?? [])
    .filter((chat) => panelId ? isPanelChat(chat, panelId) : isSidebarChat(chat))
  const setSidebarActiveChat = useCateAgentStore((s) => s.setActiveChat)
  const drag = useChatDragState((state) => state.active)
  const dragDestination = useChatDragState((state) => state.destinationHostPanelId)
  const activeChatId = panelId ? props.activeChatId : cateAgent.activeChatId
  const showGhost = showChatDropGhost(drag, dragDestination, rootPath, panelId ?? null)
  const ordered = [...chats].reverse()
  const previewItems = showGhost
    ? [...ordered, drag.chat].sort((a, b) => b.createdAt - a.createdAt)
    : ordered

  const setActiveChat = (chatId: string | null): void => {
    if (panelId) props.onActiveChatChange(chatId)
    else setSidebarActiveChat(wsId, chatId ?? '')
  }

  const newChat = (): void => {
    const chat = useChatsStore.getState().createChat(rootPath, 'New chat', panelId)
    setActiveChat(chat.id)
  }

  return (
    <div className="cate-agent-chat-tabs min-w-0 w-full">
      <div className="cate-agent-chat-tabs-scroll flex w-full items-center gap-1 overflow-x-auto">
        {previewItems.map((chat) => chat.id === drag?.chat.id && showGhost ? (
          <ChatDropGhost key={`ghost-${chat.id}`} chat={chat} compact />
        ) : (
          <Tab
            key={chat.id}
            active={chat.id === activeChatId}
            onClick={() => setActiveChat(chat.id)}
            onClose={() => {
              disposeDirectChatSession(chat.id, wsId)
              useChatsStore.getState().removeChat(rootPath, chat.id)
              if (chat.id !== activeChatId) return
              const remaining = useChatsStore.getState().getChats(rootPath)
                .filter((candidate) => panelId
                  ? isPanelChat(candidate, panelId)
                  : isSidebarChat(candidate))
              setActiveChat(remaining[remaining.length - 1]?.id ?? null)
            }}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              beginChatDrag(e.dataTransfer, { chat, rootPath, sourceHostPanelId: panelId ?? null })
            }}
            onDragEnd={endChatDrag}
          >
            <ChatStatusGlyph chat={chat} />
            <span className="truncate">{chat.title}</span>
          </Tab>
        ))}
        <button
          type="button"
          onClick={newChat}
          title="New chat"
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[10px] text-muted transition-colors hover:bg-hover hover:text-primary"
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  )
}
