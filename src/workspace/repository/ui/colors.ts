// Worktree colors are theme palette keys (`green`, `brightCyan`); each client
// maps a key to its active theme's terminal color.

import { useSyncExternalStore, type CSSProperties } from 'react'
import { getActiveTheme, subscribeTheme } from '@kernel/ui'
import type { Theme } from '@kernel/ui/contract'
import { WORKTREE_COLORS } from '../contract'

/** The theme color of a palette key; an unknown key that is already a CSS
 *  color passes through, anything else is undefined. */
export function worktreeColor(key: string | undefined, theme: Theme = getActiveTheme()): string | undefined {
  if (!key) return undefined
  const value = (theme.terminal as unknown as Record<string, string | undefined>)[key]
  if (value) return value
  return key.startsWith('#') ? key : undefined
}

/** The recolor choices: each palette key with its color, dropping keys the
 *  theme renders the same as an earlier one. */
export function worktreePalette(theme: Theme = getActiveTheme()): Array<{ key: string; color: string }> {
  const seen = new Set<string>()
  const out: Array<{ key: string; color: string }> = []
  for (const key of WORKTREE_COLORS) {
    const color = worktreeColor(key, theme)
    if (!color || seen.has(color.toLowerCase())) continue
    seen.add(color.toLowerCase())
    out.push({ key, color })
  }
  return out
}

const subscribe = (cb: () => void) => subscribeTheme(() => cb())

/** The active theme; re-renders when it changes. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getActiveTheme)
}

export function useWorktreeColor(key: string | undefined): string | undefined {
  return worktreeColor(key, useTheme())
}

// Title-text styling for a panel that belongs to a worktree. The title is
// tinted rather than the icon: the icon may be an agent logo (an <img>, which
// ignores `color`). While the agent runs the title shimmers: the caller adds
// the `cate-notif-pulse` class and this returns the gradient stops, with a
// white highlight sweeping over the worktree color (a same-hue sweep is too
// subtle on saturated colors). Without a color it returns undefined, so the
// class's default sweep applies.
export function worktreeTitleStyle(color: string | undefined, isRunning: boolean): CSSProperties | undefined {
  if (!color) return undefined
  if (!isRunning) return { color }
  return {
    '--shimmer-bright': '#ffffff',
    '--shimmer-dim': color,
  } as CSSProperties
}
