// Model rates and cost arithmetic. Rates come from LiteLLM's
// `model_prices_and_context_window.json`, the table ccusage prices against;
// fetching and caching it lives in the usage service.

import type { UsageCostSource, UsageModelPriceOverride, UsageTokenTotals } from '../../contract'

/** USD per token, base tier only: transcripts don't record which tier
 *  (`_above_272k`, `_flex`, `_priority`) served a request. */
export interface ModelRate {
  inputCostPerToken: number
  outputCostPerToken: number
  cacheReadCostPerToken: number
  cacheCreationCostPerToken: number
}

export type RateTable = ReadonlyMap<string, ModelRate>

/** Custom ids keep their case, provider prefix and variant suffix. */
export function createOverrideRateTable(overrides: Readonly<Record<string, UsageModelPriceOverride>>): RateTable {
  return new Map(Object.entries(overrides).map(([model, p]) => [model.trim(), {
    inputCostPerToken: p.inputCostPerMillionTokens / 1_000_000,
    outputCostPerToken: p.outputCostPerMillionTokens / 1_000_000,
    cacheReadCostPerToken: (p.cacheReadCostPerMillionTokens ?? p.inputCostPerMillionTokens) / 1_000_000,
    cacheCreationCostPerToken: (p.cacheWriteCostPerMillionTokens ?? p.inputCostPerMillionTokens) / 1_000_000,
  }]))
}

const finiteNumber = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const normalizeRateKey = (model: string) => model.trim().toLowerCase()
const bareModelName = (key: string) => key.slice(key.lastIndexOf('/') + 1)

const sameRate = (a: ModelRate, b: ModelRate) =>
  a.inputCostPerToken === b.inputCostPerToken && a.outputCostPerToken === b.outputCostPerToken
  && a.cacheReadCostPerToken === b.cacheReadCostPerToken && a.cacheCreationCostPerToken === b.cacheCreationCostPerToken

/** The LiteLLM document as a rate table. Entries without both an input and an
 *  output rate are dropped (half-priced would under-report). A bare name
 *  (`gpt-5` for `openai/gpt-5`) is aliased only when no canonical entry
 *  exists and every qualified entry agrees on the rate. */
export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>()
  if (typeof document !== 'object' || document === null) return table
  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Record<string, unknown>
    const input = finiteNumber(entry.input_cost_per_token)
    const output = finiteNumber(entry.output_cost_per_token)
    const key = normalizeRateKey(name)
    if (input === null || output === null || key.length === 0) continue
    table.set(key, {
      inputCostPerToken: input,
      outputCostPerToken: output,
      // Without cache rates cached input is priced as plain input, not as free.
      cacheReadCostPerToken: finiteNumber(entry.cache_read_input_token_cost) ?? input,
      cacheCreationCostPerToken: finiteNumber(entry.cache_creation_input_token_cost) ?? input,
    })
  }
  // null marks a bare name claimed at conflicting rates.
  const aliases = new Map<string, ModelRate | null>()
  for (const [key, rate] of table) {
    const alias = bareModelName(key)
    if (alias.length === 0 || alias === key || table.has(alias)) continue
    const held = aliases.get(alias)
    if (held === undefined) aliases.set(alias, rate)
    else if (held !== null && !sameRate(held, rate)) aliases.set(alias, null)
  }
  for (const [alias, rate] of aliases) if (rate) table.set(alias, rate)
  return table
}

/** Drops a bracketed variant suffix such as `claude-fable-5-1[1m]`. */
function stripVariantSuffix(key: string): string {
  const bracket = key.indexOf('[')
  return bracket === -1 ? key : key.slice(0, bracket)
}

/** Never priced: `<synthetic>` messages were never billed, and bare family
 *  names are ambiguous across generations. */
const UNPRICEABLE_MODELS = new Set(['<synthetic>', 'synthetic', 'opus', 'sonnet', 'haiku', 'fable'])

export function lookupRate(table: RateTable, model: string): ModelRate | null {
  const key = stripVariantSuffix(normalizeRateKey(model))
  const bare = bareModelName(key)
  if (bare.length === 0 || UNPRICEABLE_MODELS.has(bare)) return null
  return table.get(key) ?? table.get(bare) ?? null
}

export interface PricedUsage {
  costUsd: number
  costSource: UsageCostSource
}

/** A custom price wins, then a cost the store reported, then the rate table.
 *  `reasoningTokens` is inside `outputTokens` and not charged again. */
export function priceUsage(table: RateTable, model: string, totals: UsageTokenTotals, reportedCostUsd: number | null, overrides?: RateTable): PricedUsage {
  const override = overrides?.get(model.trim())
  if (override === undefined && reportedCostUsd !== null && Number.isFinite(reportedCostUsd)) return { costUsd: reportedCostUsd, costSource: 'providerReported' }
  const rate = override ?? lookupRate(table, model)
  if (!rate) return { costUsd: 0, costSource: 'unpriced' }
  return {
    costUsd: totals.uncachedInputTokens * rate.inputCostPerToken
      + totals.cachedInputTokens * rate.cacheReadCostPerToken
      + totals.cacheCreationTokens * rate.cacheCreationCostPerToken
      + totals.outputTokens * rate.outputCostPerToken,
    costSource: 'modelPriced',
  }
}

/** What the cached input would have cost at full input rates, minus what it cost. */
export function cacheSavingsUsd(table: RateTable, model: string, totals: UsageTokenTotals, overrides?: RateTable): number {
  const rate = overrides?.get(model.trim()) ?? lookupRate(table, model)
  return rate ? totals.cachedInputTokens * (rate.inputCostPerToken - rate.cacheReadCostPerToken) : 0
}
