import React from 'react'
import { useCateAgentStore, useCateAgentWs } from './cateAgentStore'
import { CateAgentChatTabs } from './CateAgentChatTabs'
import { CateAgentChatView } from './CateAgentChatView'
import { isSidebarChat, useChatsStore } from '../../renderer/stores/chatsStore'
import { useCateAgentReady } from '../../renderer/stores/providerReadinessStore'
import { useUIStore } from '../../renderer/stores/uiStore'
import { readChatDrag, CHAT_DRAG_MIME } from '../../renderer/drag/fileDragPayload'
import { endChatDrag, useChatDragState } from '../../renderer/drag/chatDragState'

export const CateAgentSidebarView: React.FC<{
  wsId: string
  rootPath: string
}> = ({ wsId, rootPath }) => {
  const ready = useCateAgentReady() === 'ok'
  const { activeChatId } = useCateAgentWs(wsId)
  const chats = (useChatsStore((state) => state.chatsByRoot[rootPath]) ?? [])
    .filter(isSidebarChat)
  const chatsLoaded = useChatsStore((state) => !!state.loadedRoots[rootPath])
  const loadChats = useChatsStore((state) => state.loadChats)
  const activeChat = chats.find((chat) => chat.id === activeChatId)

  React.useEffect(() => {
    void loadChats(rootPath)
  }, [loadChats, rootPath])

  React.useEffect(() => {
    if (!activeChatId || activeChat) return
    useCateAgentStore.getState().setActiveChat(wsId, chats[chats.length - 1]?.id ?? '')
  }, [activeChat, activeChatId, chats, wsId])

  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    const payload = readChatDrag(event.dataTransfer)
    if (!payload || payload.rootPath !== rootPath) return
    event.preventDefault()
    event.stopPropagation()
    useChatsStore.getState().moveChat(rootPath, payload.chatId, null)
    useCateAgentStore.getState().setActiveChat(wsId, payload.chatId)
    endChatDrag()
  }

  if (!rootPath) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted">
        No folder open
      </div>
    )
  }
  if (!ready) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="text-xs text-muted">Connect a provider to use the Cate Agent.</span>
        <button
          className="rounded bg-surface-5 px-3 py-1.5 text-xs text-secondary transition-colors hover:bg-hover hover:text-primary"
          onClick={() => useUIStore.getState().openSettings('cate agent')}
        >
          Open Settings
        </button>
      </div>
    )
  }
  if (!chatsLoaded) return null

  return (
    <div
      className="relative isolate flex h-full flex-col"
      style={{ backgroundColor: 'var(--canvas-bg)' }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(CHAT_DRAG_MIME)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        useChatDragState.getState().setDestination(null)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        if (useChatDragState.getState().destinationHostPanelId === null) {
          useChatDragState.getState().setDestination(undefined)
        }
      }}
      onDrop={handleDrop}
    >
      <div className="flex flex-shrink-0 items-center px-2 py-1.5">
        <CateAgentChatTabs wsId={wsId} rootPath={rootPath} />
      </div>
      <CateAgentChatView
        wsId={wsId}
        rootPath={rootPath}
        chatId={activeChat?.id ?? null}
      />
    </div>
  )
}
