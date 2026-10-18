// Agent usage of a workspace, as its runtime totals it. Results are kept per
// workspace and window, so switching periods or workspaces back is instant.

import { tryRuntimeFor } from '@kernel/rpc/client'
import type { UsageLimitsReport, UsageSummary, UsageSummaryInput } from '../contract'

export interface UsageReport<T> {
  isPending: boolean
  error: string | null
  value: T | null
}

interface Entry<T> {
  value: T | null
  error: string | null
  pending: Promise<void> | null
}

export interface UsageReports {
  subscribe(listener: () => void): () => void
  /** Bumped on every change, for external-store snapshots. */
  version(): number
  /** The workspace's usage for the window, querying it the first time. */
  summary(workspaceId: string, input: UsageSummaryInput): UsageReport<UsageSummary>
  /** Refetches the rate table, then rescans the workspace. */
  refreshSummary(workspaceId: string, input: UsageSummaryInput): Promise<void>
  limits(workspaceId: string): UsageReport<UsageLimitsReport>
  refreshLimits(workspaceId: string): Promise<void>
}

const windowKey = (input: UsageSummaryInput) =>
  JSON.stringify([input.sinceDay, input.untilDay, input.timeZone, input.resolution, input.sinceTime, input.untilTime])

function agentsOf(workspaceId: string) {
  const runtime = tryRuntimeFor(workspaceId)
  if (!runtime) throw new Error('This workspace is not connected.')
  return runtime.agents
}

export function createUsageReports(): UsageReports {
  const summaries = new Map<string, Entry<UsageSummary>>()
  const limits = new Map<string, Entry<UsageLimitsReport>>()
  const listeners = new Set<() => void>()
  let version = 0
  const changed = () => {
    version++
    for (const listener of [...listeners]) listener()
  }

  function load<T>(table: Map<string, Entry<T>>, key: string, run: () => Promise<T>, failure: string): Promise<void> {
    const entry = table.get(key) ?? { value: null, error: null, pending: null }
    table.set(key, entry)
    const pending: Promise<void> = Promise.resolve().then(run).then(
      (value) => { entry.value = value; entry.error = null },
      (error: unknown) => { entry.error = error instanceof Error && error.message ? error.message : failure },
    ).finally(() => {
      if (entry.pending === pending) entry.pending = null
      changed()
    })
    entry.pending = pending
    return pending
  }

  const report = <T>(entry: Entry<T> | undefined): UsageReport<T> =>
    ({ isPending: !!entry?.pending, error: entry?.error ?? null, value: entry?.value ?? null })
  const summaryKey = (workspaceId: string, input: UsageSummaryInput) => `${workspaceId}\u0000${windowKey(input)}`
  const loadSummary = (workspaceId: string, input: UsageSummaryInput) =>
    load(summaries, summaryKey(workspaceId, input), () => agentsOf(workspaceId).usage(input), 'This workspace could not report usage.')
  const loadLimits = (workspaceId: string, refresh: boolean) =>
    load(limits, workspaceId, () => agentsOf(workspaceId).usageLimits({ refresh }), 'This workspace could not report limits.')

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    version: () => version,
    summary(workspaceId, input) {
      const key = summaryKey(workspaceId, input)
      if (!summaries.has(key)) void loadSummary(workspaceId, input)
      return report(summaries.get(key))
    },
    async refreshSummary(workspaceId, input) {
      // Rates first, so a model LiteLLM just added is priced by the rescan.
      await Promise.resolve().then(() => agentsOf(workspaceId).refreshUsageRates()).catch(() => undefined)
      await loadSummary(workspaceId, input)
    },
    limits(workspaceId) {
      if (!limits.has(workspaceId)) void loadLimits(workspaceId, false)
      return report(limits.get(workspaceId))
    },
    refreshLimits: (workspaceId) => loadLimits(workspaceId, true),
  }
}
