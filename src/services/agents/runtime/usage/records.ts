// Token arithmetic the agent session stores share when they read usage.

import type { UsageTokenTotals } from '../../contract'

export const EMPTY_TOTALS: UsageTokenTotals = { uncachedInputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 }

/** A positive integer count, 0 for anything else. */
export function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

export function addTotals(a: UsageTokenTotals, b: UsageTokenTotals): UsageTokenTotals {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  }
}

export function totalTokens(totals: UsageTokenTotals): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens + totals.outputTokens
}

/** Totals for a CLI that reports input inclusive of its cached part. */
export function totalsFromInclusiveInput(input: number, cached: number, cacheCreation: number, output: number, reasoning: number): UsageTokenTotals {
  return {
    uncachedInputTokens: Math.max(0, input - cached - cacheCreation),
    cachedInputTokens: cached,
    cacheCreationTokens: cacheCreation,
    outputTokens: output,
    reasoningTokens: Math.min(output, reasoning),
  }
}

/** A cost the CLI recorded, when it is a real figure: several CLIs write 0
 *  for subscription models, which the rate table prices instead. */
export function recordedCost(...values: unknown[]): number | null {
  for (const value of values) if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  return null
}

export function parseJsonLine(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

export function isoInstant(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return new Date(value < 1e12 ? value * 1000 : value).toISOString()
  if (typeof value === 'string' && value) {
    const at = Date.parse(value)
    return Number.isNaN(at) ? undefined : new Date(at).toISOString()
  }
  return undefined
}
