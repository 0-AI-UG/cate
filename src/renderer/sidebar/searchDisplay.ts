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
