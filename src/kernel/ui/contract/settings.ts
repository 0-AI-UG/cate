import { defineSettings, everyItem, everyValue, numberIn, setting } from '@kernel/settings/contract/define'
import { validateTheme, type Theme, type ThemeSelection } from './theme'
import { SHORTCUT_ACTIONS, type ShortcutAction, type StoredShortcut } from './shortcuts'

export const appearanceSettings = defineSettings({
  scope: 'client',
  keys: {
    /** 'system' (follow OS light/dark) or a theme id. */
    activeThemeId: setting<ThemeSelection>('system'),
    systemLightThemeId: setting('light-subtle'),
    systemDarkThemeId: setting('dark-cold'),
    customThemes: setting<Theme[]>([], everyItem((theme) => validateTheme(theme).ok)),
    /** Zoom of Cate's own chrome (not web pages in browser panels). */
    uiScale: setting(1.0, numberIn(0.8, 1.5)),
  },
})

const shortcutActions = new Set<string>(SHORTCUT_ACTIONS)

function isStoredShortcut(value: unknown): value is StoredShortcut {
  const s = value as Record<string, unknown> | null
  return !!s && typeof s === 'object'
    && typeof s.key === 'string'
    && typeof s.command === 'boolean'
    && typeof s.shift === 'boolean'
    && typeof s.option === 'boolean'
    && typeof s.control === 'boolean'
}

export const shortcutSettings = defineSettings({
  scope: 'client',
  keys: {
    /** Overrides of the default bindings only; an empty key disables one. */
    customShortcuts: setting<Partial<Record<ShortcutAction, StoredShortcut>>>(
      {},
      everyValue((shortcut, action) => shortcutActions.has(action) && isStoredShortcut(shortcut)),
    ),
  },
})
