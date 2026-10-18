// Display formatting and window arithmetic for the usage overview.

import type { UsageResolution, UsageSummaryInput } from './types'

const CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const INTEGER = new Intl.NumberFormat('en-US')
const HOUR_MS = 60 * 60 * 1000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function formatUsd(value: number): string {
  return CURRENCY.format(value)
}

export function formatCount(value: number): string {
  return INTEGER.format(Math.round(value))
}

/** Three significant figures with a unit suffix (`19.9B`, `76.7M`, `804K`). */
export function formatTokens(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e12) return `${trim(value / 1e12)}T`
  if (abs >= 1e9) return `${trim(value / 1e9)}B`
  if (abs >= 1e6) return `${trim(value / 1e6)}M`
  if (abs >= 1e3) return `${trim(value / 1e3)}K`
  return INTEGER.format(Math.round(value))
}

function trim(value: number): string {
  const abs = Math.abs(value)
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2
  return value.toFixed(digits).replace(/\.0+$/, '')
}

export function formatPercent(share: number, digits = 1): string {
  return `${(share * 100).toFixed(digits)}%`
}

/** `2026-08-07` to `Aug 7`. */
export function formatDayShort(day: string): string {
  const [year, month, dayOfMonth] = day.split('-').map(Number)
  if (!year || !month || !dayOfMonth) return day
  return `${MONTHS[month - 1] ?? ''} ${dayOfMonth}`
}

/** Inclusive day list between two `YYYY-MM-DD` bounds. */
export function enumerateDays(sinceDay: string, untilDay: string): string[] {
  const days: string[] = []
  const start = Date.parse(`${sinceDay}T00:00:00Z`)
  const end = Date.parse(`${untilDay}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return days
  for (let cursor = start; cursor <= end; cursor += 86_400_000) days.push(new Date(cursor).toISOString().slice(0, 10))
  return days
}

/** Every hour-bucket start in an hourly rolling window. */
export function enumerateHourStarts(sinceTime: string, untilTime: string): string[] {
  const starts: string[] = []
  const start = Date.parse(sinceTime)
  const end = Date.parse(untilTime)
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return starts
  for (let cursor = start; cursor < end; cursor += HOUR_MS) starts.push(new Date(cursor).toISOString())
  return starts
}

/** A bucket start in the viewer's zone; a wall-clock hour repeated by a
 *  fall-back transition carries its zone name to stay distinguishable. */
export function formatHourShort(hourStart: string, timeZone?: string): string {
  const instant = new Date(hourStart)
  if (Number.isNaN(instant.getTime())) return hourStart
  const zone = timeZone === undefined ? {} : { timeZone }
  const wallHourFormat = new Intl.DateTimeFormat('en-CA', { ...zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
  const wallHour = wallHourFormat.format(instant)
  const repeated = [-HOUR_MS, HOUR_MS].some((offset) => wallHourFormat.format(new Date(instant.getTime() + offset)) === wallHour)
  return new Intl.DateTimeFormat('en-US', { ...zone, hour: 'numeric', ...(repeated ? { timeZoneName: 'short' } : {}) }).format(instant)
}

/** `Aug 11, 2 PM` in the zone. */
export function formatDateTimeShort(instant: string, timeZone?: string): string {
  const date = new Date(instant)
  if (Number.isNaN(date.getTime())) return instant
  return new Intl.DateTimeFormat('en-US', { ...(timeZone === undefined ? {} : { timeZone }), month: 'short', day: 'numeric', hour: 'numeric' }).format(date)
}

/** An hourly tooltip label relative to the window's end (`2 PM today`). */
export function formatRelativeHourShort(hourStart: string, relativeTo: string, timeZone?: string): string {
  const instant = new Date(hourStart)
  const reference = new Date(relativeTo)
  if (Number.isNaN(instant.getTime()) || Number.isNaN(reference.getTime())) return formatDateTimeShort(hourStart, timeZone)
  const dayFormat = new Intl.DateTimeFormat('en-CA', { ...(timeZone === undefined ? {} : { timeZone }), year: 'numeric', month: '2-digit', day: '2-digit' })
  const daysAgo = Math.round((Date.parse(`${dayFormat.format(reference)}T00:00:00Z`) - Date.parse(`${dayFormat.format(instant)}T00:00:00Z`)) / (24 * HOUR_MS))
  const hour = formatHourShort(hourStart, timeZone)
  if (daysAgo === 0) return `${hour} today`
  if (daysAgo === 1) return `${hour} yesterday`
  return formatDateTimeShort(hourStart, timeZone)
}

function dayFormatter(): { timeZone: string; format: Intl.DateTimeFormat } {
  const options = { year: 'numeric', month: '2-digit', day: '2-digit' } as const
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  try {
    return { timeZone, format: new Intl.DateTimeFormat('en-CA', { ...options, timeZone }) }
  } catch {
    return { timeZone: 'UTC', format: new Intl.DateTimeFormat('en-CA', { ...options, timeZone: 'UTC' }) }
  }
}

/** The window the overview requests, in the viewer's own zone so days line up
 *  with what they experienced. Hourly windows are an exact rolling 24 hours;
 *  daily ones are calendar arithmetic (fixed milliseconds would land on the
 *  wrong day around a DST change). */
export function makeUsageWindow(days: number, now = new Date(), resolution: UsageResolution = 'day'): UsageSummaryInput {
  const { timeZone, format } = dayFormatter()
  const untilDay = format.format(now)
  if (resolution === 'hour') {
    const untilTimeMs = Math.floor(now.getTime() / 60_000) * 60_000
    const sinceTime = new Date(untilTimeMs - 24 * HOUR_MS)
    const untilTime = new Date(untilTimeMs)
    return { sinceDay: format.format(sinceTime), untilDay: format.format(untilTime), timeZone, resolution, sinceTime: sinceTime.toISOString(), untilTime: untilTime.toISOString() }
  }
  const [year = 0, month = 1, dayOfMonth = 1] = untilDay.split('-').map((part) => Number.parseInt(part, 10))
  const start = new Date(Date.UTC(year, month - 1, dayOfMonth - (days - 1)))
  return { sinceDay: start.toISOString().slice(0, 10), untilDay, timeZone, resolution }
}
