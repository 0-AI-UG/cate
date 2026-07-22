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
import { Plus, X, Eye, ChatCircle } from '@phosphor-icons/react'
import { useChatsStore, chatMode } from '../stores/chatsStore'
import { useCateAgentStore, useCateAgentWs } from './cateAgentStore'
import { cateAgentController } from './cateAgentController'
import { createCodingChatSession, disposeCodingChat } from '../../agent/renderer/agentSessionRegistry'
import { loadDefaultModel } from '../../agent/renderer/agentModelPrefs'
import { setChatDrag } from '../drag/fileDragPayload'
import type { Chat } from '../../shared/types'

// The status colour a loop chat's dot carries (mirrors the old picker).
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

// The distinguishing glyph a chat tab leads with: loop chats keep their run-status
// dot; coding chats show a brand-tinted chat bubble so the two engines read apart.
const TabGlyph: React.FC<{ chat: Chat }> = ({ chat }) =>
  chatMode(chat) === 'coding' ? (
    <ChatCircle size={12} weight="fill" className="flex-shrink-0" style={{ color: 'rgb(var(--agent-rgb))' }} />
  ) : (
    <span aria-hidden className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: chatDotColor(chat) }} />
  )

export const CateAgentChatTabs: React.FC<{ wsId: string; rootPath: string }> = ({ wsId, rootPath }) => {
  const cateAgent = useCateAgentWs(wsId)
  const chats = useChatsStore((s) => s.chatsByRoot[rootPath]) ?? []
  const setObserverView = useCateAgentStore((s) => s.setObserverView)
  const setActiveChat = useCateAgentStore((s) => s.setActiveChat)
  const [chooserOpen, setChooserOpen] = React.useState(false)

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
    setChooserOpen(false)
    // The existing lazy front-door path: observerView false so the fresh loop
    // composer shows.
    setActiveChat(wsId, '')
  }
  const newCodingChat = (): void => {
    setChooserOpen(false)
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
            setChatDrag(e.dataTransfer, {
              chatId: chat.id,
              mode: chatMode(chat),
              rootPath,
              ...(chat.agentKey ? { agentKey: chat.agentKey } : {}),
              ...(chat.sessionFile ? { sessionFile: chat.sessionFile } : {}),
              ...(chat.worktreeId ? { worktreeId: chat.worktreeId } : {}),
            })
          }}
        >
          <TabGlyph chat={chat} />
          <span className="truncate">{chat.title}</span>
        </Tab>
      ))}
      <div className="relative flex-shrink-0">
        <button
          type="button"
          onClick={() => setChooserOpen((o) => !o)}
          title="New chat"
          aria-haspopup="menu"
          aria-expanded={chooserOpen}
          className="flex items-center justify-center w-7 h-7 rounded-[10px] text-muted hover:text-primary hover:bg-hover transition-colors"
        >
          <Plus size={14} />
        </button>
        {chooserOpen && (
          <>
            {/* Click-away backdrop. */}
            <div className="fixed inset-0 z-20" onClick={() => setChooserOpen(false)} />
            <div
              role="menu"
              className="absolute left-0 top-8 z-30 min-w-[168px] rounded-lg border border-strong bg-surface-2 p-1 shadow-lg"
            >
              <button
                role="menuitem"
                type="button"
                onClick={newCodingChat}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-secondary hover:bg-hover hover:text-primary transition-colors"
              >
                <ChatCircle size={13} weight="fill" style={{ color: 'rgb(var(--agent-rgb))' }} />
                <span>New coding chat</span>
              </button>
              <button
                role="menuitem"
                type="button"
                onClick={newLoopChat}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-secondary hover:bg-hover hover:text-primary transition-colors"
              >
                <Eye size={13} style={{ color: 'rgb(var(--agent-rgb))' }} />
                <span>New loop chat</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
