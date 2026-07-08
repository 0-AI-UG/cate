// =============================================================================
// CateAgentChatPicker — the chat selector that replaces the old tab strip. It
// sits in the toolbar bar (left of the input) and names what the window is
// showing: the Observer (the default front door), a specific chat, or a fresh
// "New chat". Clicking it opens a drop-up list of all of those.
//
// Picking the Observer keeps the window compact (a read-only feed); picking a
// chat clears the observer view and grows the window into that chat's transcript
// (see cateAgentStore.observerView + CateAgentChat).
// =============================================================================

import React from 'react'
import { createPortal } from 'react-dom'
import { CaretDown, Plus, X } from '@phosphor-icons/react'
import { useChatsStore } from '../stores/chatsStore'
import { useCateAgentStore, useCateAgentWs } from './cateAgentStore'
import { cateAgentController } from './cateAgentController'
import type { Chat } from '../../shared/types'

// The status colour a chat's dot carries in the list (mirrors the old tab dot).
const chatDotColor = (chat: Chat): string => {
  if (chat.run?.status === 'running') return 'var(--green, #4ade80)'
  if (chat.run?.interrupted || chat.run?.status === 'review') return '#fbbf24'
  if (chat.run?.status === 'failed') return '#f87171'
  return 'var(--surface-5)'
}

const AGENT_DOT: React.CSSProperties = {
  backgroundColor: 'rgb(var(--agent-rgb))',
  boxShadow: '0 0 0 2.5px color-mix(in srgb, rgb(var(--agent-rgb)) 18%, transparent)',
}

export const CateAgentChatPicker: React.FC<{ workspaceId: string; rootPath: string }> = ({ workspaceId, rootPath }) => {
  const wsId = workspaceId
  const cateAgent = useCateAgentWs(wsId)
  const chats = useChatsStore((s) => s.chatsByRoot[rootPath]) ?? []
  const setObserverView = useCateAgentStore((s) => s.setObserverView)
  const setActiveChat = useCateAgentStore((s) => s.setActiveChat)

  const [open, setOpen] = React.useState(false)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const btnRef = React.useRef<HTMLButtonElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)

  // The popover is rendered in a PORTAL (fixed-positioned above the button), so it
  // escapes the toolbar zone's overflow-hidden clip and stacks above the window.
  const [pos, setPos] = React.useState<{ left: number; bottom: number } | null>(null)
  React.useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect()
      if (r) setPos({ left: r.left, bottom: window.innerHeight - r.top + 8 })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  // Close on any click outside the picker or its (portaled) menu, or on Escape.
  React.useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!rootRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const observer = cateAgent.observerView
  const activeChat = cateAgent.activeChatId ? chats.find((c) => c.id === cateAgent.activeChatId) : undefined

  // What the collapsed pill shows.
  const label = observer ? 'Feed' : activeChat ? activeChat.title : 'New chat'

  const pickObserver = () => {
    setObserverView(wsId, true)
    setOpen(false)
  }
  const pickChat = (chatId: string) => {
    setActiveChat(wsId, chatId) // clears observerView
    setOpen(false)
  }
  const pickNew = () => {
    setActiveChat(wsId, '') // clears observerView; composes a fresh chat
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="relative flex-shrink-0">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Choose chat"
        className="flex items-center gap-1.5 h-[30px] max-w-[168px] pl-2.5 pr-1.5 rounded-full border border-subtle bg-surface-1 hover:bg-surface-2 hover:border-strong transition-colors"
      >
        <span className="min-w-0 truncate text-[12px] text-secondary">{label}</span>
        <CaretDown size={11} weight="bold" className={`flex-shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label="Chats"
          className="fixed w-[236px] p-1.5 rounded-xl border border-strong bg-surface-0 shadow-[0_12px_30px_-8px_rgba(0,0,0,0.6)]"
          style={{ left: pos.left, bottom: pos.bottom, zIndex: 60 }}
        >
          <Option selected={observer} onClick={pickObserver}>
            <span aria-hidden className="w-2 h-2 rounded-full flex-shrink-0" style={AGENT_DOT} />
            <span className="flex-1 truncate">Feed</span>
          </Option>

          {chats.length > 0 && (
            <>
              <div className="h-px my-1.5 mx-1" style={{ backgroundColor: 'var(--border-subtle)' }} />
              <GroupLabel>Chats</GroupLabel>
              {[...chats].reverse().map((chat) => (
                <Option key={chat.id} selected={!observer && chat.id === cateAgent.activeChatId} onClick={() => pickChat(chat.id)}>
                  <span aria-hidden className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: chatDotColor(chat) }} />
                  <span className="flex-1 truncate">{chat.title}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      void cateAgentController.closeChat(wsId, rootPath, chat.id)
                    }}
                    title="Delete chat"
                    className="flex-shrink-0 -mr-0.5 p-0.5 rounded text-muted opacity-0 group-hover/opt:opacity-100 hover:text-red-400 hover:bg-hover transition-opacity"
                  >
                    <X size={11} />
                  </button>
                </Option>
              ))}
            </>
          )}

          <div className="h-px my-1.5 mx-1" style={{ backgroundColor: 'var(--border-subtle)' }} />
          <Option onClick={pickNew}>
            <span className="flex-shrink-0 flex items-center justify-center w-2 h-2" style={{ color: 'rgb(var(--agent-rgb))' }}>
              <Plus size={12} weight="bold" />
            </span>
            <span className="flex-1 truncate" style={{ color: 'rgb(var(--agent-rgb))' }}>New chat</span>
          </Option>
        </div>,
        document.body,
      )}
    </div>
  )
}

const GroupLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-2 pt-1.5 pb-1 font-mono text-[9.5px] tracking-[0.1em] uppercase text-muted">{children}</div>
)

const Option: React.FC<{ selected?: boolean; onClick: () => void; children: React.ReactNode }> = ({ selected, onClick, children }) => (
  <button
    type="button"
    role="option"
    aria-selected={selected}
    onClick={onClick}
    className={`group/opt flex items-center gap-2.5 w-full px-2 py-1.5 rounded-md text-left text-[12.5px] transition-colors ${
      selected ? 'text-primary' : 'text-secondary hover:text-primary hover:bg-hover'
    }`}
    style={selected ? { backgroundColor: 'color-mix(in srgb, rgb(var(--agent-rgb)) 14%, transparent)' } : undefined}
  >
    {children}
  </button>
)
