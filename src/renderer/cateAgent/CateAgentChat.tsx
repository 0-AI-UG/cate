// =============================================================================
// CateAgentChat — the Cate Agent's floating window, docked above the toolbar.
//
// The FRONT DOOR is the OBSERVER: opening the agent shows a compact, read-only
// timeline of what it has watched — a single accent rail, one dot + relative time
// per remark, newest at the bottom. The window is only as tall as that content
// needs. Which view is shown (observer, or a specific chat) is chosen from the
// picker in the toolbar bar — there is no tab strip here.
//
// This card owns only the measuring/animation/scroll wrapper and the
// `inputOpen` gate: the actual body (observer feed, chat transcript, empty
// state) is the host-agnostic `CateAgentThread`, shared with the sidebar home.
//
// The card's height is measured from its content, so opening, closing, and the
// observer↔chat switch all animate purely as a grow/shrink (no fade or scale).
// =============================================================================

import React from 'react'
import { useChatsStore } from '../stores/chatsStore'
import { useCateAgentWs } from './cateAgentStore'
import { CateAgentThread } from './CateAgentThread'

export const CateAgentChat: React.FC<{ workspaceId: string; rootPath: string }> = ({ workspaceId, rootPath }) => {
  const wsId = workspaceId
  const cateAgent = useCateAgentWs(wsId)
  const chats = useChatsStore((s) => s.chatsByRoot[rootPath])
  const inputOpen = cateAgent.inputOpen

  const list = chats ?? []
  const activeChat = cateAgent.activeChatId ? list.find((c) => c.id === cateAgent.activeChatId) : undefined
  const observerView = cateAgent.observerView
  const msgCount = activeChat?.messages.length ?? 0
  const runTick = activeChat?.run?.iterations?.length ?? 0

  // Observer feed tail signature (mirrors CateAgentThread) so a feed change
  // re-measures the card height for the grow/shrink animation.
  const feed = cateAgent.feed
  const lastUserIdx = feed.map((f) => f.kind).lastIndexOf('user')
  const visibleFeed = (lastUserIdx >= 0 ? feed.slice(lastUserIdx) : feed).slice(-6)

  // --- content-height measuring + grow/shrink animation (unchanged) ---
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  const [naturalH, setNaturalH] = React.useState(0)
  const [animate, setAnimate] = React.useState(false)
  const measure = React.useCallback(() => {
    const el = contentRef.current
    if (el) setNaturalH(el.scrollHeight)
  }, [])
  const contentSig = observerView
    ? 'obs:' + visibleFeed.map((f) => `${f.id}${f.resolved ?? (f.action ? 'a' : '')}`).join('|')
    : `chat:${cateAgent.activeChatId}:${msgCount}:${runTick}:${!!activeChat}`
  React.useLayoutEffect(() => {
    measure()
  }, [measure, contentSig])
  React.useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])
  React.useEffect(() => {
    if (naturalH > 0 && !animate) {
      const r = requestAnimationFrame(() => setAnimate(true))
      return () => cancelAnimationFrame(r)
    }
  }, [naturalH, animate])

  // --- stick to bottom as the transcript grows (unchanged) ---
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const atBottomRef = React.useRef(true)
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }
  React.useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [msgCount, runTick, visibleFeed.length, cateAgent.activeChatId, observerView])

  if (!wsId || !inputOpen) return null

  return (
    <div className="absolute bottom-full inset-x-0 mb-2">
      <div
        className="overflow-hidden rounded-2xl border border-subtle/60 bg-surface-0 shadow-[0_4px_16px_-8px_var(--shadow-node)]"
        style={{
          height: naturalH || undefined,
          transition: animate ? 'height 240ms cubic-bezier(0.16,1,0.3,1)' : undefined,
        }}
      >
        <div ref={contentRef}>
          <div ref={scrollRef} onScroll={onScroll} className="no-scrollbar max-h-[min(420px,55vh)] overflow-y-auto">
            <CateAgentThread wsId={wsId} rootPath={rootPath} />
          </div>
        </div>
      </div>
    </div>
  )
}
