// Formatting for the overview's Limits view; the runtime reports what is left
// and the pace of every window.

import type { UsageAgentLimits, UsageLimitWindow } from './types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function resetMillis(window: UsageLimitWindow): number | null {
  if (window.resetsAt === undefined) return null
  const at = Date.parse(window.resetsAt)
  return Number.isFinite(at) ? at : null
}

/** `2h 13m`, `3d 4h`, `12m`. */
export function formatDuration(ms: number): string {
  const remaining = Math.max(0, ms)
  const days = Math.floor(remaining / DAY)
  const hours = Math.floor((remaining % DAY) / HOUR)
  const minutes = Math.floor((remaining % HOUR) / MINUTE)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** `resets in 2h 13m`, or null when the window has no reset. */
export function formatResetsIn(window: UsageLimitWindow, now: number): string | null {
  const resetsAt = resetMillis(window)
  if (resetsAt === null) return null
  return resetsAt <= now ? 'resets now' : `resets in ${formatDuration(resetsAt - now)}`
}

/** `2 reset credits banked · next expires in 27d 23h`. */
export function resetCreditsSummary(credits: NonNullable<UsageAgentLimits['resetCredits']>, now: number): string {
  if (credits.availableCount === 0) return 'No reset credits banked'
  const expiresIn = credits.nextExpiresAt ? formatDuration(Date.parse(credits.nextExpiresAt) - now) : null
  return `${credits.availableCount} banked${expiresIn ? ` · expires in ${expiresIn}` : ''}`
}
