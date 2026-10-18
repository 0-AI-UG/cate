// The overview's Limits view: the subscription quota of every account the
// workspace's agent CLIs are signed in to, as its runtime reports it.
// Countdowns anchor to the render time instead of ticking.

import { useState, type ReactNode } from 'react'
import { Gauge, Ticket, TrendingDown, TrendingUp } from 'lucide-react'
import {
  formatDuration,
  formatResetsIn,
  resetCreditsSummary,
  type UsageAccountLimits,
  type UsageLimitPace,
  type UsageLimitWindowStatus,
  type UsageLimitsReport,
} from '@services/agents/contract'
import type { UsageReport } from '@services/agents/client'
import { Tooltip } from '../../../kernel/interaction'
import { AGENT_COLORS, AgentMark, Skeleton, agentLabel } from './presentation'

const PACE: Record<UsageLimitPace, { label: string; Icon: typeof Gauge }> = {
  ahead: { label: 'Ahead of pace: spending faster than the window elapses', Icon: TrendingUp },
  on: { label: 'On pace with the window', Icon: Gauge },
  under: { label: 'Under pace: headroom left for the rest of the window', Icon: TrendingDown },
}

function PaceIcon({ pace }: { pace: UsageLimitPace }) {
  const { label, Icon } = PACE[pace]
  return (
    <Tooltip label={label} placement="top">
      <span role="img" aria-label={label} className="inline-flex text-muted"><Icon size={14} aria-hidden /></span>
    </Tooltip>
  )
}

const upcoming = (iso: string) => new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 tabular-nums text-primary">{children}</span>
    </div>
  )
}

