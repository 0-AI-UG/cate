// =============================================================================
// ChatView — the mode dispatcher for a single chat.
//
// Given a chatId it looks the chat up in chatsStore and renders the right leaf
// for its engine (chatMode): a BUNDLED coding surface (transcript + composer
// stacked together) for 'coding', LoopChatView for 'loop'. It supplies the
// surface-agnostic props each leaf needs so a host (panel or sidebar) can render
// "the chat with this id" without knowing which engine drives it.
//
// The coding path gathers its data through the shared useDurableCodingChat hook —
// the SAME gathering the Cate Agent sidebar uses for its SPLIT (floating-composer)
// layout — so the two never drift.
//
// The loop leaf transitively pulls the loop runtime (cateAgentController → xterm)
// via CateAgentComposer, so it is loaded LAZILY — a coding-only host that mounts
// ChatView never pulls xterm into its bundle.
// =============================================================================

import React, { Suspense } from 'react'
import { ChatCircle } from '@phosphor-icons/react'
import { useChatsStore, chatMode } from '../stores/chatsStore'
import { ChatThread } from '../../agent/renderer/ChatThread'
import { ChatComposer } from './ChatComposer'
import { ExtensionDialog, ExtensionWidget, QueueBadges } from '../../agent/renderer/AgentPanelChrome'
import { useDurableCodingChat } from './useDurableCodingChat'
import type { Chat } from '../../shared/types'

// Lazy so ChatView (and any coding-only host) stays free of the loop runtime's
// xterm/cateAgentController graph until a loop chat actually renders.
const LoopChatView = React.lazy(() => import('../cateAgent/LoopChatView'))

// -----------------------------------------------------------------------------
// Coding host — drives ONE durable coding chat through the shared hook and lays
// the transcript + composer out bundled (composer docked below the thread), the
// counterpart to the sidebar's floating split. The worktree pill is read-only
// here (a switch reinitialises pi, which only the AgentPanel owns).
// -----------------------------------------------------------------------------

const CodingChatHost: React.FC<{ chat: Chat; rootPath: string; workspaceId: string; surface: 'panel' | 'sidebar' }> = ({
  chat,
  rootPath,
  workspaceId,
  surface,
}) => {
  const coding = useDurableCodingChat({
    chatId: chat.id,
    agentKey: chat.agentKey ?? null,
    worktreeId: chat.worktreeId ?? null,
    rootPath,
    workspaceId,
  })

  return (
    <div
      className="relative flex-1 flex flex-col min-h-0"
      data-filedrop="agent"
      onDragOver={coding.onDragOver}
      onDrop={coding.onDrop}
    >
      <ExtensionWidget widgets={coding.extensionWidgets} placement="aboveEditor" />
      <QueueBadges steering={coding.steeringQueue} followUp={coding.followUpQueue} />

      {coding.messages.length === 0 ? (
        <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-6 py-8 min-h-0">
          <div className="w-full max-w-[520px] flex flex-col items-center">
            <div className="w-12 h-12 rounded-2xl bg-agent/15 flex items-center justify-center mb-4">
              <ChatCircle size={22} className="text-agent-light" />
            </div>
            <div className="text-[16px] font-medium text-primary mb-3 text-center">What should we work on?</div>
            <div className="w-full">
              <ChatComposer
                {...coding.composerProps}
                placeholder={coding.composerPlaceholder ?? 'Ask the agent anything about this workspace…'}
              />
            </div>
          </div>
        </div>
      ) : (
        <>
          <ChatThread
            scrollKey={`${surface}:${coding.scrollKeyBase}`}
            messages={coding.messages}
            running={coding.running}
            forkMap={coding.forkMap}
            onFork={coding.onFork}
            onEditResend={coding.onEditResend}
            onImplementPlan={coding.onImplementPlan}
            onRefinePlan={coding.onRefinePlan}
            onClearAndImplement={coding.onClearAndImplement}
            retry={coding.retry}
            onAbortRetry={coding.onAbortRetry}
          />
          <ExtensionWidget widgets={coding.extensionWidgets} placement="belowEditor" />
          {coding.currentUiRequest && (
            <div className="px-3 pt-2">
              <ExtensionDialog request={coding.currentUiRequest} onRespond={coding.onUiResponse} />
            </div>
          )}
          <div className="px-3 py-2 shrink-0">
            <ChatComposer {...coding.composerProps} placeholder={coding.composerPlaceholder} />
          </div>
        </>
      )}
    </div>
  )
}

export function ChatView({
  chatId,
  rootPath,
  workspaceId,
  surface,
}: {
  chatId: string
  rootPath: string
  workspaceId: string
  surface: 'panel' | 'sidebar'
}) {
  const chat = useChatsStore((s) => (s.chatsByRoot[rootPath] ?? []).find((c) => c.id === chatId))
  if (!chat) return null
  if (chatMode(chat) === 'coding') {
    return <CodingChatHost chat={chat} rootPath={rootPath} workspaceId={workspaceId} surface={surface} />
  }
  return (
    <Suspense fallback={null}>
      <LoopChatView wsId={workspaceId} rootPath={rootPath} chatId={chatId} />
    </Suspense>
  )
}
