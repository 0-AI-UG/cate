// How each agent appears in the usage overview: label and series colour.
// Declaration order is the reading order of every chart and table.

import type { ReactNode } from 'react'
import { RotateCw } from 'lucide-react'
import { AGENT_DEFS, type AgentId } from '@services/agents/contract'

export const AGENT_COLORS: Record<AgentId, string> = {
  codex: 'var(--text-primary)',
  'claude-code': '#d97757',
  grok: 'color-mix(in oklab, var(--text-primary) 72%, var(--canvas-bg))',
  opencode: '#5b9cf5',
  hermes: '#c9a227',
  kiro: '#9046ff',
  cursor: 'var(--text-secondary)',
}

export const AGENT_ORDER = Object.keys(AGENT_COLORS) as AgentId[]

export const agentLabel = (agent: AgentId): string => AGENT_DEFS[agent].displayName

/** Agents with real activity, in reading order. */
export function agentsWithUsage(totals: ReadonlyArray<{ agent: AgentId; costUsd: number; totalTokens: number }>): AgentId[] {
  const active = new Set(totals.filter((t) => t.totalTokens > 0 || t.costUsd > 0).map((t) => t.agent))
  return AGENT_ORDER.filter((agent) => active.has(agent))
}

/** A segmented toggle (the upstream `ToggleGroup` look). */
export function Segmented<T extends string>({ label, value, options, disabled = false, onChange }: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  disabled?: boolean
  onChange: (value: T) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`inline-flex gap-px rounded-lg border p-0.5 ${disabled ? 'opacity-50' : ''}`}
      style={{ background: 'color-mix(in srgb, var(--text-primary) 5%, var(--canvas-bg))', borderColor: 'color-mix(in srgb, var(--text-primary) 4%, transparent)' }}
    >
      {options.map((option) => {
        const pressed = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={pressed}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`h-6 rounded-md px-[9px] text-[12px] font-medium leading-4 transition-[background,color,box-shadow] duration-150 ${pressed ? 'text-primary' : 'text-muted enabled:hover:text-primary enabled:hover:bg-[color-mix(in_srgb,var(--text-primary)_5%,transparent)]'}`}
            style={pressed ? {
              background: 'color-mix(in srgb, var(--text-primary) 10%, var(--canvas-bg))',
              boxShadow: '0 1px 3px #00000018, inset 0 1px color-mix(in srgb, var(--text-primary) 5%, transparent)',
            } : undefined}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-md bg-surface-3 motion-reduce:animate-none ${className}`} />
}

export function RefreshButton({ label, refreshing, onClick }: { label: string; refreshing: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-busy={refreshing}
      disabled={refreshing}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-secondary transition-colors hover:bg-hover hover:text-primary disabled:opacity-60"
    >
      <span className={`inline-flex ${refreshing ? 'animate-spin motion-reduce:animate-none' : ''}`}><RotateCw size={14} /></span>
    </button>
  )
}

export function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[12px] text-muted">{label}</span>
      <span className="text-[13px] font-medium tabular-nums text-primary">{value}</span>
    </div>
  )
}
