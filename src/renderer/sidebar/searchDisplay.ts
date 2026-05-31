// =============================================================================
// searchDisplay — pure helpers for rendering search-result lines. No React, so
// they are unit-testable in isolation.
// =============================================================================

import type { SearchMatchRange } from '../../shared/types'

/** Trim leading whitespace and shift ranges. Used for the full-line tooltip. */
export function trimLeading(
  text: string,
  ranges: SearchMatchRange[],
): { text: string; ranges: SearchMatchRange[] } {
  const leading = text.length - text.trimStart().length
  if (leading === 0) return { text, ranges }
  return {
    text: text.slice(leading),
    ranges: ranges.map((r) => ({ start: Math.max(0, r.start - leading), end: Math.max(0, r.end - leading) })),
  }
}

/** Chars of context to keep before the first match when start-trimming. */
export const MAX_PREFIX = 8

/**
 * Trim leading whitespace AND, when the first match sits far to the right,
 * trim from the start so the match stays visible in the (truncated) row —
 * mirrors VS Code's leading "…". `ellipsis` signals a leading "…" is needed.
 */
export function trimForDisplay(
  text: string,
  ranges: SearchMatchRange[],
): { text: string; ranges: SearchMatchRange[]; ellipsis: boolean } {
  const led = trimLeading(text, ranges)
  let t = led.text
  let rs = led.ranges
  let ellipsis = false
  if (rs.length) {
    const firstStart = Math.min(...rs.map((r) => r.start))
    if (firstStart > MAX_PREFIX) {
      const cut = firstStart - MAX_PREFIX
      t = t.slice(cut)
      rs = rs.map((r) => ({ start: Math.max(0, r.start - cut), end: Math.max(0, r.end - cut) }))
      ellipsis = true
    }
  }
  return { text: t, ranges: rs, ellipsis }
}
