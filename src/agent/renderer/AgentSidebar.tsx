// =============================================================================
// AgentSidebar — chat-list rail for AgentPanel: search box, recents grouped by
// recency, per-row open/delete, and the settings entry. Pure presentation; all
// state and IPC live in AgentPanel.
// =============================================================================

import { useMemo } from 'react'
import {
  Plus,
  Sidebar as SidebarIcon,
  Gear,
  Trash,
  ChatCircleDots,
  MagnifyingGlass,
  X,
} from '@phosphor-icons/react'
import type { AgentSessionListEntry } from '../../shared/types'
import { Tooltip } from '../../renderer/ui/Tooltip'

export function AgentSidebar({
  chats,
  currentSessionFile,
  openSessionFiles,
  search,
  onSearchChange,
  onNewChat,
  onOpenChat,
  onDeleteChat,
  onCloseChat,
  onOpenSettings,
  onCollapse,
  settingsActive,
}: {
  chats: AgentSessionListEntry[]
  currentSessionFile: string | null
  openSessionFiles: Set<string>
  search: string
  onSearchChange: (s: string) => void
  onNewChat: () => void
  onOpenChat: (sessionFile: string) => void
  onDeleteChat: (sessionFile: string) => void
  onCloseChat: (sessionFile: string) => void
  onOpenSettings: () => void
  onCollapse: () => void
  settingsActive: boolean
}) {
  const grouped = useMemo(() => groupChats(chats), [chats])

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
        <Tooltip label="New chat">
          <button
            onClick={onNewChat}
            className="p-1.5 rounded-md text-agent-light hover:text-primary hover:bg-agent/20"
            aria-label="New chat"
          >
            <Plus size={14} />
          </button>
        </Tooltip>
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
        {chats.length === 0 ? (
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
                  active={c.path === currentSessionFile}
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
  active,
  live,
  onOpen,
  onDelete,
  onClose,
}: {
  chat: AgentSessionListEntry
  active: boolean
  live: boolean
  onOpen: () => void
  onDelete: () => void
  onClose: () => void
}) {
  return (
    <div
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
