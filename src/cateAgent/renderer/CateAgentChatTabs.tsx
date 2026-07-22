// Horizontal switcher for the observer feed and durable Cate Agent chats.

import React from 'react'
import { Plus, X, Eye } from '@phosphor-icons/react'
import { useChatsStore } from '../../renderer/stores/chatsStore'
import { useCateAgentStore, useCateAgentWs } from './cateAgentStore'
import { cateAgentController } from './cateAgentController'
import { setChatDrag } from '../../renderer/drag/fileDragPayload'
import { chatDragPayload, ChatStatusGlyph } from './chatListPrimitives'

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
  const chats = useChatsStore((s) => s.chatsByRoot[rootPath]) ?? []
  const setObserverView = useCateAgentStore((s) => s.setObserverView)
  const setActiveChat = useCateAgentStore((s) => s.setActiveChat)

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
      {[...chats].reverse().map((chat) => (
        <Tab
          key={chat.id}
          active={!cateAgent.observerView && chat.id === cateAgent.activeChatId}
          onClick={() => setActiveChat(wsId, chat.id)}
          onClose={() => {
            void cateAgentController.closeChat(wsId, rootPath, chat.id).then((deleted) => {
              if (!deleted || chat.id !== cateAgent.activeChatId) return
              const remaining = useChatsStore.getState().getChats(rootPath)
              setActiveChat(wsId, remaining[remaining.length - 1]?.id ?? '')
            })
          }}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'copy'
            setChatDrag(e.dataTransfer, chatDragPayload(chat, rootPath))
          }}
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
