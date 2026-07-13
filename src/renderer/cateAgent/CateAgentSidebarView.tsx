// =============================================================================
// CateAgentSidebarView — the Cate Agent's second home. A persistent sidebar tab
// that mirrors the SAME feed/chats as the floating card (shared cateAgentStore +
// chatsStore): a header picker to switch feed/chat/new, the shared CateAgentThread
// body (scrolling, roomy — nicer for long chats), and a composer that FLOATS over
// the content (a rounded pill, not a bordered footer) with a fade that lets the
// transcript scroll away beneath it. A faint diagonal pattern textures the empty
// panel, and a fresh thread greets with the Cate wordmark. Without a connected
// provider it shows a gentle connect prompt instead of the body.
// =============================================================================

import React from 'react'
import { useCateAgentWs } from './cateAgentStore'
import { CateAgentThread } from './CateAgentThread'
import { CateAgentChatTabs } from './CateAgentChatTabs'
import { CateAgentComposer } from './CateAgentComposer'
import { CateAgentScrollRail } from './CateAgentScrollRail'
import { useStickToBottom } from './useStickToBottom'
import { useChatsStore } from '../stores/chatsStore'
import { useCateAgentReady } from '../stores/providerReadinessStore'
import { useUIStore } from '../stores/uiStore'
import { CateLogo } from '../ui/CateLogo'

// A faint diagonal hatch that textures the empty panel behind the thread — sparse,
// low-contrast strokes so it reads as a surface, not a foreground element.
const PATTERN: React.CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(-24deg, transparent 0 47px, color-mix(in srgb, var(--text-muted) 7%, transparent) 47px 48px)',
}

// A 300%-wide alpha mask (transparent | ramp | opaque). At rest it is unused (the
// pattern shows in full); the wipe keyframe slides its position so the transparent
// edge sweeps across left-to-right. See `cate-pattern-wipe` in globals.css.
const WIPE_MASK = 'linear-gradient(90deg, transparent 0 33%, #000 66% 100%)'

// The hatch layer: shown only while the panel is EMPTY (a fresh/observer front
// door). When content arrives it doesn't just vanish — it dissolves left-to-right
// via the wipe, then unmounts. Painted behind the content (negative z, above the
// panel's own surface fill) so the transcript and bubbles sit cleanly on top.
const PatternLayer: React.FC<{ empty: boolean }> = ({ empty }) => {
  const [state, setState] = React.useState<'shown' | 'wiping' | 'hidden'>(empty ? 'shown' : 'hidden')
  const wasEmpty = React.useRef(empty)
  React.useEffect(() => {
    if (wasEmpty.current && !empty) setState('wiping') // first message landed → dissolve
    else if (!wasEmpty.current && empty) setState('shown') // back to an empty chat → restore
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
        ...(wiping
          ? {
              WebkitMaskImage: WIPE_MASK,
              maskImage: WIPE_MASK,
              WebkitMaskSize: '300% 100%',
              maskSize: '300% 100%',
              WebkitMaskRepeat: 'no-repeat',
              maskRepeat: 'no-repeat',
              animation: 'cate-pattern-wipe 1500ms cubic-bezier(0.4, 0, 0.2, 1) forwards',
            }
          : null),
      }}
    />
  )
}

// The Cate wordmark greeting for a fresh thread: logo + one calm line on what the
// agent does. Roomier than the card's compact explainer, so the sidebar earns it.
const SidebarEmpty: React.FC = () => (
  <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
    <CateLogo size={44} className="text-secondary opacity-90" />
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-primary">Cate Agent</span>
      <span className="text-[12px] leading-relaxed text-muted">
        Runs parallel loops in isolated worktrees and lands the winner: merge, open a PR, or place it on the canvas.
      </span>
    </div>
  </div>
)

export const CateAgentSidebarView: React.FC<{ wsId: string; rootPath: string }> = ({ wsId, rootPath }) => {
  const ready = useCateAgentReady() === 'ok'
  const cateAgent = useCateAgentWs(wsId)
  const chats = useChatsStore((s) => s.chatsByRoot[rootPath])
  const list = chats ?? []
  const activeChat = cateAgent.activeChatId ? list.find((c) => c.id === cateAgent.activeChatId) : undefined
  const msgCount = activeChat?.messages.length ?? 0
  const runTick = activeChat?.run?.iterations?.length ?? 0
  // "Empty" front door: the observer feed with nothing in it, or a fresh chat with
  // no messages yet. The hatch pattern shows only here and wipes away once content
  // arrives.
  const empty = cateAgent.observerView ? cateAgent.feed.length === 0 : msgCount === 0

  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const onScroll = useStickToBottom(scrollRef, [msgCount, runTick, cateAgent.activeChatId, cateAgent.observerView, cateAgent.feed.length])

  // Prompts of the active chat, for the navigation rail (only while viewing a chat).
  const userMessages = React.useMemo(
    () =>
      !cateAgent.observerView && activeChat
        ? activeChat.messages.flatMap((m) => (m.kind === 'text' && m.role === 'user' ? [{ id: m.id, text: m.text }] : []))
        : [],
    [cateAgent.observerView, activeChat],
  )

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
    // Canvas-colored so the agent panel blends into the canvas-toned right
    // sidebar it lives in, rather than reading as a brighter inset well.
    <div className="relative isolate flex h-full flex-col" style={{ backgroundColor: 'var(--canvas-bg)' }}>
      <PatternLayer empty={empty} />
      <div className="flex-shrink-0 flex items-center px-2 py-1.5">
        <CateAgentChatTabs wsId={wsId} rootPath={rootPath} />
      </div>
      {/* The transcript fills the whole body and scrolls beneath the floating
          composer; its trailing padding keeps the last message clear of the pill.
          The navigation rail overlays the same region. */}
      <div className="relative flex-1 min-h-0">
        <div ref={scrollRef} onScroll={onScroll} className="no-scrollbar absolute inset-0 overflow-y-auto pb-32">
          <CateAgentThread wsId={wsId} rootPath={rootPath} emptyState={<SidebarEmpty />} />
        </div>
        {userMessages.length >= 1 && <CateAgentScrollRail scrollRef={scrollRef} userMessages={userMessages} />}
      </div>
      {/* Floating composer: model + stop controls with the input, over the content,
          with a top fade so the transcript dissolves into it instead of ending on a
          hard border. pointer-events pass through the fade but not the composer. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3 pb-3 pt-10 bg-gradient-to-t from-[var(--canvas-bg)] via-[var(--canvas-bg)] to-transparent">
        <div className="pointer-events-auto">
          <CateAgentComposer wsId={wsId} rootPath={rootPath} />
        </div>
      </div>
    </div>
  )
}
