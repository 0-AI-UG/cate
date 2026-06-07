// =============================================================================
// ChatPlanCard — "Plan ready" card rendered for `plan_complete` tool calls
// emitted by the cate-plan-mode pi extension. Shows summary + ordered steps +
// three actions: Implement, Refine plan, Clear context & implement. Locks after
// any action so historical cards can't re-trigger.
// =============================================================================

import { useMemo, useState } from 'react'
import { ClipboardText } from '@phosphor-icons/react'
import type { ToolMessage } from './agentStore'

interface PlanStep {
  title: string
  detail?: string
}

interface PlanArgs {
  summary?: string
  steps?: PlanStep[]
}

function parsePlanArgs(raw: unknown): PlanArgs {
  let obj: unknown = raw
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj) } catch { /* fall through */ }
  }
  if (!obj || typeof obj !== 'object') return {}
  const o = obj as Record<string, unknown>
  const summary = typeof o.summary === 'string' ? o.summary : undefined
  const steps: PlanStep[] = []
  if (Array.isArray(o.steps)) {
    for (const s of o.steps) {
      if (s && typeof s === 'object') {
        const r = s as Record<string, unknown>
        const title = typeof r.title === 'string' ? r.title : undefined
        const detail = typeof r.detail === 'string' ? r.detail : undefined
        if (title) steps.push({ title, detail })
      }
    }
  }
  return { summary, steps }
}

export function PlanReadyCard({
  msg,
  onImplement,
  onRefine,
  onClearAndImplement,
  stale,
}: {
  msg: ToolMessage
  onImplement?: () => void
  onRefine?: (text: string) => void
  onClearAndImplement?: () => void
  /** True when this plan is no longer the latest message in the thread — i.e.
   *  the user already acted on it (or moved on) in a prior session that has
   *  since been reloaded. Card renders read-only. */
  stale?: boolean
}) {
  const { summary, steps } = useMemo(() => parsePlanArgs(msg.args), [msg.args])
  const [refineText, setRefineText] = useState('')
  const [locked, setLocked] = useState<null | 'implement' | 'refine' | 'clear'>(null)
  const effectiveLocked = locked ?? (stale ? 'implement' : null)

  const handleImplement = () => {
    if (effectiveLocked) return
    setLocked('implement')
    onImplement?.()
  }
  const handleRefine = () => {
    if (effectiveLocked) return
    const text = refineText.trim()
    if (!text) return
    setLocked('refine')
    onRefine?.(text)
  }
  const handleClear = () => {
    if (effectiveLocked) return
    setLocked('clear')
    onClearAndImplement?.()
  }

  const lockLabel = (base: string, kind: 'implement' | 'refine' | 'clear'): string => {
    // Only re-label when this session triggered the action — a stale reload
    // shows the original labels (we don't know which action was taken).
    if (!locked) return base
    if (locked === kind) {
      if (kind === 'implement') return 'Implemented'
      if (kind === 'refine') return 'Refined'
      return 'Cleared and implemented'
    }
    return base
  }

  return (
    <div className={`rounded-lg border border-agent/40 bg-agent/10 overflow-hidden text-[12px] ${effectiveLocked ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-agent/20">
        <ClipboardText size={13} weight="duotone" className="text-agent-light shrink-0" />
        <span className="text-primary font-medium">Plan ready</span>
      </div>
      <div className="px-3 py-3 space-y-3 select-text">
        {summary && (
          <div className="text-[12.5px] text-primary/90 leading-relaxed whitespace-pre-wrap break-words">
            {summary}
          </div>
        )}
        {steps && steps.length > 0 && (
          <ol className="space-y-2">
            {steps.map((s, i) => (
              <li key={i} className="flex gap-2.5">
                <span className="shrink-0 text-agent-light font-mono text-[12px] mt-[1px]">
                  {i + 1}.
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] text-primary font-medium leading-snug">
                    {s.title}
                  </div>
                  {s.detail && (
                    <div className="text-[11.5px] text-primary/75 leading-relaxed mt-0.5 whitespace-pre-wrap break-words">
                      {s.detail}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
        <textarea
          value={refineText}
          onChange={(e) => setRefineText(e.target.value)}
          disabled={!!effectiveLocked}
          rows={2}
          placeholder="Refine: type the changes you want…"
          className="w-full rounded-md bg-surface-0 border border-agent/20 focus:border-agent-light/60 outline-none px-2.5 py-2 text-[12px] text-primary placeholder:text-muted resize-none disabled:opacity-50"
        />
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleRefine}
            disabled={!!effectiveLocked || refineText.trim().length === 0}
            className="px-2.5 py-1 rounded-md bg-hover hover:bg-agent/20 text-primary text-[11.5px] font-medium disabled:opacity-50 disabled:cursor-default disabled:hover:bg-[var(--surface-hover)]"
          >
            {lockLabel('Refine plan', 'refine')}
          </button>
          <button
            onClick={handleClear}
            disabled={!!effectiveLocked}
            className="px-2.5 py-1 rounded-md bg-hover hover:bg-agent/20 text-primary text-[11.5px] font-medium disabled:opacity-50 disabled:cursor-default disabled:hover:bg-[var(--surface-hover)]"
          >
            {lockLabel('Clear context & implement', 'clear')}
          </button>
          <div className="flex-1" />
          <button
            onClick={handleImplement}
            disabled={!!effectiveLocked}
            className="px-3 py-1 rounded-md bg-agent hover:bg-agent-light text-white text-[11.5px] font-medium disabled:opacity-50 disabled:cursor-default disabled:hover:bg-agent"
          >
            {lockLabel('Implement', 'implement')}
          </button>
        </div>
      </div>
    </div>
  )
}
