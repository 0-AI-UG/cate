// Chat-list rail for the floating Cate Agent panel.

import { useMemo } from 'react'
import { Plus, Sidebar as SidebarIcon, Gear, Trash } from '@phosphor-icons/react'
import type { Chat } from '../../shared/types'
import { Tooltip } from '../../renderer/ui/Tooltip'
import {
  beginChatDrag,
  endChatDrag,
  showChatDropGhost,
  useChatDragState,
} from '../../renderer/drag/chatDragState'
import { ChatDropGhost, ChatStatusGlyph } from './chatListPrimitives'

export function CateAgentPanelSidebar({
  chats,
  activeChatId,
  rootPath,
  panelId,
  onNewChat,
  onOpenChat,
  onDeleteChat,
  onOpenSettings,
  onCollapse,
  settingsActive,
}: {
  chats: Chat[]
  activeChatId: string | null
  rootPath: string
  panelId: string
  onNewChat: () => void
  onOpenChat: (chatId: string) => void
  onDeleteChat: (chatId: string) => void
  onOpenSettings: () => void
  onCollapse: () => void
  settingsActive: boolean
}) {
  const ordered = useMemo(() => [...chats].reverse(), [chats])
  const drag = useChatDragState((state) => state.active)
  const dragDestination = useChatDragState((state) => state.destinationHostPanelId)
  const showGhost = showChatDropGhost(drag, dragDestination, rootPath, panelId)
  const previewItems = useMemo(
    () => showGhost && drag
      ? [...ordered, drag.chat].sort((a, b) => b.createdAt - a.createdAt)
      : ordered,
    [drag, ordered, showGhost],
  )

  return (
    <div className="flex min-h-0 w-[200px] shrink-0 flex-col border-r border-subtle bg-surface-0">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-subtle px-2">
        <Tooltip label="Collapse sidebar">
          <button
            onClick={onCollapse}
            className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-primary"
            aria-label="Collapse sidebar"
          >
            <SidebarIcon size={14} />
          </button>
        </Tooltip>
        <div className="flex-1" />
        <Tooltip label="New chat">
          <button
            onClick={onNewChat}
            className="rounded-md p-1.5 text-agent-light hover:bg-agent/20 hover:text-primary"
            aria-label="New chat"
          >
            <Plus size={14} />
          </button>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2">
        {previewItems.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-muted">No chats yet.</div>
        ) : previewItems.map((chat) => chat.id === drag?.chat.id && showGhost ? (
          <ChatDropGhost key={`ghost-${chat.id}`} chat={chat} />
        ) : (
          <div
            key={chat.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              beginChatDrag(e.dataTransfer, { chat, rootPath, sourceHostPanelId: panelId })
            }}
            onDragEnd={endChatDrag}
            className={`group flex items-center gap-1 rounded-md px-1 ${
              chat.id === activeChatId ? 'bg-hover-strong' : 'hover:bg-hover'
            }`}
          >
            <button
              onClick={() => onOpenChat(chat.id)}
              className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1 text-left"
              title={chat.title}
            >
              <ChatStatusGlyph chat={chat} />
              <span className="truncate text-[11.5px] text-primary">{chat.title}</span>
            </button>
            <Tooltip label="Delete chat">
              <button
                onClick={(e) => { e.stopPropagation(); onDeleteChat(chat.id) }}
                className="rounded-md p-1 text-muted opacity-0 hover:bg-hover-strong hover:text-primary group-hover:opacity-100"
                aria-label="Delete chat"
              >
                <Trash size={10} />
              </button>
            </Tooltip>
          </div>
        ))}
      </div>

      <div className="shrink-0 p-2">
        <button
          onClick={onOpenSettings}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] ${
            settingsActive ? 'bg-hover-strong text-primary' : 'text-muted hover:bg-hover hover:text-primary'
          }`}
        >
          <Gear size={12} />
          Settings
        </button>
      </div>
    </div>
  )
}
