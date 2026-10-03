import type { CSSProperties } from 'react'

// Title-text styling for a panel that belongs to a parallel-work worktree.
// Parallel work tints the tab/row TITLE rather than the icon — the icon may be
// an agent logo (an <img>, which ignores `color`), and tinting it would clash
// with the per-agent icon swap.
// Without a worktree color it returns undefined (the title keeps its default).
export function worktreeTitleStyle(color: string | undefined): CSSProperties | undefined {
  return color ? { color } : undefined
}
