// =============================================================================
// CateAgentSidebarView — the Cate Agent's second home. A persistent sidebar tab
// that mirrors the SAME feed/chats as the floating card (shared cateAgentStore +
// chatsStore): a header picker to switch feed/chat/new, the shared CateAgentThread
// body (scrolling, roomy — nicer for long chats), and a footer input. Without a
// connected provider it shows a gentle connect prompt instead of the body.
// =============================================================================

import React from 'react'
import { useCateAgentWs } from './cateAgentStore'
import { CateAgentThread } from './CateAgentThread'
import { CateAgentChatPicker } from './CateAgentChatPicker'
import { CateAgentInputBar } from './CateAgentInputBar'
import { sendCateAgentMessage } from './cateAgentSend'
import { useStickToBottom } from './useStickToBottom'
import { useChatsStore } from '../stores/chatsStore'
import { useCateAgentReady } from '../stores/providerReadinessStore'
import { useUIStore } from '../stores/uiStore'

export const CateAgentSidebarView: React.FC<{ wsId: string; rootPath: string }> = ({ wsId, rootPath }) => {
  const ready = useCateAgentReady() === 'ok'
  const cateAgent = useCateAgentWs(wsId)
  const chats = useChatsStore((s) => s.chatsByRoot[rootPath])
  const list = chats ?? []
  const activeChat = cateAgent.activeChatId ? list.find((c) => c.id === cateAgent.activeChatId) : undefined
  const msgCount = activeChat?.messages.length ?? 0
  const runTick = activeChat?.run?.iterations?.length ?? 0

  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const onScroll = useStickToBottom(scrollRef, [msgCount, runTick, cateAgent.activeChatId, cateAgent.observerView, cateAgent.feed.length])

  if (!rootPath) {
    return <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted">No folder open</div>
  }
  if (!ready) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="text-xs text-muted">Connect a provider to use the Cate Agent.</span>
        <button
          className="rounded bg-surface-5 px-3 py-1.5 text-secondary hover:bg-hover hover:text-primary transition-colors text-xs"
          onClick={() => useUIStore.getState().openSettings('cate agent')}
        >
          Open Settings
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-shrink-0 flex items-center gap-1.5 px-2 py-1.5">
        <CateAgentChatPicker workspaceId={wsId} rootPath={rootPath} />
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="no-scrollbar flex-1 min-h-0 overflow-y-auto">
        <CateAgentThread wsId={wsId} rootPath={rootPath} />
      </div>
      <div className="flex-shrink-0 border-t border-subtle px-2 py-2">
        <CateAgentInputBar
          workspaceId={wsId}
          multiline={false}
          onSend={(text) => sendCateAgentMessage(wsId, rootPath, text)}
          onClose={() => {}}
        />
      </div>
    </div>
  )
}
