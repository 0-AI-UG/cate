// =============================================================================
// AgentSidebar — chat-list rail for AgentPanel: search box, recents grouped by
// recency, per-row open/delete, and the settings entry. Pure presentation; all
// state and IPC live in AgentPanel.
// =============================================================================

import { useMemo, useState } from 'react'
import {
  Plus,
  Sidebar as SidebarIcon,
  Gear,
  Trash,
  ChatCircle,
  ChatCircleDots,
  Eye,
  MagnifyingGlass,
  X,
} from '@phosphor-icons/react'
import type { AgentSessionListEntry, Chat } from '../../shared/types'
import { Tooltip } from '../../renderer/ui/Tooltip'
import { setChatDrag } from '../../renderer/drag/fileDragPayload'
import { useChatsStore, chatDotColor } from '../../renderer/stores/chatsStore'

export function AgentSidebar({
  chats,
  rootPath,
  currentSessionFile,
  openSessionFiles,
  loopChats,
  activeLoopChatId,
  search,
  onSearchChange,
  onNewCodingChat,
  onNewLoopChat,
  onOpenChat,
  onOpenLoopChat,
  onDeleteChat,
  onDeleteLoopChat,
  onCloseChat,
  onOpenSettings,
  onCollapse,
  settingsActive,
}: {
  chats: AgentSessionListEntry[]
  rootPath: string
  currentSessionFile: string | null
  openSessionFiles: Set<string>
  loopChats: Chat[]
  activeLoopChatId: string | null
  search: string
  onSearchChange: (s: string) => void
  onNewCodingChat: () => void
  onNewLoopChat: () => void
  onOpenChat: (sessionFile: string) => void
  onOpenLoopChat: (chatId: string) => void
  onDeleteChat: (sessionFile: string) => void
  onDeleteLoopChat: (chatId: string) => void
  onCloseChat: (sessionFile: string) => void
  onOpenSettings: () => void
  onCollapse: () => void
  settingsActive: boolean
}) {
  const grouped = useMemo(() => groupChats(chats), [chats])
  // Loop chats newest-first, matching the coding recents' order.
  const orderedLoops = useMemo(() => [...loopChats].reverse(), [loopChats])
  const [chooserOpen, setChooserOpen] = useState(false)

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
              onClick={() => setChooserOpen((o) => !o)}
              className="p-1.5 rounded-md text-agent-light hover:text-primary hover:bg-agent/20"
              aria-label="New chat"
              aria-haspopup="menu"
              aria-expanded={chooserOpen}
            >
              <Plus size={14} />
            </button>
          </Tooltip>
          {chooserOpen && (
            <>
              {/* Click-away backdrop. */}
              <div className="fixed inset-0 z-20" onClick={() => setChooserOpen(false)} />
              <div
                role="menu"
                className="absolute right-0 top-8 z-30 min-w-[168px] rounded-lg border border-strong bg-surface-2 p-1 shadow-lg"
              >
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => { setChooserOpen(false); onNewCodingChat() }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-secondary hover:bg-hover hover:text-primary transition-colors"
                >
                  <ChatCircle size={13} weight="fill" style={{ color: 'rgb(var(--agent-rgb))' }} />
                  <span>New coding chat</span>
                </button>
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => { setChooserOpen(false); onNewLoopChat() }}
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

      <div className="px-2 pt-2 pb-2 shrink-0">
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-surface-0 border border-subtle">
          <MagnifyingGlass size={11} className="text-muted shrink-0" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search chats"
            className="flex-1 bg-transparent text-[11px] text-primary placeholder:text-muted outline-none min-w-0"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-1 pb-2 min-h-0">
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
        {chats.length === 0 && orderedLoops.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-muted">
            No chats yet.
          </div>
        ) : (
          grouped.map(([label, items]) => (
            <div key={label} className="mb-3">
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted/70 font-semibold">
                {label}
              </div>
              {items.map((c) => (
                <ChatRow
                  key={c.path}
                  chat={c}
                  rootPath={rootPath}
                  active={!activeLoopChatId && c.path === currentSessionFile}
                  live={openSessionFiles.has(c.path)}
                  onOpen={() => onOpenChat(c.path)}
                  onDelete={() => onDeleteChat(c.path)}
                  onClose={() => onCloseChat(c.path)}
                />
              ))}
            </div>
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

function ChatRow({
  chat,
  rootPath,
  active,
  live,
  onOpen,
  onDelete,
  onClose,
}: {
  chat: AgentSessionListEntry
  rootPath: string
  active: boolean
  live: boolean
  onOpen: () => void
  onDelete: () => void
  onClose: () => void
}) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'copy'
        // A recents row is a pi session on disk, not a durable chat. Resolve the
        // durable coding chat by its session file so the drop adopts the live one;
        // fall back to a session-file-only payload (the drop resumes it) otherwise.
        const durable = useChatsStore
          .getState()
          .getChatsByMode(rootPath, 'coding')
          .find((c) => c.sessionFile === chat.path)
        setChatDrag(e.dataTransfer, durable
          ? {
              chatId: durable.id,
              mode: 'coding',
              rootPath,
              ...(durable.agentKey ? { agentKey: durable.agentKey } : {}),
              ...(durable.sessionFile ? { sessionFile: durable.sessionFile } : {}),
              ...(durable.worktreeId ? { worktreeId: durable.worktreeId } : {}),
            }
          : { mode: 'coding', rootPath, sessionFile: chat.path })
      }}
      className={`group flex items-center gap-1 px-1 rounded-md ${
        active ? 'bg-hover-strong' : 'hover:bg-hover'
      }`}
    >
      <button
        onClick={onOpen}
        className="flex-1 min-w-0 flex items-center gap-1.5 px-1 py-1 text-left"
        title={`${chat.title}\n${chat.messageCount} messages · ${new Date(chat.updatedAt).toLocaleString()}`}
      >
        <ChatCircleDots size={11} className={chat.named ? 'text-agent-light shrink-0' : 'text-muted shrink-0'} />
        <span className="truncate text-[11.5px] text-primary">{chat.title}</span>
        {live && (
          <span
            className="ml-auto w-1.5 h-1.5 rounded-full bg-agent-light shrink-0"
            title="Running in this panel"
          />
        )}
      </button>
      {live && (
        <Tooltip label="Close chat (keep on disk)">
          <button
            onClick={(e) => { e.stopPropagation(); onClose() }}
            className="p-1 rounded-md text-muted hover:text-primary hover:bg-hover-strong opacity-0 group-hover:opacity-100"
            aria-label="Close chat (keep on disk)"
          >
            <X size={10} />
          </button>
        </Tooltip>
      )}
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
        setChatDrag(e.dataTransfer, { chatId: chat.id, mode: 'loop', rootPath })
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
        <span
          aria-hidden
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: chatDotColor(chat) }}
        />
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

function groupChats(
  chats: AgentSessionListEntry[],
): Array<[string, AgentSessionListEntry[]]> {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 24 * 3600 * 1000
  const startOfWeek = startOfToday - 7 * 24 * 3600 * 1000
  const buckets: Record<string, AgentSessionListEntry[]> = {
    Today: [], Yesterday: [], 'This week': [], Earlier: [],
  }
  for (const c of chats) {
    const t = Date.parse(c.updatedAt)
    if (t >= startOfToday) buckets.Today.push(c)
    else if (t >= startOfYesterday) buckets.Yesterday.push(c)
    else if (t >= startOfWeek) buckets['This week'].push(c)
    else buckets.Earlier.push(c)
  }
  return Object.entries(buckets).filter(([, items]) => items.length > 0)
}
