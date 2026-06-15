// =============================================================================
// CateAgentInputBar — replaces the toolbar's tool buttons while the Cate Agent
// input is open. An auto-growing textarea (wraps long text onto multiple lines)
// + send button. Enter sends; Shift+Enter inserts a newline; Escape closes.
// Reports its content height via onHeightChange so the toolbar can grow/shrink
// to fit (and animate that change).
//
// The draft is persisted per-workspace in localStorage, so an unsent prompt
// survives closing the bar, switching away, and even an app restart / crash;
// it's cleared once sent.
// =============================================================================

import React from 'react'
import { ArrowUp } from '@phosphor-icons/react'

/** Cap the textarea growth; beyond this it scrolls internally. */
const MAX_HEIGHT = 160

const draftKey = (wsId: string): string => `cate.agentDraft.${wsId}`
const loadDraft = (wsId: string): string => {
  try {
    return wsId ? localStorage.getItem(draftKey(wsId)) ?? '' : ''
  } catch {
    return ''
  }
}
const saveDraft = (wsId: string, value: string): void => {
  try {
    if (!wsId) return
    if (value) localStorage.setItem(draftKey(wsId), value)
    else localStorage.removeItem(draftKey(wsId))
  } catch {
    /* private mode / quota — drafts are best-effort */
  }
}

export const CateAgentInputBar: React.FC<{
  workspaceId: string
  onSend: (text: string) => void
  onClose: () => void
  /** Reports the textarea's current content height (px) so the toolbar resizes. */
  onHeightChange?: (px: number) => void
}> = ({ workspaceId, onSend, onClose, onHeightChange }) => {
  // Seed from the persisted draft so a reopened bar (or a fresh app launch)
  // restores whatever was typed but not sent.
  const [text, setText] = React.useState(() => loadDraft(workspaceId))
  const ref = React.useRef<HTMLTextAreaElement>(null)

  const update = (value: string): void => {
    setText(value)
    saveDraft(workspaceId, value)
  }

  // Grow the textarea to fit its content (measured by collapsing to 0 first) and
  // report that height upward so the toolbar zone can match it.
  const resize = React.useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    const full = el.scrollHeight
    const h = Math.min(full, MAX_HEIGHT)
    el.style.height = `${h}px`
    // Only show a scrollbar once the content actually exceeds the cap; otherwise
    // the textarea fits its content exactly and a scrollbar would be spurious.
    el.style.overflowY = full > MAX_HEIGHT ? 'auto' : 'hidden'
    onHeightChange?.(h)
  }, [onHeightChange])

  React.useEffect(() => {
    ref.current?.focus()
    resize()
  }, [resize])
  React.useEffect(() => {
    resize()
  }, [text, resize])

  const send = () => {
    const t = text.trim()
    if (!t) return
    onSend(t)
    update('')
  }

  return (
    <div className="flex items-end gap-1.5 w-full px-1">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        onChange={(e) => update(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
        placeholder="Ask the Cate Agent…"
        className="flex-1 min-w-0 resize-none bg-transparent text-sm leading-snug text-primary px-2 py-1.5 outline-none placeholder:text-muted"
        style={{ maxHeight: MAX_HEIGHT }}
      />
      <button
        type="button"
        onClick={send}
        disabled={!text.trim()}
        aria-label="Send"
        style={{ WebkitTapHighlightColor: 'transparent' }}
        className="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-full border border-strong bg-transparent text-secondary hover:text-primary hover:bg-hover-strong active:scale-[0.92] transition-all duration-100 disabled:opacity-30"
      >
        <ArrowUp size={15} weight="bold" />
      </button>
    </div>
  )
}
