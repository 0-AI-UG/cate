import { defineSettings, everyValue, setting } from '@kernel/settings/contract/define'
import type { AgentHookMode } from './hookModes'
import type { AgentId } from './registry'
import type { UsageModelPriceOverride } from './usage/types'

const price = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0

export function isUsageModelPriceOverride(value: unknown): value is UsageModelPriceOverride {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return price(v.inputCostPerMillionTokens) && price(v.outputCostPerMillionTokens)
    && (v.cacheReadCostPerMillionTokens === undefined || price(v.cacheReadCostPerMillionTokens))
    && (v.cacheWriteCostPerMillionTokens === undefined || price(v.cacheWriteCostPerMillionTokens))
}

export const agentSettings = defineSettings({
  scope: 'workspace',
  keys: {
    /** Per-agent override of repo-local hook injection. A missing agent is
     *  'auto': inject only when its config folder already exists. */
    agentHookInjection: setting<Partial<Record<AgentId, AgentHookMode>>>(
      {},
      everyValue((mode) => mode === 'auto' || mode === 'on' || mode === 'off'),
    ),
    /** Custom model prices for this workspace's usage, by model id as the
     *  agent records it; they replace the LiteLLM rate and any recorded cost. */
    usagePriceOverrides: setting<Record<string, UsageModelPriceOverride>>(
      {},
      everyValue((value, model) => model.trim().length > 0 && isUsageModelPriceOverride(value)),
    ),
  },
})
