// =============================================================================
// AgentPanelChrome — extra UI surfaces for the agent panel:
//   • QueueBadges      — small chips for pending steering / follow-up messages
//   • ExtensionStatusBar — extension setStatus() text (footer)
//   • ExtensionWidget   — extension setWidget() lines (above/below editor)

//   • ExtensionDialog   — in-panel renderer for extension_ui_request select /
//     confirm / input / editor (the only modal-like surface, lives inside the
//     panel per the "no modal dialogs for auth" guidance). Requests from the
//     bundled cate-ask-user extension carry a structured envelope in their title
//     and render as a dedicated AskUserCard instead of the generic dialog.
//   • ImageChips / ImageAttachButton — image attachment helpers
//   • ThinkingLevelPicker — reasoning level dropdown
// =============================================================================

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Image as ImageIcon,
  X,
} from '@phosphor-icons/react'
import { CateLogo } from '../../renderer/ui/CateLogo'
import { Tooltip } from '../../renderer/ui/Tooltip'
import type {
  AgentExtensionUIRequest,
  AgentImageAttachment,
  AgentThinkingLevel,
} from '../../shared/types'
import type {
  ExtensionStatusEntry,
  ExtensionWidgetEntry,
} from './agentStore'

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

export function ExtensionStatusBar({ entries }: { entries: ExtensionStatusEntry[] }) {
  // `plan-mode` drives the toggle-button highlight in ChatInput — surfacing it
  // here too would be redundant chrome, so we hide it from the footer.
  const visible = entries.filter((e) => e.key !== 'plan-mode')
  if (visible.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2 px-3 py-1 border-t border-subtle bg-surface-0 text-[11px] text-muted">
      {visible.map((e) => (
        <span key={e.key} className="px-1.5 py-0.5 rounded bg-hover font-mono">
          {e.text}
        </span>
      ))}
    </div>
  )
}

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
// src/agent/extensions/cate-ask-user/index.ts. The extension prefixes its input
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
function decodeAskUser(request: AgentExtensionUIRequest): AskUserQuestion[] | null {
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
  request: AgentExtensionUIRequest
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
          <CateLogo size={12} className="text-agent-light" />
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
  request: AgentExtensionUIRequest
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

// -----------------------------------------------------------------------------
// Image attachment helpers
// -----------------------------------------------------------------------------

export function ImageChips({
  images,
  onRemove,
}: {
  images: AgentImageAttachment[]
  onRemove: (idx: number) => void
}) {
  if (images.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-2 pt-2">
      {images.map((img, i) => (
        <div
          key={i}
          className="flex items-center gap-1 pl-1 pr-1.5 py-0.5 rounded-md bg-agent/15 text-primary text-[10px]"
        >
          <img
            src={`data:${img.mimeType};base64,${img.data}`}
            alt=""
            className="w-5 h-5 rounded object-cover"
          />
          <span className="truncate max-w-[140px]">{img.fileName ?? 'image'}</span>
          <button
            onClick={() => onRemove(i)}
            className="ml-0.5 opacity-70 hover:opacity-100"
            aria-label="Remove image"
          >
            <X size={9} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function ImageAttachButton({ onPick }: { onPick: (img: AgentImageAttachment) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={async (e) => {
          const files = e.target.files
          if (!files) return
          for (const f of Array.from(files)) {
            const img = await readFileAsImage(f)
            if (img) onPick(img)
          }
          if (inputRef.current) inputRef.current.value = ''
        }}
      />
      <Tooltip label="Attach image" placement="top">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="p-1.5 rounded-md text-muted hover:text-primary hover:bg-hover"
          aria-label="Attach image"
        >
          <ImageIcon size={13} />
        </button>
      </Tooltip>
    </>
  )
}

/** Base64-encode raw bytes without the `data:` prefix. */
function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return typeof btoa === 'function' ? btoa(binary) : ''
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif',
  ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff',
}

/** Last path segment of a locator/path, for a display file name. */
function baseName(path: string): string {
  const m = /[^/\\]+$/.exec(path)
  return m ? m[0] : path
}

/** Image mime for a path by extension, or null when it isn't a known image. */
export function imageMimeForPath(path: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  return ext ? IMAGE_MIME_BY_EXT[ext] ?? null : null
}

export async function readFileAsImage(file: File): Promise<AgentImageAttachment | null> {
  if (!file.type.startsWith('image/')) return null
  const data = bytesToBase64(await file.arrayBuffer())
  if (!data) return null
  return { data, mimeType: file.type, fileName: file.name }
}

/** Read an image FILE PATH (Cate Explorer drag, or an external OS path) as an
 *  attachment. Reads through the companion-aware filesystem IPC so it works for
 *  remote workspaces; returns null for non-image paths or unreadable files. */
export async function readPathAsImage(
  path: string,
  workspaceId?: string,
): Promise<AgentImageAttachment | null> {
  const mimeType = imageMimeForPath(path)
  if (!mimeType) return null
  try {
    const buf = await window.electronAPI.fsReadBinary(path, workspaceId)
    const data = bytesToBase64(buf)
    if (!data) return null
    return { data, mimeType, fileName: baseName(path) }
  } catch {
    return null
  }
}

// -----------------------------------------------------------------------------
// Thinking level picker
// -----------------------------------------------------------------------------

const THINKING_LEVELS: AgentThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
const THINKING_BARS: Record<AgentThinkingLevel, number> = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5 }
const TOTAL_BARS = 5

function ThinkingBars({ count, size = 10 }: { count: number; size?: number }) {
  const barW = 2
  const gap = 1
  const totalW = TOTAL_BARS * barW + (TOTAL_BARS - 1) * gap
  return (
    <svg width={totalW} height={size} className="shrink-0">
      {Array.from({ length: TOTAL_BARS }, (_, i) => {
        const h = ((i + 1) / TOTAL_BARS) * size
        const x = i * (barW + gap)
        return (
          <rect
            key={i}
            x={x}
            y={size - h}
            width={barW}
            height={h}
            rx={0.5}
            fill="currentColor"
            opacity={i < count ? 1 : 0.2}
          />
        )
      })}
    </svg>
  )
}

// Resolve the canvas-node element this popover lives inside, so portalled
// content can be positioned relative to it (the node, not the viewport, is
// the scroll/zoom frame of reference). Shared by the chat-input popovers too.
export function useNodePortalTarget(ref: React.RefObject<Element | null>) {
  const getTarget = useCallback(
    () => ref.current?.closest('[data-node-id]') as HTMLElement | null,
    [ref],
  )
  const toLocal = useCallback(
    (viewport: { top: number; left: number }) => {
      const target = getTarget()
      if (!target) return viewport
      const tr = target.getBoundingClientRect()
      // The node lives inside the zoom-scaled canvas world, so a child
      // positioned with absolute top/left has those values multiplied by the
      // canvas zoom on screen. getBoundingClientRect is in screen space, so
      // divide the screen-space delta by the node's effective scale to land
      // the popover exactly on its anchor at any zoom. (Detached panel/dock
      // windows aren't scaled, so scale is 1 and this is a no-op there.)
      const scale = target.offsetWidth > 0 ? tr.width / target.offsetWidth : 1
      return {
        top: (viewport.top - tr.top) / scale,
        left: (viewport.left - tr.left) / scale,
      }
    },
    [getTarget],
  )
  return { getTarget, toLocal }
}

// Shared scaffold for the node-anchored popovers on the chat-input control row
// (compact button, stats chip, thinking-level picker). Owns the open state, the
// outside-click-to-close handler, the portal target, and the position. The
// per-call `layout` maps the trigger's screen rect to a viewport {top,left};
// the hook runs that through `toLocal` so the popover lands on its anchor at any
// canvas zoom.
export function useNodePopover(
  btnRef: React.RefObject<HTMLButtonElement>,
  layout: (rect: DOMRect) => { top: number; left: number },
) {
  const [open, setOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const { getTarget, toLocal } = useNodePortalTarget(btnRef)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!open) return
    setPortalTarget(getTarget())
    const handler = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return
      if (popoverRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, getTarget])
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    setPos(toLocal(layout(btnRef.current.getBoundingClientRect())))
  }, [open, toLocal])
  return { open, setOpen, popoverRef, pos, portalTarget }
}

// Shared shell for the node-anchored popovers: a blurred, bordered card portalled
// into the canvas node and pinned above its trigger (translateY(-100%)). Callers
// supply the distinct width and any extra body classes; behaviour is identical.
export function NodePopover({
  popoverRef,
  pos,
  portalTarget,
  width,
  bodyClassName,
  children,
}: {
  popoverRef: React.RefObject<HTMLDivElement>
  pos: { top: number; left: number } | null
  portalTarget: HTMLElement | null
  width: number
  bodyClassName?: string
  children: React.ReactNode
}) {
  if (!pos || !portalTarget) return null
  return createPortal(
    <div
      ref={popoverRef}
      className={`absolute rounded-lg border border-strong bg-surface-4/98 backdrop-blur-xl shadow-[0_12px_32px_var(--shadow-node)] z-[9999]${bodyClassName ? ` ${bodyClassName}` : ''}`}
      style={{ top: pos.top, left: pos.left, width, transform: 'translateY(-100%)' }}
    >
      {children}
    </div>,
    portalTarget,
  )
}

export function ThinkingLevelPicker({
  level,
  onChange,
  disabled,
}: {
  level: AgentThinkingLevel | null
  onChange: (level: AgentThinkingLevel) => void
  disabled?: boolean
}) {
  const btnRef = useRef<HTMLButtonElement>(null)
  const { open, setOpen, popoverRef, pos, portalTarget } = useNodePopover(
    btnRef,
    (r) => {
      const popW = 160
      let left = r.right - popW
      if (left < 4) left = 4
      return { top: r.top - 4, left }
    },
  )
  const current = level ?? 'medium'
  const bars = THINKING_BARS[current]
  return (
    <>
      <Tooltip label={`Reasoning effort: ${current}`} placement="top">
        <button
          ref={btnRef}
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 px-1.5 py-1 rounded-md text-[10.5px] text-muted/70 hover:text-primary hover:bg-hover disabled:opacity-50"
          aria-label={`Reasoning effort: ${current}`}
        >
          <ThinkingBars count={bars} />
        </button>
      </Tooltip>
      {open && (
        <NodePopover
          popoverRef={popoverRef}
          pos={pos}
          portalTarget={portalTarget}
          width={160}
          bodyClassName="overflow-hidden"
        >
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-semibold text-muted/70 border-b border-subtle">Thinking level</div>
          {THINKING_LEVELS.map((lv) => (
            <button
              key={lv}
              onClick={() => { setOpen(false); onChange(lv) }}
              className={`w-full flex items-center justify-between px-3 py-1.5 text-[12px] capitalize ${
                lv === current ? 'bg-hover-strong text-primary' : 'text-primary hover:bg-hover'
              }`}
            >
              <span>{lv}</span>
              <ThinkingBars count={THINKING_BARS[lv]} />
            </button>
          ))}
        </NodePopover>
      )}
    </>
  )
}
