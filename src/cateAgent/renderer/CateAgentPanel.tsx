// Floating Cate Agent panel. It hosts only the durable chats pinned to this
// panel, using the same chat view/capabilities as the workspace sidebar.

import { useCallback, useEffect, useState } from 'react'
import { Sidebar as SidebarIcon, Gear } from '@phosphor-icons/react'
import type { PanelProps } from '../../renderer/panels/types'
import { useAppStore } from '../../renderer/stores/appStore'
import { isPanelChat, useChatsStore } from '../../renderer/stores/chatsStore'
import { useCateAgentReady } from '../../renderer/stores/providerReadinessStore'
import { useStatusStore } from '../../renderer/stores/statusStore'
import { useUIStore } from '../../renderer/stores/uiStore'
import { useCateAgentWs } from './cateAgentStore'
import { cateAgentController } from './cateAgentController'
import { CateAgentPanelSidebar } from './CateAgentPanelSidebar'
import { CateAgentChatView } from './CateAgentChatView'
import { SettingsView } from './CateAgentSettingsView'
import { useCodingStore } from './codingStore'
import { directAgentKey } from './directChatSession'
import { CHAT_DRAG_MIME, readChatDrag } from '../../renderer/drag/fileDragPayload'
import { endChatDrag, useChatDragState } from '../../renderer/drag/chatDragState'

export default function CateAgentPanel({ panelId, workspaceId }: PanelProps) {
  const workspace = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const panel = workspace?.panels[panelId]
  const rootPath = workspace?.rootPath ?? ''
  const chats = (useChatsStore((s) => s.chatsByRoot[rootPath]) ?? [])
    .filter((chat) => isPanelChat(chat, panelId))
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

  // Load once, then honor a chat dragged onto this panel. Otherwise reopen this
  // panel's newest chat; chats owned by other panels/the sidebar stay invisible.
  useEffect(() => {
    if (!rootPath) return
    let cancelled = false
    void loadChats(rootPath).then(() => {
      if (cancelled) return
      const list = useChatsStore.getState().getChats(rootPath)
        .filter((chat) => isPanelChat(chat, panelId))
      const seed = panel?.initialChatId
      const selected = seed && list.some((chat) => chat.id === seed)
        ? seed
        : list[list.length - 1]?.id ?? null
      setActiveChatId(selected)
    })
    return () => { cancelled = true }
  }, [loadChats, panel?.initialChatId, panelId, rootPath])

  // A chat can be deleted or dragged to another host. Select the next chat that
  // still belongs here; this also adopts an asynchronously-loaded drop.
  useEffect(() => {
    if (activeChatId && chats.some((chat) => chat.id === activeChatId)) return
    const next = chats[chats.length - 1]?.id ?? null
    if (next !== activeChatId) setActiveChatId(next)
  }, [activeChatId, chats])

  const selectChat = useCallback((chatId: string) => {
    setActiveChatId(chatId)
    setView('chat')
  }, [])

  const newChat = useCallback(async () => {
    await loadChats(rootPath)
    const chat = useChatsStore.getState().createChat(rootPath, 'New chat', panelId)
    selectChat(chat.id)
  }, [loadChats, panelId, rootPath, selectChat])

  const deleteChat = useCallback((chatId: string) => {
    void cateAgentController.closeChat(workspaceId, rootPath, chatId).then((deleted) => {
      if (!deleted || activeChatId !== chatId) return
      const remaining = useChatsStore.getState().getChats(rootPath)
        .filter((chat) => isPanelChat(chat, panelId))
      const next = remaining[remaining.length - 1]?.id ?? null
      setActiveChatId(next)
    })
  }, [activeChatId, panelId, rootPath, workspaceId])

  const handleChatDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(CHAT_DRAG_MIME)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    useChatDragState.getState().setDestination(panelId)
    if (!sidebarOpen) setSidebarOpen(true)
  }, [panelId, sidebarOpen])

  const handleChatDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const payload = readChatDrag(event.dataTransfer)
    if (!payload || payload.rootPath !== rootPath) return
    event.preventDefault()
    event.stopPropagation()
    useChatsStore.getState().moveChat(rootPath, payload.chatId, panelId)
    selectChat(payload.chatId)
    endChatDrag()
  }, [panelId, rootPath, selectChat])

  const handleChatDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    if (useChatDragState.getState().destinationHostPanelId === panelId) {
      useChatDragState.getState().setDestination(undefined)
    }
  }, [panelId])

  if (!rootPath) {
    return <div className="flex h-full items-center justify-center text-xs text-muted">No folder open</div>
  }

  return (
    <div
      className="flex h-full min-h-0 bg-surface-1 text-primary"
      onDragOver={handleChatDragOver}
      onDragLeave={handleChatDragLeave}
      onDrop={handleChatDrop}
    >
      {sidebarOpen && (
        <CateAgentPanelSidebar
          chats={chats}
          activeChatId={view === 'chat' ? activeChatId : null}
          rootPath={rootPath}
          panelId={panelId}
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
            hostPanelId={panelId}
            defaultWorktreeId={panel?.worktreeId}
          />
        )}
      </div>
    </div>
  )
}
