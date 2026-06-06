// =============================================================================
// AgentPanelChrome — extra UI surfaces for the agent panel:
//   • QueueBadges      — small chips for pending steering / follow-up messages
//   • ExtensionStatusBar — extension setStatus() text (footer)
//   • ExtensionWidget   — extension setWidget() lines (above/below editor)

//   • ExtensionDialog   — in-panel renderer for extension_ui_request select /
//     confirm / input / editor (the only modal-like surface, lives inside the
//     panel per the "no modal dialogs for auth" guidance)
//   • ImageChips / ImageAttachButton — image attachment helpers
//   • ThinkingLevelPicker — reasoning level dropdown
// =============================================================================

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Image as ImageIcon,
  X,
} from '@phosphor-icons/react'
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
          className="px-1.5 py-0.5 rounded bg-white/10 text-primary/80 max-w-[200px] truncate"
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
    <div className="flex flex-wrap gap-2 px-3 py-1 border-t border-white/5 bg-black/15 text-[11px] text-muted">
      {visible.map((e) => (
        <span key={e.key} className="px-1.5 py-0.5 rounded bg-white/5 font-mono">
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
    <div className="px-3 py-1.5 space-y-2 text-[11.5px] text-primary/90 border-t border-white/5 bg-black/15">
      {filtered.map((w) => (
        <div key={w.key} className="font-mono whitespace-pre">
          {w.lines.join('\n')}
        </div>
      ))}
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
              className="w-full text-left px-3 py-1.5 rounded-md bg-white/5 hover:bg-agent/30 text-primary text-[12px]"
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
            className="px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-primary text-[12px]"
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
            className="w-full bg-surface-3 border border-white/10 rounded-md px-2 py-1 text-[12px] text-primary outline-none focus:border-agent/60"
          />
          <div className="flex items-center gap-2 justify-end">
            <button
              type="button"
              onClick={() => onRespond({ id: request.id, cancelled: true })}
              className="px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-primary text-[12px]"
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
          className="w-full bg-surface-3 border border-white/10 rounded-md px-2 py-2 text-[12px] text-primary outline-none focus:border-agent/60 font-mono resize-y"
        />
        <div className="flex items-center gap-2 justify-end mt-2">
          <button
            onClick={() => onRespond({ id: request.id, cancelled: true })}
            className="px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-primary text-[12px]"
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
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="p-1.5 rounded-md text-muted hover:text-primary hover:bg-white/5"
        title="Attach image"
      >
        <ImageIcon size={13} />
      </button>
    </>
  )
}

export async function readFileAsImage(file: File): Promise<AgentImageAttachment | null> {
  if (!file.type.startsWith('image/')) return null
  const buf = await file.arrayBuffer()
  // Convert to base64 without `data:` prefix.
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  const data = typeof btoa === 'function' ? btoa(binary) : ''
  if (!data) return null
  return { data, mimeType: file.type, fileName: file.name }
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

export function ThinkingLevelPicker({
  level,
  onChange,
  disabled,
}: {
  level: AgentThinkingLevel | null
  onChange: (level: AgentThinkingLevel) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
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
    const r = btnRef.current.getBoundingClientRect()
    const popW = 160
    let left = r.right - popW
    if (left < 4) left = 4
    setPos(toLocal({ top: r.top - 4, left }))
  }, [open, toLocal])
  const current = level ?? 'medium'
  const bars = THINKING_BARS[current]
  return (
    <>
      <button
        ref={btnRef}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-1.5 py-1 rounded-md text-[10.5px] text-muted/70 hover:text-primary hover:bg-white/5 disabled:opacity-50"
        title={`Reasoning effort: ${current}`}
      >
        <ThinkingBars count={bars} />
      </button>
      {open && pos && portalTarget && createPortal(
        <div
          ref={popoverRef}
          className="absolute w-[160px] rounded-lg border border-white/10 bg-surface-4/98 backdrop-blur-xl shadow-[0_12px_32px_rgba(0,0,0,0.45)] z-[9999] overflow-hidden"
          style={{ top: pos.top, left: pos.left, transform: 'translateY(-100%)' }}
        >
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-semibold text-muted/70 border-b border-white/5">Thinking level</div>
          {THINKING_LEVELS.map((lv) => (
            <button
              key={lv}
              onClick={() => { setOpen(false); onChange(lv) }}
              className={`w-full flex items-center justify-between px-3 py-1.5 text-[12px] capitalize ${
                lv === current ? 'bg-white/10 text-primary' : 'text-primary hover:bg-white/5'
              }`}
            >
              <span>{lv}</span>
              <ThinkingBars count={THINKING_BARS[lv]} />
            </button>
          ))}
        </div>,
        portalTarget,
      )}
    </>
  )
}
