import type { CSSProperties } from 'react'

// Title-text styling for a panel that belongs to a parallel-work worktree.
// Parallel work tints the tab/row TITLE rather than the icon — the icon may be
// an agent logo (an <img>, which ignores `color`), and tinting it would clash
// with the per-agent icon swap.
//
// While the agent is running the title shimmers in the worktree hue: the caller
// adds the `cate-notif-pulse` class and this returns the gradient stops as CSS
// custom properties (--shimmer-dim/--shimmer-bright). When idle it returns a
// steady color. Without a worktree color it returns undefined, so a running
// non-worktree title falls back to the class's default muted->primary sweep.
export function worktreeTitleStyle(
  color: string | undefined,
  isRunning: boolean,
): CSSProperties | undefined {
  if (!color) return undefined
  if (!isRunning) return { color }
  return {
    '--shimmer-bright': color,
    '--shimmer-dim': `color-mix(in srgb, ${color} 45%, var(--text-muted, #8a8479))`,
  } as CSSProperties
}
