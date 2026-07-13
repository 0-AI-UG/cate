// =============================================================================
// CateAgentChatTabs — the sidebar's chat switcher as a horizontal, scrollable tab
// strip (an editor-style row), replacing the drop-up picker. A leading "Feed" tab
// is the observer front door; each chat is a closeable tab carrying its run-status
// dot; a trailing "+" composes a fresh chat. All of it drives the SAME shared
// cateAgentStore, so switching here is mirrored in the floating card. The row
// scrolls horizontally (no wrap) once the tabs overflow the sidebar width.
// =============================================================================

import React from 'react'
import { Plus, X, Eye } from '@phosphor-icons/react'
import { useChatsStore } from '../stores/chatsStore'
import { useCateAgentStore, useCateAgentWs } from './cateAgentStore'
import { cateAgentController } from './cateAgentController'
import type { Chat } from '../../shared/types'

// The status colour a chat's dot carries (mirrors the old picker).
const chatDotColor = (chat: Chat): string => {
  if (chat.run?.status === 'running') return '#4ade80'
  if (chat.run?.interrupted || chat.run?.status === 'review') return '#fbbf24'
  if (chat.run?.status === 'failed') return '#f87171'
  return 'var(--surface-5)'
}

const Tab: React.FC<{
  active: boolean
  onClick: () => void
  onClose?: () => void
  children: React.ReactNode
}> = ({ active, onClick, onClose, children }) => (
  <div
    role="tab"
    aria-selected={active}
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

  const observer = cateAgent.observerView
  const activeId = cateAgent.activeChatId
  // Newest chats first, matching the drop-up order they replace.
  const ordered = [...chats].reverse()

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
          onClose={() => void cateAgentController.closeChat(wsId, rootPath, chat.id)}
        >
          <span aria-hidden className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: chatDotColor(chat) }} />
          <span className="truncate">{chat.title}</span>
        </Tab>
      ))}
      <button
        type="button"
        onClick={() => setActiveChat(wsId, '')}
        title="New chat"
        className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-[10px] text-muted hover:text-primary hover:bg-hover transition-colors"
      >
        <Plus size={14} />
      </button>
    </div>
  )
}
