// =============================================================================
// AgentPanelChrome — extra UI surfaces for the agent panel:
//   • QueueBadges      — small chips for pending steering / follow-up messages
//   • ExtensionWidget   — extension setWidget() lines (above/below editor)

//   • ExtensionDialog   — in-panel renderer for extension_ui_request select /
//     confirm / input / editor (the only modal-like surface, lives inside the
//     panel per the "no modal dialogs for auth" guidance). Requests from the
//     bundled cate-ask-user extension carry a structured envelope in their title
//     and render as a dedicated AskUserCard instead of the generic dialog.
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import { X, Sparkle } from '@phosphor-icons/react'
import type {
  CodingExtensionUIRequest,
} from '../../shared/types'
import type { ExtensionWidgetEntry } from './codingStore'

// -----------------------------------------------------------------------------
// Steering / follow-up queue chips
// -----------------------------------------------------------------------------

export function QueueBadges({
  steering,
  followUp,
}: {
  steering: string[]
  followUp: string[]
}) {
  if (steering.length === 0 && followUp.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-3 py-1 text-[11px]">
      {steering.map((s, i) => (
        <span
          key={`s${i}`}
          title={s}
          className="px-1.5 py-0.5 rounded bg-agent/15 text-agent-light max-w-[200px] truncate"
        >
          steer: {s}
        </span>
      ))}
      {followUp.map((s, i) => (
        <span
          key={`f${i}`}
          title={s}
          className="px-1.5 py-0.5 rounded bg-hover-strong text-primary/80 max-w-[200px] truncate"
        >
          after: {s}
        </span>
      ))}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Extension chrome
// -----------------------------------------------------------------------------

export function ExtensionWidget({
  widgets,
  placement,
}: {
  widgets: ExtensionWidgetEntry[]
  placement: 'aboveEditor' | 'belowEditor'
}) {
  const filtered = widgets.filter((w) => w.placement === placement)
  if (filtered.length === 0) return null
  return (
    <div className="px-3 py-1.5 space-y-2 text-[11.5px] text-primary/90 border-t border-subtle bg-surface-0">
      {filtered.map((w) => (
        <div key={w.key} className="font-mono whitespace-pre">
          {w.lines.join('\n')}
        </div>
      ))}
    </div>
  )
}


// -----------------------------------------------------------------------------
// ask_user card (cate-ask-user extension)
// -----------------------------------------------------------------------------

// Kept in sync with ASK_USER_MARKER in
// src/cateAgent/extensions/cate-ask-user/index.ts. The extension prefixes its input
// `title` with this marker immediately followed by a JSON envelope (no
// surrounding whitespace — pi trims the title).
const ASK_USER_MARKER = 'cate-ask-user:'

interface AskUserOption { label: string; description?: string }
interface AskUserQuestion {
  question: string
  header?: string
  options?: AskUserOption[]
  multiSelect?: boolean
  allowOther?: boolean
}

/** Decode an ask_user envelope from a request title, or null when the request
 *  isn't an ask_user one (so it falls back to the generic dialog). Normalizes the
 *  older single-question shape to a one-element questions[] for safety. */
function decodeAskUser(request: CodingExtensionUIRequest): AskUserQuestion[] | null {
  if (request.method !== 'select' && request.method !== 'input') return null
  const title = typeof request.title === 'string' ? request.title.trim() : ''
  if (!title.startsWith(ASK_USER_MARKER)) return null
  try {
    const payload = JSON.parse(title.slice(ASK_USER_MARKER.length)) as
      | { questions?: AskUserQuestion[]; question?: string; options?: AskUserOption[] }
      | null
    if (payload && Array.isArray(payload.questions) && payload.questions.length > 0) {
      return payload.questions.filter((q) => q && typeof q.question === 'string')
    }
    if (payload && typeof payload.question === 'string') {
      return [{ question: payload.question, options: payload.options }]
    }
  } catch { /* malformed — fall back to generic */ }
  return null
}

function AskUserCard({
  request,
  questions,
  onRespond,
}: {
  request: CodingExtensionUIRequest
  questions: AskUserQuestion[]
  onRespond: (response: { id: string; value?: string; cancelled?: boolean }) => void
}) {
  // Per-question selected option labels, and per-question free-text value.
  const [selected, setSelected] = useState<string[][]>(() => questions.map(() => []))
  const [otherText, setOtherText] = useState<string[]>(() => questions.map(() => ''))
  // One question per page (Claude Code-style); advance with Next, finish with Send.
  const [page, setPage] = useState(0)
  const total = questions.length
  const isLast = page >= total - 1
  const q = questions[page]
  const opts = q.options ?? []
  const hasOptions = opts.length > 0
  const freeOnly = !hasOptions

  const cancel = (): void => onRespond({ id: request.id, cancelled: true })

  const buildAnswers = (): string[][] =>
    questions.map((qq, qi) => {
      const vals = selected[qi].slice()
      const free = otherText[qi]?.trim()
      if (free && (qq.allowOther || !qq.options?.length)) vals.push(free)
      return vals
    })

  const submit = (): void =>
    onRespond({ id: request.id, value: JSON.stringify({ answers: buildAnswers() }) })

  const toggle = (label: string): void => {
    setSelected((prev) => {
      const next = prev.map((a) => a.slice())
      const cur = next[page]
      if (q.multiSelect) {
        const i = cur.indexOf(label)
        if (i === -1) cur.push(label); else cur.splice(i, 1)
      } else {
        next[page] = cur[0] === label ? [] : [label]
      }
      return next
    })
    // Single-select on a non-final page advances automatically; single-question
    // single-select (no free-text) finishes immediately.
    if (!q.multiSelect) {
      if (total === 1 && !q.allowOther) {
        onRespond({ id: request.id, value: JSON.stringify({ answers: questions.map((_, i) => (i === page ? [label] : [])) }) })
      } else if (!isLast) {
        setPage((p) => Math.min(p + 1, total - 1))
      }
    }
  }

  return (
    <div className="rounded-lg border border-agent/40 bg-surface-3/90 backdrop-blur px-3 py-3 space-y-3">
      <div className="flex items-center gap-2">
        <div className="w-5 h-5 rounded-md bg-agent/15 flex items-center justify-center shrink-0">
          <Sparkle size={12} className="text-agent-light" />
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="text-[10.5px] uppercase tracking-wider text-agent-light/80">Cate is asking</span>
          {total > 1 && (
            <span className="text-[10.5px] text-muted">{page + 1} / {total}</span>
          )}
        </div>
        <button onClick={cancel} className="opacity-60 hover:opacity-100 text-muted" aria-label="Dismiss">
          <X size={11} />
        </button>
      </div>

      <div className="space-y-1.5">
        {q.header && (
          <div className="text-[10px] uppercase tracking-wider text-muted">{q.header}</div>
        )}
        <div className="text-[13px] text-primary font-medium whitespace-pre-wrap break-words">
          {q.question}
        </div>

        {hasOptions && (
          <div className="space-y-1.5">
            {opts.map((opt) => {
              const isSel = selected[page].includes(opt.label)
              return (
                <button
                  key={opt.label}
                  onClick={() => toggle(opt.label)}
                  className={`w-full text-left px-3 py-2 rounded-md border transition-colors flex items-start gap-2 ${
                    isSel
                      ? 'bg-agent/20 border-agent/50'
                      : 'bg-hover border-transparent hover:bg-agent/15 hover:border-agent/30'
                  }`}
                >
                  <span
                    className={`shrink-0 mt-[2px] w-3.5 h-3.5 flex items-center justify-center border ${
                      q.multiSelect ? 'rounded-[3px]' : 'rounded-full'
                    } ${isSel ? 'bg-agent border-agent text-white' : 'border-strong'}`}
                  >
                    {isSel && <span className="text-[8px] leading-none">✓</span>}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[12.5px] text-primary">{opt.label}</span>
                    {opt.description && (
                      <span className="block text-[11px] text-muted mt-0.5">{opt.description}</span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {(freeOnly || q.allowOther) && (
          <input
            value={otherText[page]}
            onChange={(e) => setOtherText((prev) => prev.map((t, i) => (i === page ? e.target.value : t)))}
            onKeyDown={(e) => { if (e.key === 'Escape') cancel() }}
            placeholder={freeOnly ? 'Type your answer' : 'Or type your own…'}
            className="w-full bg-surface-3 border border-strong rounded-md px-2 py-1.5 text-[12px] text-primary outline-none focus:border-agent/60"
          />
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => (page > 0 ? setPage((p) => p - 1) : cancel())}
          className="px-2.5 py-1 rounded-md bg-hover hover:bg-hover-strong text-primary text-[12px]"
        >
          {page > 0 ? 'Back' : 'Cancel'}
        </button>
        <div className="flex-1" />
        {isLast ? (
          <button
            onClick={submit}
            className="px-2.5 py-1 rounded-md bg-agent hover:bg-agent-light text-white text-[12px] font-medium"
          >
            Send
          </button>
        ) : (
          <button
            onClick={() => setPage((p) => Math.min(p + 1, total - 1))}
            className="px-2.5 py-1 rounded-md bg-agent hover:bg-agent-light text-white text-[12px] font-medium"
          >
            Next
          </button>
        )}
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Extension dialog (in-panel)
// -----------------------------------------------------------------------------

export function ExtensionDialog({
  request,
  onRespond,
}: {
  request: CodingExtensionUIRequest
  onRespond: (response: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }) => void
}) {
  const [value, setValue] = useState<string>(
    String(request.prefill ?? request.placeholder ?? ''),
  )
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Auto-resolve on timeout if pi specified one — pi clamps the resolution to
  // `undefined`, so we just send `cancelled: true` as the safe default.
  useEffect(() => {
    const timeout = typeof request.timeout === 'number' ? request.timeout : undefined
    if (!timeout) return
    const t = setTimeout(() => onRespond({ id: request.id, cancelled: true }), timeout)
    return () => clearTimeout(t)
  }, [request.id, request.timeout, onRespond])

  // ask_user requests (from the bundled cate-ask-user extension) carry a
  // structured envelope and get a dedicated card instead of the generic dialog.
  const askUser = decodeAskUser(request)
  if (askUser) {
    return <AskUserCard key={request.id} request={request} questions={askUser} onRespond={onRespond} />
  }
  const title = String(request.title ?? '')
  const message = String(request.message ?? '')

  if (request.method === 'select') {
    const options = Array.isArray(request.options) ? (request.options as string[]) : []
    return (
      <DialogShell title={title} message={message} onCancel={() => onRespond({ id: request.id, cancelled: true })}>
        <div className="space-y-1">
          {options.map((opt) => (
            <button
              key={opt}
              onClick={() => onRespond({ id: request.id, value: opt })}
              className="w-full text-left px-3 py-1.5 rounded-md bg-hover hover:bg-agent/30 text-primary text-[12px]"
            >
              {opt}
            </button>
          ))}
        </div>
      </DialogShell>
    )
  }

  if (request.method === 'confirm') {
    return (
      <DialogShell title={title} message={message} onCancel={() => onRespond({ id: request.id, cancelled: true })}>
        <div className="flex items-center gap-2 justify-end">
          <button
            onClick={() => onRespond({ id: request.id, confirmed: false })}
            className="px-2.5 py-1 rounded-md bg-hover hover:bg-hover-strong text-primary text-[12px]"
          >
            No
          </button>
          <button
            onClick={() => onRespond({ id: request.id, confirmed: true })}
            className="px-2.5 py-1 rounded-md bg-agent hover:bg-agent-light text-white text-[12px] font-medium"
          >
            Yes
          </button>
        </div>
      </DialogShell>
    )
  }

  if (request.method === 'input') {
    return (
      <DialogShell title={title} message={message} onCancel={() => onRespond({ id: request.id, cancelled: true })}>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            onRespond({ id: request.id, value })
          }}
          className="space-y-2"
        >
          <input
            ref={(el) => { inputRef.current = el }}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={String(request.placeholder ?? '')}
            className="w-full bg-surface-3 border border-strong rounded-md px-2 py-1 text-[12px] text-primary outline-none focus:border-agent/60"
          />
          <div className="flex items-center gap-2 justify-end">
            <button
              type="button"
              onClick={() => onRespond({ id: request.id, cancelled: true })}
              className="px-2.5 py-1 rounded-md bg-hover hover:bg-hover-strong text-primary text-[12px]"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-2.5 py-1 rounded-md bg-agent hover:bg-agent-light text-white text-[12px] font-medium"
            >
              Submit
            </button>
          </div>
        </form>
      </DialogShell>
    )
  }

  if (request.method === 'editor') {
    return (
      <DialogShell title={title} message={message} onCancel={() => onRespond({ id: request.id, cancelled: true })}>
        <textarea
          ref={(el) => { inputRef.current = el }}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={8}
          className="w-full bg-surface-3 border border-strong rounded-md px-2 py-2 text-[12px] text-primary outline-none focus:border-agent/60 font-mono resize-y"
        />
        <div className="flex items-center gap-2 justify-end mt-2">
          <button
            onClick={() => onRespond({ id: request.id, cancelled: true })}
            className="px-2.5 py-1 rounded-md bg-hover hover:bg-hover-strong text-primary text-[12px]"
          >
            Cancel
          </button>
          <button
            onClick={() => onRespond({ id: request.id, value })}
            className="px-2.5 py-1 rounded-md bg-agent hover:bg-agent-light text-white text-[12px] font-medium"
          >
            Save
          </button>
        </div>
      </DialogShell>
    )
  }

  return null
}

function DialogShell({
  title,
  message,
  children,
  onCancel,
}: {
  title: string
  message?: string
  children: React.ReactNode
  onCancel: () => void
}) {
  return (
    <div className="rounded-lg border border-agent/30 bg-surface-3/90 backdrop-blur px-3 py-3 space-y-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {title && <div className="text-[12.5px] text-primary font-medium">{title}</div>}
          {message && <div className="text-[11.5px] text-muted mt-0.5">{message}</div>}
        </div>
        <button
          onClick={onCancel}
          className="opacity-60 hover:opacity-100 text-muted"
          aria-label="Cancel"
        >
          <X size={11} />
        </button>
      </div>
      {children}
    </div>
  )
}
