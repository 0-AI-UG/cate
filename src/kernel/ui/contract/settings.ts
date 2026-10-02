import { defineSettings, everyItem, everyValue, numberIn, setting } from '@kernel/settings/contract/define'
import { validateTheme, type Theme, type ThemeSelection } from './theme'
import type { ActionId } from './actions'
import type { StoredShortcut } from './shortcuts'

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
    /** Overrides of the default bindings by action id; an empty key
     *  disables one. Actions are declared at run time, so an id no module
     *  declares is kept and ignored. */
    customShortcuts: setting<Record<ActionId, StoredShortcut>>({}, everyValue((shortcut) => isStoredShortcut(shortcut))),
  },
})
