import type { Theme } from './theme'
import type { AppSettings, ThemeSelection } from './types'
import {
  BASE_DARK,
  BASE_LIGHT,
  BUILT_IN_BY_ID,
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
} from './themes'

export function resolveTheme(
  settings: Pick<AppSettings, 'customThemes' | 'systemDarkThemeId' | 'systemLightThemeId'>,
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
