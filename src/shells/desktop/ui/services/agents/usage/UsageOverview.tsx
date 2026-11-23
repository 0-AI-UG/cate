// The usage overview: the agent CLIs' tokens, API-equivalent cost and
// subscription limits of the shown workspace, as its runtime totals them.

import { useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ChevronDown, CircleAlert, CircleDashed, SlidersHorizontal } from 'lucide-react'
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDateTimeShort,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsd,
  makeUsageWindow,
  type UsagePeriodTotals,
  type UsageSummary,
} from '@services/agents/contract'
import { createUsageReports, type UsageReport } from '@services/agents/client'
import { Menu, MenuItem, MenuSeparator } from './Menu'
import { setUiState, useUiState, type UsageMetric, type UsageWindowDays } from '../../../app/state/uiState'
import { UsageChart } from './UsageChart'
import { UsageLimitsSection } from './UsageLimits'
import { UsagePriceOverrides } from './UsagePriceOverrides'
import { AGENT_COLORS, Metric, RefreshButton, Segmented, Skeleton, agentLabel, agentsWithUsage } from './presentation'
import { AgentMark } from '../AgentMark'

const METRIC_OPTIONS = [
  { value: 'cost', label: 'Cost' },
  { value: 'tokens', label: 'Tokens' },
  { value: 'limits', label: 'Limits' },
] as const satisfies ReadonlyArray<{ value: UsageMetric; label: string }>

