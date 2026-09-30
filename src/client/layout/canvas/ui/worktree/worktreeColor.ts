import { TERMINAL_ANSI_KEYS, type Theme } from '@kernel/ui/contract'

const ANSI_KEYS: ReadonlySet<string> = new Set(TERMINAL_ANSI_KEYS)

/** A worktree's color (a theme palette key such as `green`) as a CSS color in
 *  `theme`. A value that is not a palette key is used as a color as is. */
export function worktreeColor(key: string, theme: Theme): string {
  if (!ANSI_KEYS.has(key)) return key
  return theme.terminal[key as (typeof TERMINAL_ANSI_KEYS)[number]] ?? key
}
