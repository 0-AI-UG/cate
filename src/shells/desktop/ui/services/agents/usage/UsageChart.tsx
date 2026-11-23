// The daily or hourly per-agent chart: layered smooth area series, a 1/2/5
// scale and a hover readout.

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { AgentId } from '@services/agents/contract'
import {
  formatDayShort,
  formatHourShort,
  formatRelativeHourShort,
  formatTokens,
  formatUsd,
  type UsagePeriodTotals,
} from '@services/agents/contract'
import { AGENT_COLORS, AGENT_ORDER, agentLabel } from './presentation'
import { AgentMark } from '../AgentMark'

const VIEW_WIDTH = 960
const VIEW_HEIGHT = 260
const TICK_COUNT = 4
const PLOT_TOP = 8

export type UsageChartMetric = 'tokens' | 'cost'

interface Point { x: number; y: number }
interface Column { bands: Array<{ agent: AgentId; value: number }>; total: number }

function columnsFor(periods: readonly string[], byPeriod: ReadonlyMap<string, UsagePeriodTotals>, metric: UsageChartMetric): Column[] {
  return periods.map((period) => {
    const entry = byPeriod.get(period)
    const bands = AGENT_ORDER.map((agent) => {
      const totals = entry?.byAgent[agent]
      return { agent, value: !totals ? 0 : metric === 'tokens' ? totals.totalTokens : totals.costUsd }
    })
    return { bands, total: bands.reduce((sum, b) => sum + b.value, 0) }
  })
}

/** Shape-preserving cubic tangents that cannot overshoot spiky usage. */
function monotoneTangents(points: readonly Point[]): number[] {
  const n = points.length
  if (n < 2) return [0]
  const slopes: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1].x - points[i].x
    slopes.push(dx === 0 ? 0 : (points[i + 1].y - points[i].y) / dx)
  }
  const t = Array.from({ length: n }, () => 0)
  t[0] = slopes[0]
  t[n - 1] = slopes[n - 2]
  for (let i = 1; i < n - 1; i++) t[i] = slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2
  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) {
      t[i] = 0
      t[i + 1] = 0
      continue
    }
    const a = t[i] / slopes[i]
    const b = t[i + 1] / slopes[i]
    const m = a * a + b * b
    if (m > 9) {
      const s = 3 / Math.sqrt(m)
      t[i] = s * a * slopes[i]
      t[i + 1] = s * b * slopes[i]
    }
  }
  return t
}

function curvePath(points: readonly Point[]): string {
  if (points.length < 2) return ''
  const t = monotoneTangents(points)
  let d = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]
    const to = points[i + 1]
    const dx = to.x - from.x
    d += ` C${(from.x + dx / 3).toFixed(2)},${(from.y + (t[i] * dx) / 3).toFixed(2)} ${(to.x - dx / 3).toFixed(2)},${(to.y - (t[i + 1] * dx) / 3).toFixed(2)} ${to.x.toFixed(2)},${to.y.toFixed(2)}`
  }
  return d
}

/** A scale whose maximum is a 1/2/5 x 10^n step at or above the peak
 *  (rounding down would clip the tallest period). */
export function niceScale(peak: number, count: number): { max: number; ticks: number[] } {
  if (peak <= 0) return { max: 0, ticks: [0] }
  const rawStep = peak / count
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalized = rawStep / magnitude
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude
  const max = Math.ceil(peak / step) * step
  const ticks: number[] = []
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value)
  return { max, ticks }
}

