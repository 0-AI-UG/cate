// Folds usage records into `(day, hourStart?, agent, model)` buckets. Pure, so
// bucketing, windows and de-duplication are testable without a filesystem.

import type { AgentId, UsageBucket, UsageResolution, UsageTokenTotals } from '../../contract'
import type { AgentUsageRecord } from '../sessions/types'
import { addTotals, EMPTY_TOTALS } from './records'
import { cacheSavingsUsd, priceUsage, type RateTable } from './pricing'

const HOUR_MS = 60 * 60 * 1000

/** An instant as `YYYY-MM-DD` in `timeZone` (`en-CA` gives ISO order); an
 *  unknown zone falls back to UTC. */
export function makeDayFormatter(timeZone: string): (timestampMs: number) => string {
  const options = { year: 'numeric', month: '2-digit', day: '2-digit' } as const
  let format: Intl.DateTimeFormat
  try {
    format = new Intl.DateTimeFormat('en-CA', { ...options, timeZone })
  } catch {
    format = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: 'UTC' })
  }
  return (timestampMs) => format.format(new Date(timestampMs))
}

interface MutableBucket {
  totals: UsageTokenTotals
  costUsd: number
  cacheSavingsUsd: number
  records: number
  unpricedRecords: number
  reportedRecords: number
}

export interface AggregateOptions {
  timeZone: string
  sinceDay: string
  untilDay: string
  rates: RateTable
  priceOverrides?: RateTable
  resolution?: UsageResolution
  sinceTimeMs?: number
  untilTimeMs?: number
}

/** Accumulates records across every store. De-duplication is global: Claude
 *  Code copies a response's records into the files of resumed sessions. */
export class UsageAggregator {
  private readonly buckets = new Map<string, MutableBucket>()
  private readonly seen = new Set<string>()
  private readonly toDay: (timestampMs: number) => string
  private readonly hourly: { sinceTimeMs: number; untilTimeMs: number } | null

  constructor(private readonly options: AggregateOptions) {
    this.toDay = makeDayFormatter(options.timeZone)
    if (options.resolution === 'hour') {
      if (options.sinceTimeMs === undefined || options.untilTimeMs === undefined) throw new Error('Hourly usage aggregation requires exact time bounds')
      this.hourly = { sinceTimeMs: options.sinceTimeMs, untilTimeMs: options.untilTimeMs }
    } else {
      this.hourly = null
    }
  }

  /** Folds one record in; true when it landed in the window. */
  add(agent: AgentId, record: AgentUsageRecord): boolean {
    if (record.dedupeKey !== null) {
      const key = `${agent}\u0000${record.dedupeKey}`
      if (this.seen.has(key)) return false
      this.seen.add(key)
    }
    if (this.hourly && (record.timestampMs < this.hourly.sinceTimeMs || record.timestampMs >= this.hourly.untilTimeMs)) return false
    const day = this.toDay(record.timestampMs)
    if (!this.hourly && (day < this.options.sinceDay || day > this.options.untilDay)) return false

    const hourStart = this.hourly
      ? new Date(this.hourly.sinceTimeMs + Math.floor((record.timestampMs - this.hourly.sinceTimeMs) / HOUR_MS) * HOUR_MS).toISOString()
      : ''
    const key = `${day}\u0000${hourStart}\u0000${agent}\u0000${record.model}`
    let bucket = this.buckets.get(key)
    if (!bucket) this.buckets.set(key, (bucket = { totals: EMPTY_TOTALS, costUsd: 0, cacheSavingsUsd: 0, records: 0, unpricedRecords: 0, reportedRecords: 0 }))
    const { rates, priceOverrides } = this.options
    const priced = priceUsage(rates, record.model, record.totals, record.reportedCostUsd, priceOverrides)
    bucket.totals = addTotals(bucket.totals, record.totals)
    bucket.costUsd += priced.costUsd
    bucket.cacheSavingsUsd += cacheSavingsUsd(rates, record.model, record.totals, priceOverrides)
    bucket.records++
    if (priced.costSource === 'unpriced') bucket.unpricedRecords++
    if (priced.costSource === 'providerReported') bucket.reportedRecords++
    return true
  }

  finish(): UsageBucket[] {
    return [...this.buckets].map(([key, b]): UsageBucket => {
      const [day, hourStart, agent, model] = key.split('\u0000')
      return {
        day,
        ...(hourStart === '' ? {} : { hourStart }),
        agent: agent as AgentId,
        model,
        totals: b.totals,
        costUsd: b.costUsd,
        cacheSavingsUsd: b.cacheSavingsUsd,
        // The weakest provenance in the bucket wins, never overstating confidence.
        costSource: b.unpricedRecords === b.records ? 'unpriced' : b.reportedRecords === b.records ? 'providerReported' : 'modelPriced',
        records: b.records,
        unpricedRecords: b.unpricedRecords,
      }
    }).sort((a, b) =>
      a.day.localeCompare(b.day) || (a.hourStart ?? '').localeCompare(b.hourStart ?? '') || a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model))
  }
}
