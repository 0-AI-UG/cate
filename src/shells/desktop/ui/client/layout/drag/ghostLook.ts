// How a chip or row looks while it is lifted by a drag: the accent, tinted, with a dashed
// outline. Both docks (the window's tab strip and the sidebar's tree) restyle the dragged
// element itself with it, so the ghost is the same element, with its own markup and
// indentation, not a copy drawn in its place. An outline, not a border: it takes no room.

import type { CSSProperties } from 'react'

export const GHOST_LOOK: CSSProperties = {
  color: 'var(--focus-blue, #3b82f6)',
  backgroundColor: 'color-mix(in srgb, var(--focus-blue, #3b82f6) 18%, transparent)',
  outline: '1px dashed color-mix(in srgb, var(--focus-blue, #3b82f6) 70%, transparent)',
  outlineOffset: -1,
}
