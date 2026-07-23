// Horizontal switcher for the observer feed and durable Cate Agent chats.

import React from 'react'
import { Plus, X, Eye } from '@phosphor-icons/react'
import { isSidebarChat, useChatsStore } from '../../renderer/stores/chatsStore'
import { useCateAgentStore, useCateAgentWs } from './cateAgentStore'
import { cateAgentController } from './cateAgentController'
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

export const CateAgentChatTabs: React.FC<{ wsId: string; rootPath: string }> = ({ wsId, rootPath }) => {
  const cateAgent = useCateAgentWs(wsId)
  const chats = (useChatsStore((s) => s.chatsByRoot[rootPath]) ?? [])
    .filter(isSidebarChat)
  const setObserverView = useCateAgentStore((s) => s.setObserverView)
  const setActiveChat = useCateAgentStore((s) => s.setActiveChat)
  const drag = useChatDragState((state) => state.active)
  const dragDestination = useChatDragState((state) => state.destinationHostPanelId)
  const showGhost = showChatDropGhost(drag, dragDestination, rootPath, null)
  const ordered = [...chats].reverse()
  const previewItems = showGhost
    ? [...ordered, drag.chat].sort((a, b) => b.createdAt - a.createdAt)
    : ordered

  const newChat = (): void => {
    const chat = useChatsStore.getState().createChat(rootPath, 'New chat')
    setActiveChat(wsId, chat.id)
  }

  return (
    <div className="flex w-full items-center gap-1 overflow-x-auto no-scrollbar">
      <Tab active={cateAgent.observerView} onClick={() => setObserverView(wsId, true)}>
        <Eye size={12} weight={cateAgent.observerView ? 'fill' : 'regular'} style={{ color: 'rgb(var(--agent-rgb))' }} />
        <span className="truncate">Feed</span>
      </Tab>
      {previewItems.map((chat) => chat.id === drag?.chat.id && showGhost ? (
        <ChatDropGhost key={`ghost-${chat.id}`} chat={chat} compact />
      ) : (
        <Tab
          key={chat.id}
          active={!cateAgent.observerView && chat.id === cateAgent.activeChatId}
          onClick={() => setActiveChat(wsId, chat.id)}
          onClose={() => {
            void cateAgentController.closeChat(wsId, rootPath, chat.id).then((deleted) => {
              if (!deleted || chat.id !== cateAgent.activeChatId) return
              const remaining = useChatsStore.getState().getChats(rootPath).filter(isSidebarChat)
              setActiveChat(wsId, remaining[remaining.length - 1]?.id ?? '')
            })
          }}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            beginChatDrag(e.dataTransfer, { chat, rootPath, sourceHostPanelId: null })
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
  )
}
