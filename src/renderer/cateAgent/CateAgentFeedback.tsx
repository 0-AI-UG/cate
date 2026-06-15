// =============================================================================
// CateAgentFeedback — the Cate Agent's output panel, docked above the toolbar.
//
// Shows the running feed (status/agent/user/error lines) and the Cate Agent's
// proposed todos inline, where the user approves (Approve & run) or dismisses
// them. Floats directly above the toolbar pill (absolute, left-0 right-0) so it
// always matches the pill's width. Hidden entirely when there's nothing to show.
// =============================================================================

import React from 'react'
import { Play, Sparkle, X } from '@phosphor-icons/react'
import { useTodosStore } from '../stores/todosStore'
import { useCateAgentWs } from './cateAgentStore'
import { cateAgentController } from './cateAgentController'
import type { CateAgentFeedKind } from './cateAgentStore'

const KIND_CLASS: Record<CateAgentFeedKind, string> = {
  user: 'text-primary',
  agent: 'text-secondary',
  status: 'text-muted',
  error: 'text-red-400',
}

export const CateAgentFeedback: React.FC<{ workspaceId: string; rootPath: string }> = ({ workspaceId, rootPath }) => {
  const wsId = workspaceId
  const cateAgent = useCateAgentWs(wsId)
  const todos = useTodosStore((s) => s.todosByRoot[rootPath])
  const removeTodo = useTodosStore((s) => s.removeTodo)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  const suggested = (todos ?? []).filter((t) => t.status === 'suggested')

  // Show only the latest turn: the most recent user message and everything the
  // Cate Agent said in response to it. Sending a new prompt collapses the prior
  // exchange so the panel stays compact instead of growing without bound.
  const feed = cateAgent.feed
  const lastUserIdx = feed.map((f) => f.kind).lastIndexOf('user')
  const visibleFeed = lastUserIdx >= 0 ? feed.slice(lastUserIdx) : feed
  const hasContent = visibleFeed.length > 0 || suggested.length > 0

  // Keep the newest feed line in view as items arrive.
  React.useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [visibleFeed.length, suggested.length])

  if (!wsId || !hasContent) return null

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl border border-subtle bg-surface-0 shadow-[0_8px_24px_-6px_var(--shadow-node)] overflow-hidden">
      <div ref={scrollRef} className="max-h-[40vh] overflow-y-auto px-3 py-2 flex flex-col gap-1.5">
        {visibleFeed.map((item) => (
          <div key={item.id} className={`text-[12px] leading-snug break-words ${KIND_CLASS[item.kind]}`}>
            {item.kind === 'user' ? <span className="text-muted">You: </span> : null}
            {item.text}
          </div>
        ))}

        {suggested.map((t) => (
          <div key={t.id} className="rounded-lg border border-subtle bg-surface-1 px-2.5 py-2 flex flex-col gap-1.5">
            <div className="flex items-start gap-1.5">
              <Sparkle size={13} weight="fill" className="mt-[2px] flex-shrink-0 text-blue-400" />
              <span className="flex-1 min-w-0 text-[12.5px] leading-snug text-primary break-words">{t.title}</span>
            </div>
            {t.note && <div className="text-[11.5px] leading-snug text-muted break-words">{t.note}</div>}
            <div className="flex items-center gap-1.5 pt-0.5">
              <button
                onClick={() => wsId && void cateAgentController.runTodo(wsId, rootPath, t.id)}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[11.5px] text-white bg-blue-500 hover:bg-blue-600 transition-colors"
              >
                <Play size={10} weight="fill" /> Approve &amp; run
              </button>
              <button
                onClick={() => removeTodo(rootPath, t.id)}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[11.5px] text-muted hover:text-primary hover:bg-hover transition-colors"
              >
                <X size={10} /> Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