/** One account in one window: plan, the email and the reset. */
function WindowDetails({ account, window, now }: { account: UsageAccountLimits; window: UsageLimitWindowStatus; now: number }) {
  const [showEmail, setShowEmail] = useState(false)
  const resetsIn = formatResetsIn(window, now)
  const credits = account.resetCredits
  return (
    <div className="flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-2.5 text-[12px]">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-[13px] font-medium text-primary"><AgentMark agent={account.agent} size={16} /><span className="truncate">{agentLabel(account.agent)}</span></span>
        {account.email && (
          <button type="button" aria-label="Toggle account email visibility" onClick={() => setShowEmail((v) => !v)} className="w-fit text-left text-muted hover:text-primary">
            {showEmail ? account.email : <span className="select-none blur-[4px]">{account.email}</span>}
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1 border-t border-subtle pt-2.5">
        {account.plan && <Row label="Plan">{account.plan}</Row>}
        <Row label="Left">{window.remainingPercent}%</Row>
        {window.resetsAt && <Row label="Resets">{upcoming(window.resetsAt)}{resetsIn ? ` · ${resetsIn.replace('resets in ', 'in ')}` : ''}</Row>}
      </div>
      {credits && credits.availableCount > 0 && (
        <div className="border-t border-subtle pt-2.5 text-muted tabular-nums">{resetCreditsSummary(credits, now)}</div>
      )}
    </div>
  )
}

/** The window's bar, with its details on hover or focus. */
function WindowBar({ account, window, color, now }: { account: UsageAccountLimits; window: UsageLimitWindowStatus; color: string; now: number }) {
  const [open, setOpen] = useState(false)
  const remaining = window.remainingPercent
  const resetsIn = formatResetsIn(window, now)
  const credits = account.resetCredits?.availableCount ?? 0
  return (
    <div className="relative min-w-0" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-label={`${agentLabel(account.agent)}: ${remaining}% left${resetsIn ? `, ${resetsIn}` : ''}${credits ? `, ${credits} reset ${credits === 1 ? 'credit' : 'credits'} banked` : ''}`}
        className={`relative h-8 w-full min-w-0 cursor-default overflow-hidden rounded-md bg-surface-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-blue ${open ? 'ring-1 ring-[var(--border-subtle)]' : ''}`}
      >
        {/* Translucent so the label reads over the fill for any colour and theme. */}
        <div aria-hidden className="absolute inset-y-0 left-0 rounded-md opacity-35" style={{ width: `${remaining}%`, backgroundColor: color }} />
        {/* The spent share is hatched: it is what the countdown restores. */}
        {remaining < 100 && window.resetsAt && (
          <div aria-hidden className="absolute inset-y-0 right-0 opacity-20" style={{ width: `${100 - remaining}%`, backgroundImage: `repeating-linear-gradient(135deg, ${color} 0 1px, transparent 1px 5px)` }} />
        )}
        <div className="relative flex h-full min-w-0 items-center gap-1.5 px-2 text-[12px]">
          <span className="min-w-0 truncate font-medium text-primary">{account.plan ?? agentLabel(account.agent)}</span>
          <span className="shrink-0 font-semibold tabular-nums text-primary">{remaining}%</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 rounded-sm bg-canvas-bg px-1.5 py-0.5 text-[11px] tabular-nums text-primary" style={{ opacity: 0.85 }}>
            {resetsIn?.replace('resets in ', '↻ ') ?? ''}
            {credits > 0 && (
              <>
                {resetsIn && <span aria-hidden className="text-muted">·</span>}
                <span aria-hidden className="inline-flex items-center gap-0.5 font-semibold"><Ticket size={12} />{credits}</span>
              </>
            )}
          </span>
        </div>
      </button>
      {open && (
        <div role="tooltip" className="absolute bottom-full left-0 z-20 mb-1.5 rounded-xl border border-subtle bg-surface-2 p-3 shadow-lg">
          <WindowDetails account={account} window={window} now={now} />
        </div>
      )}
    </div>
  )
}

/** The big number beside the bar: what is left, the pace and the refill. */
function WindowCard({ account, window, color, now }: { account: UsageAccountLimits; window: UsageLimitWindowStatus; color: string; now: number }) {
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : NaN
  const refill = 100 - window.remainingPercent
  return (
    <div className="grid items-center gap-x-6 gap-y-3 rounded-lg border border-subtle p-4 md:grid-cols-[11rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-medium text-primary">{window.label}</span>
        <span className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums text-primary">{window.remainingPercent}%</span>
          <span className="text-[13px] text-muted">left</span>
          {window.pace && <PaceIcon pace={window.pace} />}
        </span>
        {Number.isFinite(resetsAt) && refill > 0 && (
          <span className="text-[12px] tabular-nums text-muted">
            <span className="font-medium text-primary">↻ +{refill}%</span>{' '}
            {resetsAt <= now ? 'now' : `in ${formatDuration(resetsAt - now)}`}
          </span>
        )}
      </div>
      <WindowBar account={account} window={window} color={color} now={now} />
    </div>
  )
}

function AccountSection({ account, now }: { account: UsageAccountLimits; now: number }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-[14px] font-medium text-primary"><AgentMark agent={account.agent} size={16} />{agentLabel(account.agent)}</h2>
      {account.windows.map((window) => <WindowCard key={`${window.kind}:${window.id}`} account={account} window={window} color={AGENT_COLORS[account.agent]} now={now} />)}
    </section>
  )
}

export function UsageLimitsSection({ report }: { report: UsageReport<UsageLimitsReport> }) {
  // Anchored once per mount on purpose: countdowns must not tick.
  const [now] = useState(() => Date.now())
  if (report.value === null) {
    if (report.error !== null) return <p className="text-[13px] text-danger">{report.error}</p>
    return (
      <div className="flex flex-col gap-8">
        {[0, 1].map((key) => (
          <section key={key} className="flex flex-col gap-3">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-[106px]" />
          </section>
        ))}
      </div>
    )
  }
  const { accounts, notices } = report.value
  return (
    <div className="flex flex-col gap-8">
      {accounts.length === 0 && <p className="text-[13px] text-muted">No agent in this workspace reports subscription limits.</p>}
      {accounts.map((account) => <AccountSection key={account.agent} account={account} now={now} />)}
      {notices.length > 0 && (
        <ul className="flex flex-col gap-1 text-[12px] text-muted">
          {notices.map(({ agent, message }) => <li key={agent}>{agentLabel(agent)}: {message}</li>)}
        </ul>
      )}
    </div>
  )
}
