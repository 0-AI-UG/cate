// =============================================================================
// CateAgentPanelSidebar — chat-list rail for CateAgentPanel. Lists the panel's DURABLE chats
// for this checkout: coding chats (chatsStore, mode 'coding') and loop chats
// (mode 'loop'), each with per-row open/delete, plus the New-chat chooser and the
// settings entry. Pure presentation; all state and IPC live in CateAgentPanel.
//
// Both sections read the same durable `Chat.title` every other chat surface shows
// (the panel keeps it current), so the panel and the right-sidebar list agree.
// =============================================================================

import { useMemo, useRef, useState } from 'react'
import {
  Plus,
  Sidebar as SidebarIcon,
  Gear,
  Trash,
} from '@phosphor-icons/react'
import type { Chat } from '../../shared/types'
import { Tooltip } from '../../renderer/ui/Tooltip'
import { setChatDrag } from '../../renderer/drag/fileDragPayload'
import { chatDragPayload, ChatModeGlyph, NewChatChooser } from './chatListPrimitives'
import { useCodingStore } from './codingStore'

export function CateAgentPanelSidebar({
  codingChats,
  activeCodingChatId,
  rootPath,
  loopChats,
  activeLoopChatId,
  onNewCodingChat,
  onNewLoopChat,
  onOpenCodingChat,
  onOpenLoopChat,
  onDeleteCodingChat,
  onDeleteLoopChat,
  onOpenSettings,
  onCollapse,
  settingsActive,
}: {
  codingChats: Chat[]
  activeCodingChatId: string | null
  rootPath: string
  loopChats: Chat[]
  activeLoopChatId: string | null
  onNewCodingChat: () => void
  onNewLoopChat: () => void
  onOpenCodingChat: (chatId: string) => void
  onOpenLoopChat: (chatId: string) => void
  onDeleteCodingChat: (chatId: string) => void
  onDeleteLoopChat: (chatId: string) => void
  onOpenSettings: () => void
  onCollapse: () => void
  settingsActive: boolean
}) {
  // Both lists newest-first, matching the tab strip's order.
  const orderedCoding = useMemo(() => [...codingChats].reverse(), [codingChats])
  const orderedLoops = useMemo(() => [...loopChats].reverse(), [loopChats])
  const [chooserOpen, setChooserOpen] = useState(false)
  const plusRef = useRef<HTMLButtonElement>(null)

  return (
    <div className="w-[200px] shrink-0 flex flex-col border-r border-subtle bg-surface-0 min-h-0">
      <div className="flex items-center gap-1 px-2 h-10 border-b border-subtle shrink-0">
        <Tooltip label="Collapse sidebar">
          <button
            onClick={onCollapse}
            className="p-1.5 rounded-md text-muted hover:text-primary hover:bg-hover"
            aria-label="Collapse sidebar"
          >
            <SidebarIcon size={14} />
          </button>
        </Tooltip>
        <div className="flex-1" />
        <div className="relative">
          <Tooltip label="New chat">
            <button
              ref={plusRef}
              onClick={() => setChooserOpen((o) => !o)}
              className="p-1.5 rounded-md text-agent-light hover:text-primary hover:bg-agent/20"
              aria-label="New chat"
              aria-haspopup="menu"
              aria-expanded={chooserOpen}
            >
              <Plus size={14} />
            </button>
          </Tooltip>
          <NewChatChooser
            open={chooserOpen}
            onOpenChange={setChooserOpen}
            onNewCoding={onNewCodingChat}
            onNewLoop={onNewLoopChat}
            anchorRef={plusRef}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-1 pt-2 pb-2 min-h-0">
        {orderedLoops.length > 0 && (
          <div className="mb-3">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted/70 font-semibold">
              Loops
            </div>
            {orderedLoops.map((chat) => (
              <LoopRow
                key={chat.id}
                chat={chat}
                rootPath={rootPath}
                active={chat.id === activeLoopChatId}
                onOpen={() => onOpenLoopChat(chat.id)}
                onDelete={() => onDeleteLoopChat(chat.id)}
              />
            ))}
          </div>
        )}
        {orderedCoding.length === 0 && orderedLoops.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-muted">
            No chats yet.
          </div>
        ) : (
          orderedCoding.map((chat) => (
            <CodingRow
              key={chat.id}
              chat={chat}
              rootPath={rootPath}
              active={chat.id === activeCodingChatId}
              onOpen={() => onOpenCodingChat(chat.id)}
              onDelete={() => onDeleteCodingChat(chat.id)}
            />
          ))
        )}
      </div>

      <div className="p-2 shrink-0">
        <button
          onClick={onOpenSettings}
          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] ${
            settingsActive
              ? 'bg-hover-strong text-primary'
              : 'text-muted hover:bg-hover hover:text-primary'
          }`}
        >
          <Gear size={12} />
          Settings
        </button>
      </div>
    </div>
  )
}

function CodingRow({
  chat,
  rootPath,
  active,
  onOpen,
  onDelete,
}: {
  chat: Chat
  rootPath: string
  active: boolean
  onOpen: () => void
  onDelete: () => void
}) {
  // The chat's live pi running flag drives the run dot; a coding row is always
  // "live" in the panel (it's an open chat), so the dot marks an in-flight turn.
  const running = useCodingStore((s) =>
    chat.agentKey ? s.panels[chat.agentKey]?.running ?? false : false,
  )
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'copy'
        setChatDrag(e.dataTransfer, chatDragPayload(chat, rootPath))
      }}
      className={`group flex items-center gap-1 px-1 rounded-md ${
        active ? 'bg-hover-strong' : 'hover:bg-hover'
      }`}
    >
      <button
        onClick={onOpen}
        className="flex-1 min-w-0 flex items-center gap-1.5 px-1 py-1 text-left"
        title={chat.title}
      >
        <ChatModeGlyph chat={chat} size={11} />
        <span className="truncate text-[11.5px] text-primary">{chat.title}</span>
        {running && (
          <span
            className="ml-auto w-1.5 h-1.5 rounded-full bg-agent-light shrink-0"
            title="Running"
          />
        )}
      </button>
      <Tooltip label="Delete chat">
        <button
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          className="p-1 rounded-md text-muted hover:text-primary hover:bg-hover-strong opacity-0 group-hover:opacity-100"
          aria-label="Delete chat"
        >
          <Trash size={10} />
        </button>
      </Tooltip>
    </div>
  )
}

function LoopRow({
  chat,
  rootPath,
  active,
  onOpen,
  onDelete,
}: {
  chat: Chat
  rootPath: string
  active: boolean
  onOpen: () => void
  onDelete: () => void
}) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'copy'
        setChatDrag(e.dataTransfer, chatDragPayload(chat, rootPath))
      }}
      className={`group flex items-center gap-1 px-1 rounded-md ${
        active ? 'bg-hover-strong' : 'hover:bg-hover'
      }`}
    >
      <button
        onClick={onOpen}
        className="flex-1 min-w-0 flex items-center gap-1.5 px-1 py-1 text-left"
        title={chat.title}
      >
        <ChatModeGlyph chat={chat} />
        <span className="truncate text-[11.5px] text-primary">{chat.title}</span>
      </button>
      <Tooltip label="Delete loop chat">
        <button
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          className="p-1 rounded-md text-muted hover:text-primary hover:bg-hover-strong opacity-0 group-hover:opacity-100"
          aria-label="Delete loop chat"
        >
          <Trash size={10} />
        </button>
      </Tooltip>
    </div>
  )
}
