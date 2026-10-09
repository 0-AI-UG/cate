import type { Theme, ThemeSelection } from './theme'
import {
  BASE_DARK,
  BASE_LIGHT,
  BUILT_IN_BY_ID,
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
} from './themes'

/** The Appearance settings theme resolution reads. */
export interface ThemeSettings {
  customThemes?: Theme[]
  systemDarkThemeId: string
  systemLightThemeId: string
}

export function resolveTheme(
  settings: ThemeSettings,
  selection: ThemeSelection,
  prefersDark: boolean,
): Theme {
  const byId = (id: string): Theme | undefined =>
    (settings.customThemes ?? []).find((theme) => theme.id === id) ?? BUILT_IN_BY_ID[id]
  if (selection === 'system') {
    const id = prefersDark
      ? settings.systemDarkThemeId || DEFAULT_DARK_THEME_ID
      : settings.systemLightThemeId || DEFAULT_LIGHT_THEME_ID
    return byId(id) ?? BUILT_IN_BY_ID[prefersDark ? DEFAULT_DARK_THEME_ID : DEFAULT_LIGHT_THEME_ID]
  }
  return byId(selection) ?? BUILT_IN_BY_ID[DEFAULT_DARK_THEME_ID]
}

export function mergeThemeApp(theme: Theme): Record<string, string> {
  const base = theme.type === 'light' ? BASE_LIGHT : BASE_DARK
  return { ...base, ...theme.app }
}

/** What the desktop shell caches so the next cold launch opens its window in
 *  the right color before any JS runs, and which native appearance to use. */
export interface ThemeBootSnapshot {
  theme: string
  backgroundColor: string
  /** 'system' while the selection follows the OS, so `prefers-color-scheme`
   *  stays bound to the real OS appearance. */
  appearance: 'dark' | 'light' | 'system'
}

export function themeBootSnapshot(theme: Theme, selection: ThemeSelection): ThemeBootSnapshot {
  return {
    theme: theme.id,
    backgroundColor: theme.bootBackground ?? mergeThemeApp(theme)['surface-0'],
    appearance: selection === 'system' ? 'system' : theme.type,
  }
}