export function UsageChart({ agents, days, daily, hours, hourly, metric, referenceTime, resolution, timeZone }: {
  agents: readonly AgentId[]
  days: readonly string[]
  daily: readonly UsagePeriodTotals[]
  hours: readonly string[]
  hourly: readonly UsagePeriodTotals[]
  metric: UsageChartMetric
  referenceTime: string | undefined
  resolution: 'day' | 'hour'
  timeZone: string
}) {
  const periods = resolution === 'hour' ? hours : days
  const byPeriod = useMemo(
    () => new Map(resolution === 'hour' ? hourly.map((e) => [e.hourStart!, e]) : daily.map((e) => [e.day, e])),
    [daily, hourly, resolution],
  )
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const plotRef = useRef<HTMLDivElement | null>(null)
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const hoverRef = useRef<Point | null>(null)

  const { paths, ticks, stepX, toY, series } = useMemo(() => {
    if (periods.length === 0) return { paths: [], series: [] as Column[], stepX: 0, ticks: [0], toY: () => VIEW_HEIGHT }
    const columns = columnsFor(periods, byPeriod, metric)
    // The scale tops out at the largest single agent-period, not the sum:
    // layered series each measure from zero.
    const peak = columns.reduce((max, c) => c.bands.reduce((inner, b) => Math.max(inner, b.value), max), 0)
    const { max, ticks } = niceScale(peak, TICK_COUNT)
    const step = periods.length === 1 ? 0 : VIEW_WIDTH / (periods.length - 1)
    const toY = (value: number) => max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP)
    const built = agents.map((agent) => {
      const index = AGENT_ORDER.indexOf(agent)
      const line = curvePath(columns.map((c, i) => ({ x: i * step, y: toY(c.bands[index]?.value ?? 0) })))
      return {
        agent,
        total: columns.reduce((sum, c) => sum + (c.bands[index]?.value ?? 0), 0),
        area: line === '' ? '' : `${line} L${VIEW_WIDTH},${VIEW_HEIGHT} L0,${VIEW_HEIGHT} Z`,
        line,
      }
    })
    // The heavier series first so the lighter one is not buried.
    return { paths: built.sort((a, b) => b.total - a.total), series: columns, stepX: step, ticks, toY }
  }, [byPeriod, metric, periods, agents])

  const format = metric === 'tokens' ? formatTokens : formatUsd

  const positionTooltip = useCallback(() => {
    const plot = plotRef.current
    const tooltip = tooltipRef.current
    const hover = hoverRef.current
    if (!plot || !tooltip || !hover) return
    const gap = 12
    const left = hover.x + gap + tooltip.offsetWidth <= plot.clientWidth ? hover.x + gap : hover.x - gap - tooltip.offsetWidth
    const top = hover.y + gap + tooltip.offsetHeight <= plot.clientHeight ? hover.y + gap : hover.y - gap - tooltip.offsetHeight
    plot.style.setProperty('--usage-tooltip-left', `${Math.min(Math.max(0, left), Math.max(0, plot.clientWidth - tooltip.offsetWidth))}px`)
    plot.style.setProperty('--usage-tooltip-top', `${Math.min(Math.max(0, top), Math.max(0, plot.clientHeight - tooltip.offsetHeight))}px`)
  }, [])

  useLayoutEffect(() => {
    if (hoverIndex === null) return
    positionTooltip()
    const plot = plotRef.current
    const tooltip = tooltipRef.current
    if (!plot || !tooltip || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(positionTooltip)
    observer.observe(plot)
    observer.observe(tooltip)
    return () => observer.disconnect()
  }, [hoverIndex, positionTooltip])

  const onMove = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const plot = plotRef.current
    if (!plot || periods.length === 0) return
    const bounds = plot.getBoundingClientRect()
    if (bounds.width === 0) return
    const x = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left))
    const y = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top))
    hoverRef.current = { x, y }
    positionTooltip()
    setHoverIndex(Math.min(periods.length - 1, Math.max(0, Math.round((x / bounds.width) * (periods.length - 1)))))
  }, [periods.length, positionTooltip])

  const hoveredPeriod = hoverIndex === null ? undefined : periods[hoverIndex]
  const hoveredColumn = hoverIndex === null ? undefined : series[hoverIndex]
  const formatPeriod = (period: string) => resolution === 'hour' ? formatHourShort(period, timeZone) : formatDayShort(period)
  const formatTooltipPeriod = (period: string) =>
    resolution === 'hour' && referenceTime !== undefined ? formatRelativeHourShort(period, referenceTime, timeZone) : formatPeriod(period)
  const middle = periods[Math.floor(periods.length / 2)]

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        {/* Axis labels sit outside the plot so they stay aligned to gridlines. */}
        <div className="relative h-56 w-14 shrink-0">
          {ticks.map((tick) => (
            <span key={tick} className="absolute right-0 -translate-y-1/2 text-[10px] tabular-nums text-muted" style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}>
              {tick === 0 ? '0' : format(tick)}
            </span>
          ))}
        </div>
        <div
          ref={plotRef}
          className="relative h-56 flex-1"
          onMouseMove={onMove}
          onMouseLeave={() => {
            hoverRef.current = null
            setHoverIndex(null)
          }}
        >
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${resolution === 'hour' ? 'Hourly' : 'Daily'} ${metric === 'tokens' ? 'processed tokens' : 'cost'} by agent`}
          >
            {ticks.map((tick) => (
              <line key={tick} x1={0} x2={VIEW_WIDTH} y1={toY(tick)} y2={toY(tick)} stroke="var(--border-subtle)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
            {/* Fills first, then every stroke, so no series covers another's line. */}
            {paths.map(({ agent, area }) => <path key={agent} d={area} fill={AGENT_COLORS[agent]} fillOpacity={0.12} />)}
            {paths.map(({ agent, line }) => (
              <path key={agent} d={line} fill="none" stroke={AGENT_COLORS[agent]} strokeWidth={2} vectorEffect="non-scaling-stroke" />
            ))}
            {hoverIndex !== null && (
              <line x1={hoverIndex * stepX} x2={hoverIndex * stepX} y1={PLOT_TOP} y2={VIEW_HEIGHT} stroke="var(--text-muted)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            )}
          </svg>
          {hoveredPeriod !== undefined && (
            <div
              ref={tooltipRef}
              className="pointer-events-none absolute z-10 min-w-36 max-w-full rounded-xl border border-subtle bg-surface-2 px-2.5 py-2 text-[12px] shadow-lg"
              style={{ left: 'var(--usage-tooltip-left, 0px)', top: 'var(--usage-tooltip-top, 0px)' }}
            >
              <div className="mb-1 text-muted">{formatTooltipPeriod(hoveredPeriod)}</div>
              {agents.map((agent) => (
                <div key={agent} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-muted"><AgentMark agent={agent} size={12} />{agentLabel(agent)}</span>
                  <span className="tabular-nums text-primary">{format(hoveredColumn?.bands.find((b) => b.agent === agent)?.value ?? 0)}</span>
                </div>
              ))}
              <div className="mt-1 flex items-center justify-between gap-3 border-t border-subtle pt-1">
                <span className="text-muted">Total</span>
                <span className="tabular-nums text-primary">{format(hoveredColumn?.total ?? 0)}</span>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-between pl-16 text-[10px] uppercase text-muted">
        <span>{periods[0] === undefined ? '' : formatPeriod(periods[0])}</span>
        <span>{middle === undefined ? '' : formatPeriod(middle)}</span>
        <span>{periods.length === 0 ? '' : formatPeriod(periods[periods.length - 1])}</span>
      </div>
    </div>
  )
}
