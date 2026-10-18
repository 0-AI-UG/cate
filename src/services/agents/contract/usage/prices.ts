// The custom model prices table of a workspace: one row per model. Only
// edited cells change rates.

import type { UsageModelPriceOverride } from './types'

export const USAGE_PRICE_FIELDS = [
  { key: 'inputCostPerMillionTokens', label: 'Input', optional: false },
  { key: 'outputCostPerMillionTokens', label: 'Output', optional: false },
  { key: 'cacheReadCostPerMillionTokens', label: 'Cache read', optional: true },
  { key: 'cacheWriteCostPerMillionTokens', label: 'Cache write', optional: true },
] as const

export type UsagePriceField = (typeof USAGE_PRICE_FIELDS)[number]['key']
export type UsagePriceForm = { model: string } & Record<UsagePriceField, string>

export type UsagePrices = Readonly<Record<string, UsageModelPriceOverride>>

export interface UsagePriceDraft {
  id: string
  model: string
  isNew: boolean
  values: Partial<Record<UsagePriceField, string>>
  removed?: boolean
}

export interface UsagePriceChange {
  model: string
  price: UsageModelPriceOverride | null
}

export function usagePriceForm(model = '', price?: UsageModelPriceOverride): UsagePriceForm {
  return {
    model,
    inputCostPerMillionTokens: price?.inputCostPerMillionTokens.toString() ?? '',
    outputCostPerMillionTokens: price?.outputCostPerMillionTokens.toString() ?? '',
    cacheReadCostPerMillionTokens: price?.cacheReadCostPerMillionTokens?.toString() ?? '',
    cacheWriteCostPerMillionTokens: price?.cacheWriteCostPerMillionTokens?.toString() ?? '',
  }
}

/** Blank cache prices use the input rate; an explicit zero means free. */
export function parseUsagePriceForm(form: UsagePriceForm): { model: string; price: UsageModelPriceOverride } | null {
  const model = form.model.trim()
  if (model.length === 0) return null
  const rates: Partial<Record<UsagePriceField, number>> = {}
  for (const field of USAGE_PRICE_FIELDS) {
    const raw = form[field.key].trim()
    if (raw === '') {
      if (field.optional) continue
      return null
    }
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return null
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) return null
    rates[field.key] = value
  }
  if (rates.inputCostPerMillionTokens === undefined || rates.outputCostPerMillionTokens === undefined) return null
  return {
    model,
    price: {
      inputCostPerMillionTokens: rates.inputCostPerMillionTokens,
      outputCostPerMillionTokens: rates.outputCostPerMillionTokens,
      ...(rates.cacheReadCostPerMillionTokens === undefined ? {} : { cacheReadCostPerMillionTokens: rates.cacheReadCostPerMillionTokens }),
      ...(rates.cacheWriteCostPerMillionTokens === undefined ? {} : { cacheWriteCostPerMillionTokens: rates.cacheWriteCostPerMillionTokens }),
    },
  }
}

export function isEmptyUsagePriceDraft(draft: UsagePriceDraft): boolean {
  return draft.isNew && draft.model.trim() === '' && Object.values(draft.values).every((value) => value.trim() === '')
}

const modelPrice = (prices: UsagePrices, model: string) =>
  Object.hasOwn(prices, model) ? prices[model] : undefined

/** A cell's value, and its placeholder; null prices could not be read. */
export function usagePriceCell(prices: UsagePrices | null, model: string, field: UsagePriceField): { value: string; placeholder: string } {
  const optional = USAGE_PRICE_FIELDS.find((entry) => entry.key === field)!.optional
  if (prices === null) return { value: '', placeholder: 'Unavailable' }
  const price = modelPrice(prices, model)
  if (!price) return { value: '', placeholder: 'Automatic' }
  return { value: usagePriceForm(model, price)[field], placeholder: optional ? 'Input rate' : '0.00' }
}

/** The changes drafts make to the prices, and the errors that block them. */
export function usagePriceTableChanges(prices: UsagePrices, drafts: readonly UsagePriceDraft[]): { changes: UsagePriceChange[]; errors: Map<string, string> } {
  const changes: UsagePriceChange[] = []
  const errors = new Map<string, string>()
  for (const draft of drafts) {
    if (isEmptyUsagePriceDraft(draft)) continue
    const model = draft.model.trim()
    if (draft.removed) {
      if (modelPrice(prices, model)) changes.push({ model, price: null })
      continue
    }
    const original = usagePriceForm(model, modelPrice(prices, model))
    const form = { ...original, ...draft.values }
    const parsed = parseUsagePriceForm(form)
    if (!parsed) {
      const missing = USAGE_PRICE_FIELDS.find((field) => !field.optional && form[field.key].trim() === '')
      errors.set(draft.id, model === '' ? 'Enter a model ID.' : missing ? `${missing.label} is required.` : 'Use non-negative numbers for prices.')
      continue
    }
    const next = usagePriceForm(model, parsed.price)
    if (USAGE_PRICE_FIELDS.some((field) => original[field.key] !== next[field.key])) changes.push(parsed)
  }
  return { changes, errors }
}

/** Applies changes to the prices: a null price returns the model to automatic pricing. */
export function applyUsagePriceChanges(prices: UsagePrices, changes: readonly UsagePriceChange[]): Record<string, UsageModelPriceOverride> {
  const next = { ...prices }
  for (const { model, price } of changes) {
    if (price) next[model] = price
    else delete next[model]
  }
  return next
}
