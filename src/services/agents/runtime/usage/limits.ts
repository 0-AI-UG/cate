// The workspace's limits report: the accounts with windows to draw, each
// window with what is left and its pace against the clock, and the probes
// that failed.

import type { UsageAgentLimits, UsageLimitPace, UsageLimitWindow, UsageLimitWindowStatus, UsageLimitsReport } from '../../contract'

const MINUTE = 60_000

const WINDOW_KIND_ORDER: Record<UsageLimitWindow['kind'], number> = { session: 0, weekly: 1, monthly: 2, other: 3 }

/** The line shown instead of bars: null when there are bars to draw. */
function limitsNotice(limits: UsageAgentLimits): string | null {
  if (limits.unavailable?.reason === 'unsupported') return limits.unavailable.message ?? 'This account has no subscription limits.'
  if (limits.unavailable?.reason === 'probeFailed') return limits.unavailable.message ?? 'Could not read limits.'
  return limits.windows.length === 0 ? 'No limits reported.' : null
}

/** Elapsed share of the window, 0..1, or null when its length or reset is unknown. */
function elapsedShare(window: UsageLimitWindow, now: number): number | null {
  if (window.resetsAt === undefined || window.windowDurationMins === undefined) return null
  const resetsAt = Date.parse(window.resetsAt)
  const length = window.windowDurationMins * MINUTE
  if (!Number.isFinite(resetsAt) || length <= 0) return null
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length))
}

/** Usage against the clock: within five points of even spending is on pace. */
function paceOf(window: UsageLimitWindow, now: number): UsageLimitPace | null {
  const elapsed = elapsedShare(window, now)
  if (elapsed === null) return null
  const gap = window.usedPercent - elapsed * 100
  if (gap > 5) return 'ahead'
  if (gap < -5) return 'under'
  return 'on'
}

function windowStatus(window: UsageLimitWindow, now: number): UsageLimitWindowStatus {
  return {
    ...window,
    remainingPercent: Math.round(100 - Math.max(0, Math.min(100, window.usedPercent))),
    pace: paceOf(window, now),
  }
}

export function limitsReport(agents: readonly UsageAgentLimits[], now: number): UsageLimitsReport {
  const report: UsageLimitsReport = { checkedAt: new Date(now).toISOString(), accounts: [], notices: [] }
  for (const limits of agents) {
    const notice = limitsNotice(limits)
    if (notice === null) {
      const { windows, unavailable: _, ...account } = limits
      report.accounts.push({
        ...account,
        windows: windows.map((w) => windowStatus(w, now)).sort((a, b) => WINDOW_KIND_ORDER[a.kind] - WINDOW_KIND_ORDER[b.kind]),
      })
    } else if (limits.unavailable?.reason !== 'unsupported') {
      report.notices.push({ agent: limits.agent, message: notice })
    }
  }
  return report
}
