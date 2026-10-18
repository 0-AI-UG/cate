// Totals a workspace's usage buckets into the summary the overview draws:
// per agent, per model and per period, with each one's share.

import type { AgentId, UsageAgentStatus, UsageBucket, UsageSummary } from '../../contract'

type Totals = Omit<UsageSummary, 'readAt' | 'timeZone' | 'sinceDay' | 'untilDay' | 'stores' | 'pricing' | 'scanDurationMs'>

function bucketTokens(bucket: UsageBucket): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return bucket.totals.uncachedInputTokens + bucket.totals.cachedInputTokens + bucket.totals.cacheCreationTokens + bucket.totals.outputTokens
}

type MutablePeriod = { day: string; hourStart?: string; costUsd: number; totalTokens: number; byAgent: Partial<Record<AgentId, { costUsd: number; totalTokens: number }>> }

function addToPeriod(periods: Map<string, MutablePeriod>, key: string, bucket: UsageBucket, tokens: number): void {
  let period = periods.get(key)
  if (!period) periods.set(key, (period = { day: bucket.day, ...(bucket.hourStart ? { hourStart: bucket.hourStart } : {}), costUsd: 0, totalTokens: 0, byAgent: {} }))
  period.costUsd += bucket.costUsd
  period.totalTokens += tokens
  const entry = period.byAgent[bucket.agent] ??= { costUsd: 0, totalTokens: 0 }
  entry.costUsd += bucket.costUsd
  entry.totalTokens += tokens
}

export function summarizeUsage(buckets: readonly UsageBucket[], stores: readonly UsageAgentStatus[]): Totals {
  let costUsd = 0, uncachedInputTokens = 0, cachedInputTokens = 0, cacheCreationTokens = 0
  let outputTokens = 0, records = 0, sessions = 0, cacheSavingsUsd = 0
  const agents = new Map<AgentId, { costUsd: number; totalTokens: number; records: number; sessions: number }>()
  const models = new Map<string, { agent: AgentId; model: string; costUsd: number; totalTokens: number; records: number }>()
  const daily = new Map<string, MutablePeriod>()
  const hourly = new Map<string, MutablePeriod>()
  const notes: string[] = []
  const agentEntry = (agent: AgentId) => {
    let entry = agents.get(agent)
    if (!entry) agents.set(agent, (entry = { costUsd: 0, totalTokens: 0, records: 0, sessions: 0 }))
    return entry
  }

  for (const status of stores) {
    if (status.note) notes.push(status.note)
    if (status.status !== 'ok' || status.sessions === 0) continue
    sessions += status.sessions
    agentEntry(status.agent).sessions += status.sessions
  }
  for (const bucket of buckets) {
    const tokens = bucketTokens(bucket)
    costUsd += bucket.costUsd
    cacheSavingsUsd += bucket.cacheSavingsUsd
    uncachedInputTokens += bucket.totals.uncachedInputTokens
    cachedInputTokens += bucket.totals.cachedInputTokens
    cacheCreationTokens += bucket.totals.cacheCreationTokens
    outputTokens += bucket.totals.outputTokens
    records += bucket.records

    const agent = agentEntry(bucket.agent)
    agent.costUsd += bucket.costUsd
    agent.totalTokens += tokens
    agent.records += bucket.records

    const modelKey = `${bucket.agent} ${bucket.model}`
    const model = models.get(modelKey) ?? { agent: bucket.agent, model: bucket.model, costUsd: 0, totalTokens: 0, records: 0 }
    model.costUsd += bucket.costUsd
    model.totalTokens += tokens
    model.records += bucket.records
    models.set(modelKey, model)

    addToPeriod(daily, bucket.day, bucket, tokens)
    if (bucket.hourStart !== undefined) addToPeriod(hourly, bucket.hourStart, bucket, tokens)
  }

  const totalTokens = uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens
  return {
    costUsd, uncachedInputTokens, cachedInputTokens, cacheCreationTokens, outputTokens, totalTokens, records, sessions, cacheSavingsUsd,
    agents: [...agents].map(([agent, t]) => ({
      agent, ...t,
      costShare: costUsd === 0 ? 0 : t.costUsd / costUsd,
      tokenShare: totalTokens === 0 ? 0 : t.totalTokens / totalTokens,
    })).sort((a, b) => b.costUsd - a.costUsd),
    models: [...models.values()].map((m) => ({ ...m, costShare: costUsd === 0 ? 0 : m.costUsd / costUsd }))
      .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens),
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
    hourly: [...hourly.values()].sort((a, b) => a.hourStart!.localeCompare(b.hourStart!)),
    notes,
  }
}
