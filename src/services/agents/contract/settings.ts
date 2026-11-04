import { defineSettings, everyValue, setting } from '@kernel/settings/contract/define'
import type { AgentHookMode } from './hookModes'
import { isAgentId, type AgentId } from './registry'
import type { AgentConnection, AgentProvider } from './setup'

import type { UsageModelPriceOverride } from './usage/types'

export type AgentPreferences = Partial<Record<AgentId, { connection: AgentConnection; providerId?: string; model?: string }>>

const price = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0

export function isUsageModelPriceOverride(value: unknown): value is UsageModelPriceOverride {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return price(v.inputCostPerMillionTokens) && price(v.outputCostPerMillionTokens)
    && (v.cacheReadCostPerMillionTokens === undefined || price(v.cacheReadCostPerMillionTokens))
    && (v.cacheWriteCostPerMillionTokens === undefined || price(v.cacheWriteCostPerMillionTokens))
}

/** Shared validation for settings edits and provider setup. */
export function isAgentProvider(value: unknown): value is AgentProvider {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  const text = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= 4096 && !/[\x00-\x1f]/.test(s)
  if (!text(v.name) || !text(v.baseUrl) || !['messages', 'responses', 'chat-completions'].includes(String(v.api))) return false
  try {
    const url = new URL(v.baseUrl)
    if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return false
  } catch { return false }
  return Object.keys(v).every((key) => ['name', 'baseUrl', 'api', 'models'].includes(key))
    && Array.isArray(v.models) && v.models.length > 0 && v.models.every((m) => {
      if (!m || typeof m !== 'object' || !text(m.id) || m.name !== undefined && !text(m.name)) return false
      return Object.keys(m).every((key) => ['id', 'name', 'maxInputTokens', 'maxOutputTokens'].includes(key))
        && [m.maxInputTokens, m.maxOutputTokens].every((n) => n === undefined || Number.isSafeInteger(n) && n > 0)
    }) && new Set(v.models.map((m) => m.id)).size === v.models.length
}

export const agentSettings = defineSettings({
  scope: 'workspace',
  keys: {
    agentPreferences: setting<AgentPreferences>({}, everyValue((value, id) => {
      if (!isAgentId(id) || !value || typeof value !== 'object' || Array.isArray(value)) return false
      const v = value as Record<string, unknown>
      return (v.connection === 'native' || v.connection === 'api')
        && (v.providerId === undefined || typeof v.providerId === 'string')
        && (v.model === undefined || typeof v.model === 'string')
        && Object.keys(v).every((key) => ['connection', 'providerId', 'model'].includes(key))
    })),
    agentProviders: setting<Record<string, AgentProvider>>({}, everyValue((value, id) => /^[a-zA-Z0-9_-]{1,80}$/.test(id) && isAgentProvider(value))),
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
