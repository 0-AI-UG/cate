// Workspace-sidebar home for the observer feed and chats pinned to the sidebar.
// Floating panels use the same chat view but own disjoint chat sets.

import React from 'react'
import { useCateAgentStore, useCateAgentWs } from './cateAgentStore'
import { CateAgentThread } from './CateAgentThread'
import { CateAgentChatTabs } from './CateAgentChatTabs'
import { CateAgentComposer } from './CateAgentComposer'
import { CateAgentChatView } from './CateAgentChatView'
import { useStickToBottom } from './useStickToBottom'
import { isSidebarChat, useChatsStore } from '../../renderer/stores/chatsStore'
import { useCateAgentReady } from '../../renderer/stores/providerReadinessStore'
import { useUIStore } from '../../renderer/stores/uiStore'
import { CateLogo } from '../../renderer/ui/CateLogo'
import { readChatDrag, CHAT_DRAG_MIME } from '../../renderer/drag/fileDragPayload'
import { endChatDrag, useChatDragState } from '../../renderer/drag/chatDragState'

const PATTERN: React.CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(-24deg, transparent 0 47px, color-mix(in srgb, var(--text-muted) 7%, transparent) 47px 48px)',
}
const WIPE_MASK = 'linear-gradient(90deg, transparent 0 33%, #000 66% 100%)'

const PatternLayer: React.FC<{ empty: boolean }> = ({ empty }) => {
  const [state, setState] = React.useState<'shown' | 'wiping' | 'hidden'>(empty ? 'shown' : 'hidden')
  const wasEmpty = React.useRef(empty)
  React.useEffect(() => {
    if (wasEmpty.current && !empty) setState('wiping')
    else if (!wasEmpty.current && empty) setState('shown')
    wasEmpty.current = empty
  }, [empty])

  if (state === 'hidden') return null
  const wiping = state === 'wiping'
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10"
      onAnimationEnd={() => wiping && setState('hidden')}
      style={{
        ...PATTERN,
        ...(wiping ? {
          WebkitMaskImage: WIPE_MASK,
          maskImage: WIPE_MASK,
          WebkitMaskSize: '300% 100%',
          maskSize: '300% 100%',
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
          animation: 'cate-pattern-wipe 1500ms cubic-bezier(0.4, 0, 0.2, 1) forwards',
        } : null),
      }}
    />
  )
}

const SidebarEmpty: React.FC = () => (
  <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
    <CateLogo size={44} className="text-secondary opacity-90" />
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-primary">Cate Agent</span>
      <span className="text-[12px] leading-relaxed text-muted">
        Chat, make changes, or delegate to iteration engineering and land the verified winner.
      </span>
    </div>
  </div>
)

const FloatingComposer: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-[var(--canvas-bg)] via-[var(--canvas-bg)] to-transparent px-3 pb-3 pt-10">
    <div className="pointer-events-auto">{children}</div>
  </div>
)

const ObserverBody: React.FC<{ wsId: string; rootPath: string }> = ({ wsId, rootPath }) => {
  const cateAgent = useCateAgentWs(wsId)
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const onScroll = useStickToBottom(scrollRef, [cateAgent.feed.length])

  return (
    <>
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="no-scrollbar absolute inset-0 overflow-y-auto pb-32">
          <CateAgentThread wsId={wsId} rootPath={rootPath} emptyState={<SidebarEmpty />} />
        </div>
      </div>
      <FloatingComposer>
        <CateAgentComposer wsId={wsId} rootPath={rootPath} />
      </FloatingComposer>
    </>
  )
}

export const CateAgentSidebarView: React.FC<{ wsId: string; rootPath: string }> = ({ wsId, rootPath }) => {
  const ready = useCateAgentReady() === 'ok'
  const cateAgent = useCateAgentWs(wsId)
  const chats = (useChatsStore((s) => s.chatsByRoot[rootPath]) ?? [])
    .filter(isSidebarChat)
  const chatsLoaded = useChatsStore((s) => !!s.loadedRoots[rootPath])
  const loadChats = useChatsStore((s) => s.loadChats)
  const activeChat = cateAgent.activeChatId
    ? chats.find((chat) => chat.id === cateAgent.activeChatId)
    : undefined
  const empty = cateAgent.observerView
    ? cateAgent.feed.length === 0
    : (activeChat?.messages.length ?? 0) === 0

  React.useEffect(() => {
    void loadChats(rootPath)
  }, [loadChats, rootPath])

  React.useEffect(() => {
    if (!cateAgent.activeChatId || chats.some((chat) => chat.id === cateAgent.activeChatId)) return
    useCateAgentStore.getState().setActiveChat(wsId, chats[chats.length - 1]?.id ?? '')
  }, [cateAgent.activeChatId, chats, wsId])

  const handleChatDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes(CHAT_DRAG_MIME)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    useChatDragState.getState().setDestination(null)
  }

  const handleChatDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    const payload = readChatDrag(event.dataTransfer)
    if (!payload || payload.rootPath !== rootPath) return
    event.preventDefault()
    event.stopPropagation()
    useChatsStore.getState().moveChat(rootPath, payload.chatId, null)
    useCateAgentStore.getState().setActiveChat(wsId, payload.chatId)
    endChatDrag()
  }

  const handleChatDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    if (useChatDragState.getState().destinationHostPanelId === null) {
      useChatDragState.getState().setDestination(undefined)
    }
  }

  if (!rootPath) {
    return <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted">No folder open</div>
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
      onDragOver={handleChatDragOver}
      onDragLeave={handleChatDragLeave}
      onDrop={handleChatDrop}
    >
      <PatternLayer empty={empty} />
      <div className="flex flex-shrink-0 items-center px-2 py-1.5">
        <CateAgentChatTabs wsId={wsId} rootPath={rootPath} />
      </div>
      {cateAgent.observerView ? (
        <ObserverBody wsId={wsId} rootPath={rootPath} />
      ) : (
        <CateAgentChatView wsId={wsId} rootPath={rootPath} chatId={activeChat?.id ?? null} />
      )}
    </div>
  )
}
