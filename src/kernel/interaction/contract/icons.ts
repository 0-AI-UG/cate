// Icon names. Panel definitions and other pure code carry a name; the ui side
// (`Icon`) maps it to a component.

export const ICON_NAMES = ['terminal', 'globe', 'folders', 'grid', 'git-compare', 'plus', 't3'] as const

export type IconName = (typeof ICON_NAMES)[number]

const ICON_NAME_SET: ReadonlySet<string> = new Set(ICON_NAMES)

export function isIconName(value: unknown): value is IconName {
  return typeof value === 'string' && ICON_NAME_SET.has(value)
}
