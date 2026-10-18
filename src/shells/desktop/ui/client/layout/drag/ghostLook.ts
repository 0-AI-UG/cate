// How a chip or row looks while it is lifted by a drag: the accent, tinted, with a dashed
// outline. Both docks (the window's tab strip and the sidebar's tree) restyle the dragged
// element itself with it, so the ghost is the same element, with its own markup and
// indentation, not a copy drawn in its place. An outline, not a border: it takes no room.

import type { CSSProperties } from 'react'

/** The accent at `pct` percent. */
export const focusBlue = (pct: number): string => `color-mix(in srgb, var(--focus-blue, #3b82f6) ${pct}%, transparent)`

/** The refusal accent (amber) at `pct` percent: a ghost that says its drop is refused. */
export const warnAmber = (pct: number): string => `color-mix(in srgb, #fbbf24 ${pct}%, transparent)`

export const GHOST_LOOK: CSSProperties = {
  color: 'var(--focus-blue, #3b82f6)',
  backgroundColor: focusBlue(18),
  outline: `1px dashed ${focusBlue(70)}`,
  outlineOffset: -1,
}
