// =============================================================================
// ChatThread — scrolling message list for the agent panel.
//
// Renders user / assistant / tool / system messages plus any pending tool-call
// approval cards. Individual message rendering lives in ChatMessageRow (and the
// per-kind cards it dispatches to: ChatToolCard / ChatSubagentCard /
// ChatPlanCard); this file owns the list, scroll-position memory, and the
// loading / retry indicators.
// =============================================================================

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRenderCount } from '../../renderer/lib/perf/perfClient'
import {
  ArrowClockwise,
  ArrowDown,
  WarningCircle,
} from '@phosphor-icons/react'
import type { AgentMessage, RetryState } from './agentStore'
import { MessageRow } from './ChatMessageRow'
import { LoadingIndicator } from './ChatMarkdown'
import { Tooltip } from '../../renderer/ui/Tooltip'

// Per-conversation scroll memory — survives the dock-tab unmount/remount cycle.
// Transient UI state, intentionally module-level (not persisted to disk/store).
const scrollMemory = new Map<string, { top: number; atBottom: boolean }>()

interface ChatThreadProps {
  messages: AgentMessage[]
  /** Agent is busy. Used to show a "thinking" indicator in the gap between the
   *  user's send and the first assistant token. */
  running: boolean
  /** Map of user-message id → pi entryId, used to expose "fork from here". */
  forkMap?: Record<string, string>
  onFork?: (entryId: string) => void
  /** Prefill the composer with a user message's text (no history mutation). */
  onEditResend?: (text: string) => void
  /** Plan Ready card actions — see cate-plan-mode extension. */
  onImplementPlan?: () => void
  onRefinePlan?: (text: string) => void
  onClearAndImplement?: () => void
  /** Connection retry state — rendered inline at the tail of the chat. */
  retry?: RetryState
  onAbortRetry?: () => void
  /** Stable per-conversation key — used to remember/restore scroll position
   *  across the dock-tab unmount/remount cycle. */
  scrollKey: string
}

