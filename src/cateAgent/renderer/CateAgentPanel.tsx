// Floating Cate Agent panel. It hosts the same durable chats and the same chat
// view as the workspace sidebar; the agent decides whether a turn is a direct
// answer, a code change, a canvas task, or a verified parallel loop.

import { useCallback, useEffect, useState } from 'react'
import { Sidebar as SidebarIcon, Gear } from '@phosphor-icons/react'
import type { PanelProps } from '../../renderer/panels/types'
import { useAppStore } from '../../renderer/stores/appStore'
import { useChatsStore } from '../../renderer/stores/chatsStore'
import { useCateAgentReady } from '../../renderer/stores/providerReadinessStore'
import { useStatusStore } from '../../renderer/stores/statusStore'
import { useUIStore } from '../../renderer/stores/uiStore'
import { useCateAgentStore, useCateAgentWs } from './cateAgentStore'
import { cateAgentController } from './cateAgentController'
import { CateAgentPanelSidebar } from './CateAgentPanelSidebar'
import { CateAgentChatView } from './CateAgentChatView'
import { SettingsView } from './CateAgentSettingsView'
import { useCodingStore } from './codingStore'
import { directAgentKey } from './directChatSession'

export default function CateAgentPanel({ panelId, workspaceId }: PanelProps) {
  const workspace = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const panel = workspace?.panels[panelId]
  const rootPath = workspace?.rootPath ?? ''
  const chats = useChatsStore((s) => s.chatsByRoot[rootPath]) ?? []
  const chatsLoaded = useChatsStore((s) => !!s.loadedRoots[rootPath])
  const loadChats = useChatsStore((s) => s.loadChats)
  const ready = useCateAgentReady() === 'ok'
  const cateAgent = useCateAgentWs(workspaceId)

  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [view, setView] = useState<'chat' | 'settings'>('chat')
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const activeChat = activeChatId ? chats.find((chat) => chat.id === activeChatId) : undefined
  const directRunning = useCodingStore((state) => activeChatId
    ? state.panels[directAgentKey(activeChatId)]?.running ?? false
    : false)
  const active = directRunning || activeChat?.run?.status === 'running' || (
    cateAgent.activity === 'working' && cateAgent.activeChatId === activeChatId
  )
  useEffect(() => {
    useStatusStore.getState().setAgentState(
      workspaceId,
      panelId,
      active ? 'running' : 'waitingForInput',
      'Cate Agent',
    )
    return () => useStatusStore.getState().setAgentState(workspaceId, panelId, 'notRunning', null)
  }, [active, panelId, workspaceId])

  // Load once, then honor a chat dragged onto this panel. Otherwise reopen the
  // newest durable chat; an empty workspace stays on the new-chat composer.
  useEffect(() => {
    if (!rootPath) return
    let cancelled = false
    void loadChats(rootPath).then(() => {
      if (cancelled) return
      const list = useChatsStore.getState().getChats(rootPath)
      const seed = panel?.initialChatId
      const selected = seed && list.some((chat) => chat.id === seed)
        ? seed
        : list[list.length - 1]?.id ?? null
      setActiveChatId(selected)
    })
    return () => { cancelled = true }
  }, [loadChats, panel?.initialChatId, rootPath])

  // A close can originate from the other surface. Never leave this panel
  // pointing at a deleted record.
  useEffect(() => {
    if (activeChatId && !chats.some((chat) => chat.id === activeChatId)) {
      setActiveChatId(chats[chats.length - 1]?.id ?? null)
    }
  }, [activeChatId, chats])

  const selectChat = useCallback((chatId: string) => {
    setActiveChatId(chatId)
    setView('chat')
    useCateAgentStore.getState().setActiveChat(workspaceId, chatId)
  }, [workspaceId])

  const newChat = useCallback(async () => {
    await loadChats(rootPath)
    const chat = useChatsStore.getState().createChat(rootPath, 'New chat')
    selectChat(chat.id)
  }, [loadChats, rootPath, selectChat])

  const deleteChat = useCallback((chatId: string) => {
    void cateAgentController.closeChat(workspaceId, rootPath, chatId).then((deleted) => {
      if (!deleted || activeChatId !== chatId) return
      const remaining = useChatsStore.getState().getChats(rootPath)
      const next = remaining[remaining.length - 1]?.id ?? null
      setActiveChatId(next)
      if (next) useCateAgentStore.getState().setActiveChat(workspaceId, next)
    })
  }, [activeChatId, rootPath, workspaceId])

  if (!rootPath) {
    return <div className="flex h-full items-center justify-center text-xs text-muted">No folder open</div>
  }

  return (
    <div className="flex h-full min-h-0 bg-surface-1 text-primary">
      {sidebarOpen && (
        <CateAgentPanelSidebar
          chats={chats}
          activeChatId={view === 'chat' ? activeChatId : null}
          rootPath={rootPath}
          onNewChat={() => { void newChat() }}
          onOpenChat={selectChat}
          onDeleteChat={deleteChat}
          onOpenSettings={() => setView('settings')}
          onCollapse={() => setSidebarOpen(false)}
          settingsActive={view === 'settings'}
        />
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {(!sidebarOpen || view === 'settings') && (
          <div className="flex h-10 shrink-0 items-center gap-1 px-2">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-primary"
                title="Open sidebar"
              >
                <SidebarIcon size={14} />
              </button>
            )}
            {view === 'settings' && (
              <div className="flex items-center gap-1.5 px-2 py-1 text-[12px] font-medium text-primary">
                <Gear size={12} /> Settings
              </div>
            )}
          </div>
        )}

        {view === 'settings' ? (
          <SettingsView workspaceId={workspaceId} cwd={rootPath} onBack={() => setView('chat')} onRefresh={() => {}} />
        ) : !ready ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="text-xs text-muted">Connect a provider to use the Cate Agent.</span>
            <button
              className="rounded bg-surface-5 px-3 py-1.5 text-xs text-secondary hover:bg-hover hover:text-primary"
              onClick={() => useUIStore.getState().openSettings('providers')}
            >
              Open Settings
            </button>
          </div>
        ) : !chatsLoaded ? null : (
          <CateAgentChatView
            wsId={workspaceId}
            rootPath={rootPath}
            chatId={activeChatId}
            onChatCreated={selectChat}
          />
        )}
      </div>
    </div>
  )
}