const WINDOW_OPTIONS = [
  { value: '1', label: 'Past 24h' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
] as const

const usageWindow = (days: UsageWindowDays) => makeUsageWindow(days, undefined, days === 1 ? 'hour' : 'day')

/** One store for the window: results outlive the overlay, so reopening it is instant. */
const reports = createUsageReports()
const useReportsVersion = () => useSyncExternalStore(reports.subscribe, reports.version)

export function UsageOverview({ workspace, header }: {
  /** The shown workspace, null when none is. */
  workspace: { id: string; label: string } | null
  header: ReactNode
}) {
  const { usageMetric: metric, usageWindowDays: windowDays } = useUiState()
  // The window is fixed when the period is chosen (or refreshed), not per
  // render: its bounds key the query.
  const [selection, setSelection] = useState(() => ({ days: windowDays, window: usageWindow(windowDays) }))
  const current = selection.days === windowDays ? selection : { days: windowDays, window: usageWindow(windowDays) }
  if (current !== selection) setSelection(current)
  const { window } = current
  const showingLimits = metric === 'limits'
  const [refreshing, setRefreshing] = useState(false)
  const refreshingRef = useRef(false)
  const [breakdown, setBreakdown] = useState<'model' | 'time'>('model')
  const isPast24Hours = windowDays === 1

  useReportsVersion()
  const workspaceId = workspace?.id ?? null
  const usage: UsageReport<UsageSummary> = workspaceId ? reports.summary(workspaceId, window) : { isPending: false, error: null, value: null }
  const summary = usage.value
  const limits = workspaceId && showingLimits ? reports.limits(workspaceId) : null

  const days = useMemo(() => enumerateDays(window.sinceDay, window.untilDay), [window.sinceDay, window.untilDay])
  const hours = useMemo(() => window.sinceTime && window.untilTime ? enumerateHourStarts(window.sinceTime, window.untilTime) : [], [window.sinceTime, window.untilTime])
  // Newest first: the window can run 90 periods.
  const periods: readonly UsagePeriodTotals[] = summary ? [...(isPast24Hours ? summary.hourly : summary.daily)].reverse() : []
  const models = !summary ? [] : breakdown === 'model' && metric === 'tokens'
    ? [...summary.models].sort((a, b) => b.totalTokens - a.totalTokens || b.costUsd - a.costUsd)
    : summary.models
  const activeAgents = summary ? agentsWithUsage(summary.agents) : []
  const timeColumnWidth = `${60 / (activeAgents.length + 2)}%`

  const selectWindow = (value: string) => setUiState('usageWindowDays', Number(value) as UsageWindowDays)
  const selectMetric = (next: UsageMetric) => setUiState('usageMetric', next)
  const refresh = () => {
    if (!workspaceId || refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    let work: Promise<void>
    if (showingLimits) {
      work = reports.refreshLimits(workspaceId)
    } else {
      const nextWindow = usageWindow(windowDays)
      if (nextWindow.sinceDay !== window.sinceDay || nextWindow.untilDay !== window.untilDay || nextWindow.sinceTime !== window.sinceTime || nextWindow.untilTime !== window.untilTime) {
        setSelection({ days: windowDays, window: nextWindow })
      }
      work = reports.refreshSummary(workspaceId, nextWindow)
    }
    void work.finally(() => {
      refreshingRef.current = false
      setRefreshing(false)
    })
  }
  const windowLabel = isPast24Hours && window.sinceTime && window.untilTime
    ? `${formatDateTimeShort(window.sinceTime, window.timeZone)} to ${formatDateTimeShort(window.untilTime, window.timeZone)}`
    : `${formatDayShort(window.sinceDay)} to ${formatDayShort(window.untilDay)}`

  return (
    <section aria-label="Usage overview" className="flex min-h-0 flex-1 flex-col bg-canvas-bg text-primary">
      {header}
      <div className="flex h-11 shrink-0 items-center gap-3 px-6 text-[13px] leading-5">
        <nav aria-label="Usage breadcrumb" className="min-w-0">
          {workspace && <WorkspaceMenu workspace={workspace} usage={usage} showUsageStatus={!showingLimits} />}
        </nav>
        {!showingLimits && <span className="hidden min-w-0 truncate text-[12px] text-muted 2xl:block">{windowLabel}</span>}
        <div className="ml-auto flex min-w-0 items-center justify-end gap-2">
          <Segmented label="Usage metric" value={metric} options={METRIC_OPTIONS} onChange={selectMetric} />
          {/* The period does not apply to Limits; it stays in place, disabled. */}
          <Segmented label="Usage period" value={String(windowDays) as `${UsageWindowDays}`} options={WINDOW_OPTIONS} disabled={showingLimits} onChange={selectWindow} />
          <RefreshButton label={showingLimits ? 'Refresh limits' : 'Refresh usage'} refreshing={refreshing} onClick={refresh} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 pb-10 pt-4">
          {!workspace ? (
            <p className="text-[13px] text-muted">Open a workspace to see {showingLimits ? 'limits' : 'usage'}.</p>
          ) : showingLimits ? (
            limits && <UsageLimitsSection report={limits} />
          ) : !summary ? (
            usage.error !== null ? <p className="text-[13px] text-danger">{usage.error}</p> : <UsageSkeleton />
          ) : (
            <>
              <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
                <div className="flex min-w-0 flex-col gap-5">
                  <div className="flex flex-col gap-1">
                    <span className="text-[32px] font-semibold leading-10 tabular-nums text-primary">{metric === 'cost' ? formatUsd(summary.costUsd) : formatTokens(summary.totalTokens)}</span>
                    <span className="text-[12px] text-muted">{formatCount(summary.sessions)} sessions{metric === 'cost' ? ' · API estimate' : ''}</span>
                  </div>
                  {activeAgents.map((agent) => {
                    const totals = summary.agents.find((a) => a.agent === agent)
                    const share = metric === 'cost' ? totals?.costShare ?? 0 : totals?.tokenShare ?? 0
                    const sessions = totals?.sessions ?? 0
                    return (
                      <div key={agent} className="flex flex-col gap-1">
                        <div className="flex items-baseline justify-between gap-4">
                          <span className="flex min-w-0 items-center gap-2 text-[13px] text-primary">
                            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: AGENT_COLORS[agent] }} />
                            <AgentMark agent={agent} size={16} />
                            <span className="flex min-w-0 items-baseline gap-1.5">
                              <span className="truncate">{agentLabel(agent)}</span>
                              <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted">{formatCount(sessions)} {sessions === 1 ? 'session' : 'sessions'}</span>
                            </span>
                          </span>
                          <span className="shrink-0 text-[13px] font-medium tabular-nums text-primary">{metric === 'cost' ? formatUsd(totals?.costUsd ?? 0) : formatTokens(totals?.totalTokens ?? 0)}</span>
                        </div>
                        <span className="text-[12px] text-muted">
                          {metric === 'cost'
                            ? `${formatPercent(share)} of cost · ${formatTokens(totals?.totalTokens ?? 0)} tokens`
                            : `${formatPercent(share)} of tokens · ${formatUsd(totals?.costUsd ?? 0)}`}
                        </span>
                      </div>
                    )
                  })}
                </div>
                <div className="flex min-w-0 flex-col gap-3">
                  <h2 className="text-[14px] font-medium text-primary">{isPast24Hours ? 'Hourly' : 'Daily'} {metric === 'tokens' ? 'processed tokens' : 'cost'}</h2>
                  <UsageChart
                    agents={activeAgents}
                    days={days}
                    daily={summary.daily}
                    hours={hours}
                    hourly={summary.hourly}
                    metric={metric}
                    referenceTime={window.untilTime}
                    resolution={isPast24Hours ? 'hour' : 'day'}
                    timeZone={window.timeZone}
                  />
                </div>
              </section>

              <section className="flex flex-col gap-2">
                <h2 className="text-[14px] font-medium text-primary">Totals</h2>
                <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
                  <Metric label="Processed tokens" value={formatTokens(summary.totalTokens)} />
                  <Metric label="Cached input" value={formatTokens(summary.cachedInputTokens)} />
                  <Metric label="Uncached input" value={formatTokens(summary.uncachedInputTokens)} />
                  <Metric label="Output" value={formatTokens(summary.outputTokens)} />
                  <Metric label="Cache savings" value={formatUsd(summary.cacheSavingsUsd)} />
                </div>
              </section>

              <section className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-[14px] font-medium text-primary">Breakdown</h2>
                  <Segmented
                    label="Usage breakdown"
                    value={breakdown}
                    options={[{ value: 'model', label: 'Model' }, { value: 'time', label: isPast24Hours ? 'Hour' : 'Day' }] as const}
                    onChange={setBreakdown}
                  />
                </div>
                {breakdown === 'model' ? (
                  <table className="w-full table-fixed text-[13px]">
                    <colgroup><col className="w-2/5" /><col className="w-1/5" /><col className="w-1/5" /><col className="w-1/5" /></colgroup>
                    <thead>
                      <tr className="border-b border-subtle text-left text-[12px] text-muted">
                        <th className="py-2 font-normal">Model</th>
                        <th className="py-2 text-right font-normal">Cost</th>
                        <th className="py-2 text-right font-normal">Share</th>
                        <th className="py-2 text-right font-normal">Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {models.length === 0 ? (
                        <tr><td colSpan={4} className="py-6 text-center text-muted">No activity in this window.</td></tr>
                      ) : models.map((model) => (
                        <tr key={`${model.agent}:${model.model}`} className="border-b border-subtle transition-colors hover:bg-hover">
                          <td className="py-2 text-primary"><span className="flex items-center gap-2"><AgentMark agent={model.agent} size={14} />{model.model}</span></td>
                          <td className="py-2 text-right tabular-nums text-primary">{formatUsd(model.costUsd)}</td>
                          <td className="py-2 text-right tabular-nums text-muted">{formatPercent(model.costShare)}</td>
                          <td className="py-2 text-right tabular-nums text-muted">{formatTokens(model.totalTokens)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <table className="w-full table-fixed text-[13px]">
                    <colgroup>
                      <col className="w-2/5" />
                      {activeAgents.map((agent) => <col key={agent} style={{ width: timeColumnWidth }} />)}
                      <col style={{ width: timeColumnWidth }} />
                      <col style={{ width: timeColumnWidth }} />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-subtle text-left text-[12px] text-muted">
                        <th className="py-2 font-normal">{isPast24Hours ? 'Hour' : 'Day'}</th>
                        {activeAgents.map((agent) => <th key={agent} className="py-2 text-right font-normal">{agentLabel(agent)}</th>)}
                        <th className="py-2 text-right font-normal">Total</th>
                        <th className="py-2 text-right font-normal">Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {periods.length === 0 ? (
                        <tr><td colSpan={activeAgents.length + 3} className="py-6 text-center text-muted">No activity in this window.</td></tr>
                      ) : periods.map((period) => (
                        <tr key={period.hourStart ?? period.day} className="border-b border-subtle transition-colors hover:bg-hover">
                          <td className="py-2 text-primary">{period.hourStart ? formatHourShort(period.hourStart, window.timeZone) : formatDayShort(period.day)}</td>
                          {activeAgents.map((agent) => <td key={agent} className="py-2 text-right tabular-nums text-muted">{formatUsd(period.byAgent[agent]?.costUsd ?? 0)}</td>)}
                          <td className="py-2 text-right tabular-nums text-primary">{formatUsd(period.costUsd)}</td>
                          <td className="py-2 text-right tabular-nums text-muted">{formatTokens(period.totalTokens)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

/** The workspace and its scan progress in one header control; a failure and
 *  agents without token counts are explained inside it so the page does not
 *  move. */
function WorkspaceMenu({ workspace, usage, showUsageStatus }: {
  workspace: { id: string; label: string }
  usage: UsageReport<UsageSummary>
  showUsageStatus: boolean
}) {
  const [pricesOpen, setPricesOpen] = useState(false)
  const scanning = usage.error === null && (usage.isPending || usage.value === null)
  const failed = usage.error !== null
  const coverage = [...(failed ? [`${workspace.label} could not report usage.`] : []), ...(usage.value?.notes ?? [])]

  return (
    <>
      <Menu
        triggerClassName="group inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left text-[13px] text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus-blue"
        trigger={(open) => (
          <>
            <span className="min-w-0 truncate">{workspace.label}</span>
            <span className="flex size-3.5 shrink-0 items-center justify-center text-muted">
              {showUsageStatus && scanning ? (
                <>
                  <CircleDashed size={14} aria-hidden />
                  <span className="sr-only">Still scanning</span>
                </>
              ) : showUsageStatus && failed ? (
                <CircleAlert size={14} className="text-[var(--activity-orange)]" aria-label="This workspace could not report usage" />
              ) : (
                <ChevronDown size={14} aria-hidden className={`transition-opacity ${open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'}`} />
              )}
            </span>
          </>
        )}
      >
        {showUsageStatus && coverage.length > 0 && (
          <>
            <div className="flex flex-col gap-1 px-2 py-2 text-[12px] text-muted">
              {coverage.map((line) => <span key={line}>{line}</span>)}
            </div>
            <MenuSeparator />
          </>
        )}
        <MenuItem icon={<SlidersHorizontal size={14} aria-hidden />} onClick={() => setPricesOpen(true)}>Model prices</MenuItem>
      </Menu>
      {pricesOpen && <UsagePriceOverrides workspace={workspace} models={usage.value?.models.map((m) => m.model) ?? []} onClose={() => setPricesOpen(false)} />}
    </>
  )
}

/** A stand-in with the loaded page's shape. */
function UsageSkeleton() {
  return (
    <>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <Skeleton className="h-10 w-36" />
            <Skeleton className="h-4 w-32" />
          </div>
          {[0, 1].map((key) => (
            <div key={key} className="flex flex-col gap-1">
              <div className="flex min-h-5 items-center justify-between gap-4">
                <span className="flex items-center gap-2">
                  <Skeleton className="size-2 shrink-0 rounded-full" />
                  <Skeleton className="size-4 shrink-0 rounded-full" />
                  <Skeleton className="h-3.5 w-20" />
                </span>
                <Skeleton className="h-3.5 w-14" />
              </div>
              <Skeleton className="h-4 w-36" />
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-24" />
          <div className="flex flex-col gap-1">
            <Skeleton className="ml-16 h-56" />
            <Skeleton className="ml-16 h-4" />
          </div>
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-[14px] font-medium text-primary">Totals</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
          {['Processed tokens', 'Cached input', 'Uncached input', 'Output', 'Cache savings'].map((label) => (
            <div key={label} className="flex flex-col gap-0.5">
              <span className="text-[12px] text-muted">{label}</span>
              <Skeleton className="h-6 w-16" />
            </div>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[14px] font-medium text-primary">Breakdown</h2>
          <Skeleton className="h-7 w-28 rounded-lg" />
        </div>
        <Skeleton className="h-44" />
      </section>
    </>
  )
}
