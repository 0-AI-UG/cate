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
  /** Bottom-anchor controls when the input has wrapped (else vertically center). */
  multiline: boolean
  /** Read-only: the observer timeline owns the panel body, which takes no reply. */
  disabled?: boolean
  onSend: (text: string) => void
  onClose: () => void
  /** Reports the textarea's current content height (px) so the toolbar resizes. */
  onHeightChange?: (px: number) => void
}> = ({ workspaceId, multiline, disabled, onSend, onClose, onHeightChange }) => {
  // Seed from the persisted draft so a reopened bar (or a fresh app launch)
  // restores whatever was typed but not sent.
  const [text, setText] = React.useState(() => loadDraft(workspaceId))
  const ref = React.useRef<HTMLTextAreaElement>(null)

  const update = (value: string): void => {
    // Normalize line endings and drop leading blank lines — a paste that carried
    // a leading newline (or CRLF endings) would otherwise open the bar on an empty
    // first line above the text.
    const normalized = value.replace(/\r\n?/g, '\n').replace(/^\n+/, '')
    setText(normalized)
    saveDraft(workspaceId, normalized)
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

  // The bar lives in a zone that animates its width open/closed; how many lines the
  // content wraps onto — and thus the height — depends on that width. Without this,
  // a draft measured at the narrow start of the open animation freezes at a taller
  // height and never shrinks back once the zone finishes widening, leaving the
  // toolbar stuck tall (even after the text is sent and the input goes empty).
  // Recompute on any WIDTH change so the reported height always matches the current
  // width; guarded to width-only so setting our own height can't feed back into a loop.
  React.useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let lastW = el.clientWidth
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      if (w === lastW) return
      lastW = w
      resize()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [resize])

  const send = () => {
    if (disabled) return
    const t = text.trim()
    if (!t) return
    onSend(t)
    update('')
  }

  return (
    <div className={`flex ${multiline ? 'items-end' : 'items-center'} gap-1.5 w-full pl-1`}>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        disabled={disabled}
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
        placeholder={disabled ? 'Viewing observer feed' : 'Message Cate…'}
        className="flex-1 min-w-0 resize-none bg-transparent text-sm leading-snug text-primary px-2 py-1.5 outline-none placeholder:text-muted disabled:cursor-default"
        style={{ maxHeight: MAX_HEIGHT }}
      />
      <button
        type="button"
        onClick={send}
        disabled={disabled || !text.trim()}
        aria-label="Send"
        title="Send"
        style={{ WebkitTapHighlightColor: 'transparent' }}
        className="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-full border border-strong bg-transparent text-secondary hover:text-primary hover:bg-hover-strong active:scale-[0.92] transition-all duration-100 disabled:opacity-30"
      >
        <ArrowUp size={15} weight="bold" />
      </button>
    </div>
  )
}
