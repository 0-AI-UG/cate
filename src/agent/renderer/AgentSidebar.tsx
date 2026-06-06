// =============================================================================
// AgentSidebar — chat-list rail for AgentPanel: search box, recents grouped by
// recency, per-row open/delete, and the settings entry. Pure presentation;
// all state and IPC live in AgentPanel.
// =============================================================================

import { useMemo } from 'react'
import {
  Plus,
  Sidebar as SidebarIcon,
  Gear,
  Trash,
  ChatCircleDots,
  MagnifyingGlass,
} from '@phosphor-icons/react'
import type { AgentSessionListEntry } from '../../shared/types'

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
        <button
          onClick={onCollapse}
          className="p-1.5 rounded-md text-muted hover:text-primary hover:bg-hover"
          title="Collapse sidebar"
        >
          <SidebarIcon size={14} />
        </button>
        <div className="flex-1" />
        <button
          onClick={onNewChat}
          className="p-1.5 rounded-md text-agent-light hover:text-primary hover:bg-agent/20"
          title="New chat"
        >
          <Plus size={14} />
        </button>
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
                  onOpen={() => onOpenChat(c.path)}
                  onDelete={() => onDeleteChat(c.path)}
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
  onOpen,
  onDelete,
}: {
  chat: AgentSessionListEntry
  active: boolean
  onOpen: () => void
  onDelete: () => void
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
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        className="p-1 rounded-md text-muted hover:text-primary hover:bg-hover-strong opacity-0 group-hover:opacity-100"
        title="Delete chat"
      >
        <Trash size={10} />
      </button>
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
