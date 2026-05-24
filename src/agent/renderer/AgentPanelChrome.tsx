// =============================================================================
// AgentPanelChrome — extra UI surfaces for the agent panel:
//   • StatsBar         — context%/cost/turn counters in the header
//   • CompactionBanner — visible while pi compacts the conversation
//   • RetryBanner      — visible while pi auto-retries a transient API error
//   • QueueBadges      — small chips for pending steering / follow-up messages
//   • ExtensionStatusBar — extension setStatus() text (footer)
//   • ExtensionWidget   — extension setWidget() lines (above/below editor)
//   • NotificationsStack — extension notify() toasts
//   • ExtensionDialog   — in-panel renderer for extension_ui_request select /
//     confirm / input / editor (the only modal-like surface, lives inside the
//     panel per the "no modal dialogs for auth" guidance)
//   • ImageChips / ImageAttachButton — image attachment helpers
//   • ThinkingLevelPicker — reasoning level dropdown
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import {
  Brain,
  Image as ImageIcon,
  Info,
  Spinner,
  Stack,
  Warning,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import type {
  AgentExtensionUIRequest,
  AgentImageAttachment,
  AgentSessionStats,
  AgentThinkingLevel,
} from '../../shared/types'
import type {
  CompactionState,
  ExtensionNotification,
  ExtensionStatusEntry,
  ExtensionWidgetEntry,
  RetryState,
} from './agentStore'

// -----------------------------------------------------------------------------
// Stats bar
// -----------------------------------------------------------------------------

export function StatsBar({ stats }: { stats: AgentSessionStats | null }) {
  if (!stats) return null
  const ctx = stats.contextUsage
  const pct = ctx?.percent ?? null
  const window = ctx?.contextWindow
  const pctColor =
    pct == null ? 'text-muted' : pct > 85 ? 'text-red-300' : pct > 65 ? 'text-amber-300' : 'text-muted'

  return (
    <div className="flex items-center gap-2 text-[11px] font-mono">
      {pct != null && window != null && (
        <div className="flex items-center gap-1.5" title={`${ctx?.tokens ?? 0} / ${window} tokens`}>
          <Stack size={11} className="text-muted" />
          <span className={pctColor}>{pct}%</span>
        </div>
      )}
      <span className="text-muted/60">·</span>
      <span className="text-muted" title="Total tokens this session">
        {formatTokens(stats.tokens.total)}t
      </span>
      <span className="text-muted/60">·</span>
      <span className="text-muted" title="Estimated cost so far">
        ${stats.cost.toFixed(stats.cost < 0.01 ? 4 : 2)}
      </span>
    </div>
  )
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

// -----------------------------------------------------------------------------
// Compaction + retry banners
// -----------------------------------------------------------------------------

export function CompactionBanner({ state }: { state: CompactionState }) {
  if (!state.active && !state.lastErrorMessage && !state.lastResult) return null

  if (state.active) {
    const label =
      state.reason === 'manual'
        ? 'Compacting context…'
        : state.reason === 'overflow'
        ? 'Context overflow — compacting…'
        : 'Auto-compacting context…'
    return (
      <BannerRow tone="info">
        <Spinner size={11} className="text-agent-light animate-spin shrink-0" />
        <span>{label}</span>
      </BannerRow>
    )
  }

  if (state.lastErrorMessage) {
    return (
      <BannerRow tone="error">
        <Warning size={11} className="shrink-0" />
        <span>Compaction failed: {state.lastErrorMessage}</span>
      </BannerRow>
    )
  }

  if (state.lastResult) {
    return (
      <BannerRow tone="muted">
        <Stack size={11} className="shrink-0" />
        <span>
          Compacted context
          {state.lastResult.tokensBefore != null ? ` (was ${formatTokens(state.lastResult.tokensBefore)}t)` : ''}.
        </span>
      </BannerRow>
    )
  }
  return null
}

export function RetryBanner({
  state,
  onAbort,
}: {
  state: RetryState
  onAbort: () => void
}) {
  if (!state.active && !state.finalError) return null
  if (state.active) {
    const delay = state.delayMs != null ? `${Math.round(state.delayMs / 100) / 10}s` : '…'
    return (
      <BannerRow tone="warning">
        <Spinner size={11} className="animate-spin shrink-0" />
        <span className="flex-1">
          Auto-retry attempt {state.attempt ?? '?'}/{state.maxAttempts ?? '?'} in {delay}
          {state.errorMessage ? ` — ${trimMessage(state.errorMessage)}` : ''}
        </span>
        <button
          onClick={onAbort}
          className="px-2 py-0.5 rounded-md bg-white/10 hover:bg-white/20 text-primary text-[10px]"
        >
          Abort
        </button>
      </BannerRow>
    )
  }
  return (
    <BannerRow tone="error">
      <WarningCircle size={11} className="shrink-0" />
      <span>Retries exhausted: {trimMessage(state.finalError ?? 'unknown error')}</span>
    </BannerRow>
  )
}

function trimMessage(s: string): string {
  return s.length > 160 ? `${s.slice(0, 160)}…` : s
}

function BannerRow({
  tone,
  children,
}: {
  tone: 'info' | 'warning' | 'error' | 'muted'
  children: React.ReactNode
}) {
  const toneClass =
    tone === 'info'
      ? 'bg-agent/10 text-primary border-agent/30'
      : tone === 'warning'
      ? 'bg-amber-500/10 text-amber-100 border-amber-500/30'
      : tone === 'error'
      ? 'bg-red-500/10 text-red-100 border-red-500/30'
      : 'bg-white/[0.02] text-muted border-white/5'
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 border-b text-[11.5px] ${toneClass}`}>
      {children}
    </div>
  )
}

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

export function NotificationsStack({
  items,
  onDismiss,
}: {
  items: ExtensionNotification[]
  onDismiss: (id: string) => void
}) {
  useEffect(() => {
    // Info notifications auto-dismiss after 5 seconds; warning/error stay
    // until clicked so the user actually sees them.
    const timers: Array<ReturnType<typeof setTimeout>> = []
    for (const n of items) {
      if (n.notifyType !== 'info') continue
      timers.push(setTimeout(() => onDismiss(n.id), 5000))
    }
    return () => { timers.forEach(clearTimeout) }
  }, [items, onDismiss])

  if (items.length === 0) return null
  return (
    <div className="absolute bottom-3 right-3 z-10 space-y-1.5 max-w-[280px]">
      {items.map((n) => {
        const tone =
          n.notifyType === 'error'
            ? 'bg-red-500/95 text-white'
            : n.notifyType === 'warning'
            ? 'bg-amber-500/95 text-black'
            : 'bg-surface-3/95 text-primary border border-white/10'
        const Icon = n.notifyType === 'error' ? WarningCircle : n.notifyType === 'warning' ? Warning : Info
        return (
          <div
            key={n.id}
            className={`flex items-start gap-2 px-3 py-2 rounded-lg shadow-lg backdrop-blur text-[12px] ${tone}`}
          >
            <Icon size={13} className="shrink-0 mt-[1px]" />
            <span className="flex-1 whitespace-pre-wrap break-words">{n.message}</span>
            <button
              onClick={() => onDismiss(n.id)}
              className="opacity-70 hover:opacity-100 shrink-0"
              aria-label="Dismiss"
            >
              <X size={11} />
            </button>
          </div>
        )
      })}
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
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])
  const current = level ?? 'medium'
  const short = current === 'minimal' ? 'min' : current === 'medium' ? 'med' : current
  return (
    <div ref={wrapRef} className="relative">
      <button
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-0.5 px-1.5 py-1 rounded-md text-[10.5px] text-muted/70 hover:text-primary hover:bg-white/5 disabled:opacity-50"
        title={`Reasoning effort — ${current}. Click to change (off/minimal/low/medium/high/xhigh).`}
      >
        <Brain size={12} />
        <span className="font-mono">{short}</span>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 w-[140px] rounded-lg border border-white/10 bg-surface-4/98 backdrop-blur-xl shadow-[0_12px_32px_rgba(0,0,0,0.45)] z-30">
          {THINKING_LEVELS.map((lv) => (
            <button
              key={lv}
              onClick={() => { setOpen(false); onChange(lv) }}
              className={`w-full text-left px-3 py-1.5 text-[12px] capitalize ${
                lv === current ? 'bg-white/10 text-primary' : 'text-primary hover:bg-white/5'
              }`}
            >
              {lv}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
