// Agent usage (architecture 10.3): what the agent CLIs used in a workspace,
// read from each CLI's own session store on the runtime's machine and
// attributed to the workspace by the session's working directory (the root or
// a worktree under it). The runtime buckets the records by `(day, hourStart?,
// agent, model)` and returns the totals the overview draws; raw records never
// cross the wire.

import type { AgentId } from '../registry'

/** A calendar day in the reporting time zone, `YYYY-MM-DD`. */
export type UsageDay = string

export type UsageResolution = 'day' | 'hour'

/** Why a bucket costs what it does: the CLI recorded the cost, the model was
 *  priced (custom price or LiteLLM rate), or no rate is known (counted in
 *  tokens, not in cost). */
export type UsageCostSource = 'providerReported' | 'modelPriced' | 'unpriced'

/** `cachedInputTokens` and `cacheCreationTokens` are disjoint from
 *  `uncachedInputTokens`; the three sum to total input. `reasoningTokens` is a
 *  subset of `outputTokens` and is never added on top. */
export interface UsageTokenTotals {
  uncachedInputTokens: number
  cachedInputTokens: number
  cacheCreationTokens: number
  outputTokens: number
  reasoningTokens: number
}

/** One `(day, hourStart?, agent, model)` cell; `hourStart` (UTC) only for
 *  hourly windows. `costUsd` is the API-equivalent cost, not money spent:
 *  subscriptions bill separately. */
export interface UsageBucket {
  day: UsageDay
  hourStart?: string
  agent: AgentId
  model: string
  totals: UsageTokenTotals
  costUsd: number
  /** What the cached input would have cost at full input rates minus what it cost. */
  cacheSavingsUsd: number
  costSource: UsageCostSource
  /** Distinct responses, after de-duplication. */
  records: number
  unpricedRecords: number
}

/** How an agent's store fared: `missing` (the CLI keeps no store on this
 *  machine) or `unsupported` (its store holds no token counts; `note` says
 *  what it holds instead). */
export interface UsageAgentStatus {
  agent: AgentId
  status: 'ok' | 'missing' | 'unsupported'
  /** Distinct sessions in the window: a session spans days and models, so
   *  this is the figure to total, not a sum over buckets. */
  sessions: number
  note: string | null
}

export type UsagePricingStatus = 'fresh' | 'cached' | 'unavailable'

export interface UsagePricing {
  status: UsagePricingStatus
  source: string
  fetchedAt: string | null
  knownModels: number
}

export interface UsageSummaryInput {
  /** Inclusive first day, in `timeZone`. */
  sinceDay: UsageDay
  /** Inclusive last day, in `timeZone`. */
  untilDay: UsageDay
  /** IANA zone days are bucketed in. */
  timeZone: string
  resolution?: UsageResolution
  /** Inclusive UTC instant of an hourly rolling window. */
  sinceTime?: string
  /** Exclusive UTC instant of an hourly rolling window. */
  untilTime?: string
}

export interface UsageAgentTotals {
  agent: AgentId
  costUsd: number
  totalTokens: number
  records: number
  sessions: number
  costShare: number
  tokenShare: number
}

export interface UsageModelTotals {
  model: string
  agent: AgentId
  costUsd: number
  totalTokens: number
  records: number
  costShare: number
}

export interface UsagePeriodTotals {
  day: UsageDay
  /** Set for an hourly period. */
  hourStart?: string
  costUsd: number
  totalTokens: number
  byAgent: Partial<Record<AgentId, { costUsd: number; totalTokens: number }>>
}

/** The workspace's usage in a window, totalled by the runtime. */
export interface UsageSummary {
  readAt: string
  timeZone: string
  sinceDay: UsageDay
  untilDay: UsageDay
  costUsd: number
  uncachedInputTokens: number
  cachedInputTokens: number
  cacheCreationTokens: number
  outputTokens: number
  totalTokens: number
  records: number
  sessions: number
  cacheSavingsUsd: number
  /** By cost, highest first. */
  agents: UsageAgentTotals[]
  /** By cost, highest first. */
  models: UsageModelTotals[]
  /** Oldest first; only periods with activity. */
  daily: UsagePeriodTotals[]
  /** Oldest first; empty for a daily window. */
  hourly: UsagePeriodTotals[]
  /** How each agent's store fared. */
  stores: UsageAgentStatus[]
  /** What agents without token counts recorded instead. */
  notes: string[]
  pricing: UsagePricing
  scanDurationMs: number
}

/** USD per million tokens. Omitted cache rates use the input rate. */
export interface UsageModelPriceOverride {
  inputCostPerMillionTokens: number
  outputCostPerMillionTokens: number
  cacheReadCostPerMillionTokens?: number
  cacheWriteCostPerMillionTokens?: number
}

// --- Subscription limits ---------------------------------------------------------

export type UsageLimitPace = 'ahead' | 'on' | 'under'

/** One rolling quota window of the signed-in account (Claude's five-hour
 *  session, Codex's weekly allowance); `id` is stable per agent. */
export interface UsageLimitWindow {
  id: string
  kind: 'session' | 'weekly' | 'monthly' | 'other'
  label: string
  /** 0..100 */
  usedPercent: number
  resetsAt?: string
  windowDurationMins?: number
}

/** A window as the runtime reports it: what is left and the pace against
 *  the clock (null when its length or reset is unknown). */
export interface UsageLimitWindowStatus extends UsageLimitWindow {
  /** 0..100, rounded. */
  remainingPercent: number
  pace: UsageLimitPace | null
}

export interface UsageResetCredits {
  availableCount: number
  nextExpiresAt?: string
}

/** What an agent CLI knows about its signed-in account's subscription.
 *  `unavailable` tells an account that can never report windows (API key)
 *  from a probe that failed this time. */
export interface UsageAgentLimits {
  agent: AgentId
  checkedAt: string
  email?: string
  plan?: string
  windows: UsageLimitWindow[]
  resetCredits?: UsageResetCredits
  unavailable?: { reason: 'unsupported' | 'probeFailed'; message?: string }
}

/** An account with windows to draw, sorted session, weekly, monthly. */
export interface UsageAccountLimits extends Omit<UsageAgentLimits, 'windows' | 'unavailable'> {
  windows: UsageLimitWindowStatus[]
}

/** The subscription limits of the accounts the workspace's agent CLIs are
 *  signed in to, as of `checkedAt` (the paces are judged then). */
export interface UsageLimitsReport {
  checkedAt: string
  accounts: UsageAccountLimits[]
  /** Probes that failed, one line each. Accounts that can never report (API
   *  keys) are left out; there is nothing to act on. */
  notices: Array<{ agent: AgentId; message: string }>
}
