import type { CSSProperties } from 'react'

// Title-text styling for a panel that belongs to a parallel-work worktree.
// Parallel work tints the tab/row TITLE rather than the icon — the icon may be
// an agent logo (an <img>, which ignores `color`), and tinting it would clash
// with the per-agent icon swap.
//
// While the agent is running the title shimmers: the caller adds the
// `cate-notif-pulse` class and this returns the gradient stops as CSS custom
// properties (--shimmer-dim/--shimmer-bright). The base sits at the worktree
// color and a WHITE highlight sweeps across it — keeping the moving band white
// regardless of hue, since a same-hue sweep (bright color over dim color) is
// too subtle on darker/saturated worktree colors. When idle it returns a steady
// color. Without a worktree color it returns undefined, so a running
// non-worktree title falls back to the class's default muted->primary sweep.
export function worktreeTitleStyle(
  color: string | undefined,
  isRunning: boolean,
): CSSProperties | undefined {
  if (!color) return undefined
  if (!isRunning) return { color }
  return {
    '--shimmer-bright': '#ffffff',
    '--shimmer-dim': color,
  } as CSSProperties
}