export function ChatThread({ messages, running, forkMap, onFork, onEditResend, onImplementPlan, onRefinePlan, onClearAndImplement, retry, onAbortRetry, scrollKey }: ChatThreadProps) {
  useRenderCount('ChatThread')
  const scrollRef = useRef<HTMLDivElement>(null)
  // Button visibility — init true so it never flashes before the first measure.
  const [atBottom, setAtBottom] = useState(true)

  const scrollToBottom = (smooth: boolean) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }

  // Restore the remembered position when the panel mounts/remounts (e.g. after
  // a dock-tab switch) or when switching between conversations. A new chat with
  // no saved entry opens at the bottom; a chat the user had scrolled to the
  // bottom of re-pins to the newest message; otherwise the exact offset is
  // restored. useLayoutEffect runs before paint, so there's no flash at the top.
  const restoreScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const saved = scrollMemory.get(scrollKey)
    if (!saved || saved.atBottom) {
      scrollToBottom(false)
      setAtBottom(true)
    } else {
      el.scrollTop = saved.top
      setAtBottom(false)
    }
  }

  useLayoutEffect(() => {
    restoreScroll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey])

  // Re-restore when the container goes from hidden to visible without a remount
  // (the display:none case, which also resets scrollTop to 0 on reshow).
  const wasVisibleRef = useRef(true)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      const visible = entries[0]?.isIntersecting ?? false
      if (visible && !wasVisibleRef.current) restoreScroll()
      wasVisibleRef.current = visible
    }, { threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const bottom = distance < 120
    setAtBottom(bottom)
    scrollMemory.set(scrollKey, { top: el.scrollTop, atBottom: bottom })
  }

  const last = messages[messages.length - 1]

  // Is the agent actively streaming text the user can see?
  const streamingVisibleText =
    last?.type === 'assistant' && last.streaming && !!last.text

  // Has the current turn (after the last user message) produced any visible content?
  let hasVisibleContent = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.type === 'user') break
    if (m.type === 'tool' || (m.type === 'assistant' && (m.text || m.thinking))) {
      hasVisibleContent = true
      break
    }
  }

  // "Loading" for the very first wait; shimmer on the last rendered item for
  // every other gap. The only time nothing extra shows is when assistant text
  // is actively streaming on screen.
  const showLoading = running && !hasVisibleContent
  const shimmerLast = running && !streamingVisibleText && !showLoading

  // Auto-scroll on new content unless the user has scrolled away from the
  // bottom — feels less like fighting the scroll position during long output.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance < 120) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      setAtBottom(true)
      scrollMemory.set(scrollKey, { top: el.scrollHeight, atBottom: true })
    }
  }, [messages.length, last, scrollKey])

  // Find the last message that actually renders visible content — skip empty
  // streaming assistant stubs so the *previous* real item gets the shimmer.
  let lastVisibleIdx = messages.length - 1
  while (lastVisibleIdx >= 0) {
    const m = messages[lastVisibleIdx]
    if (m.type === 'assistant' && !m.text && !m.thinking) {
      lastVisibleIdx--
    } else {
      break
    }
  }

  // When the trailing visible messages are consecutive tool calls (parallel
  // group), all of them should shimmer — not just the very last one.
  let shimmerGroupStart = lastVisibleIdx
  if (lastVisibleIdx >= 0 && messages[lastVisibleIdx].type === 'tool') {
    while (shimmerGroupStart > 0 && messages[shimmerGroupStart - 1].type === 'tool') {
      shimmerGroupStart--
    }
  }

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-0"
    >
      {messages.map((m, idx) => {
        // Don't render empty assistant stubs (no text, no thinking) — they add
        // blank space. Content appears the moment the first token lands.
        if (m.type === 'assistant' && !m.text && !m.thinking) return null

        let showModelTag = false
        let isCurrentTurn = false
        if (m.type === 'assistant') {
          showModelTag = true
          isCurrentTurn = true
          for (let j = idx + 1; j < messages.length; j++) {
            if (messages[j].type === 'user') { isCurrentTurn = false; break }
            if (messages[j].type === 'assistant') { showModelTag = false; break }
          }
        }
        const isLast = idx === lastVisibleIdx
        const inShimmerGroup = shimmerLast && idx >= shimmerGroupStart && idx <= lastVisibleIdx
        return (
          <MessageRow
            key={m.id}
            msg={m}
            shimmer={inShimmerGroup}
            forkEntryId={m.type === 'user' ? (m.entryId ?? forkMap?.[m.id]) : undefined}
            onFork={onFork}
            onEditResend={onEditResend}
            onImplementPlan={onImplementPlan}
            onRefinePlan={onRefinePlan}
            onClearAndImplement={onClearAndImplement}
            isLast={isLast}
            showModelTag={showModelTag}
            isCurrentTurn={isCurrentTurn}
            agentRunning={running}
          />
        )
      })}
      {showLoading && <LoadingIndicator />}
      {retry && (retry.active || retry.finalError) && (
        <RetryIndicator state={retry} onAbort={onAbortRetry} />
      )}
    </div>
    {!atBottom && (
      <Tooltip label="Scroll to bottom" placement="top">
        <button
          onClick={() => { scrollToBottom(true); setAtBottom(true) }}
          aria-label="Scroll to bottom"
          className="absolute bottom-3 right-3 z-10 p-2 rounded-full bg-surface-2 border border-strong text-muted hover:text-primary shadow-lg cate-fade-in"
        >
          <ArrowDown size={14} weight="bold" />
        </button>
      </Tooltip>
    )}
    </div>
  )
}

function RetryIndicator({ state, onAbort }: { state: RetryState; onAbort?: () => void }) {
  if (state.active) {
    const delay = state.delayMs != null ? `${Math.round(state.delayMs / 1000)}s` : '…'
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-warning-tint border border-warning text-[12px]">
        <ArrowClockwise size={13} className="text-warning animate-spin shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="text-warning">
            Retrying ({state.attempt ?? '?'}/{state.maxAttempts ?? '?'}) in {delay}
          </span>
          {state.errorMessage && (
            <div className="text-[11px] text-warning opacity-70 mt-0.5 truncate">{state.errorMessage}</div>
          )}
        </div>
        {onAbort && (
          <button
            onClick={onAbort}
            className="px-2 py-0.5 rounded-md bg-hover hover:bg-hover-strong text-warning text-[11px] shrink-0"
          >
            Abort
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-danger-tint border border-danger text-[12px]">
      <WarningCircle size={13} weight="fill" className="text-danger shrink-0" />
      <span className="text-danger">
        Retries exhausted{state.finalError ? `: ${state.finalError.length > 120 ? state.finalError.slice(0, 120) + '…' : state.finalError}` : ''}
      </span>
    </div>
  )
}
