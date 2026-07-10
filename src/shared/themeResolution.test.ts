import { describe, expect, it } from 'vitest'
import { resolveTheme, mergeThemeApp } from './themeResolution'
import { BASE_DARK, BASE_LIGHT, BUILT_IN_THEMES, DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID } from './themes'
import type { AppSettings } from './types'

const settings = {
  customThemes: [],
  systemDarkThemeId: DEFAULT_DARK_THEME_ID,
  systemLightThemeId: DEFAULT_LIGHT_THEME_ID,
} satisfies Pick<AppSettings, 'customThemes' | 'systemDarkThemeId' | 'systemLightThemeId'>

describe('theme resolution', () => {
  it('resolves the configured light and dark system themes', () => {
    expect(resolveTheme(settings, 'system', true).id).toBe(DEFAULT_DARK_THEME_ID)
    expect(resolveTheme(settings, 'system', false).id).toBe(DEFAULT_LIGHT_THEME_ID)
  })

  it('prefers a custom theme and falls back safely for unknown ids', () => {
    const custom = { ...BUILT_IN_THEMES[0], id: 'custom', name: 'Custom' }
    const withCustom = { ...settings, customThemes: [custom] }

    expect(resolveTheme(withCustom, 'custom', false)).toBe(custom)
    expect(resolveTheme(settings, 'missing-theme', false).id).toBe(DEFAULT_DARK_THEME_ID)
  })

  it('falls back to the matching system appearance when its configured id is missing', () => {
    const missing = { ...settings, systemDarkThemeId: 'missing-dark', systemLightThemeId: 'missing-light' }
    expect(resolveTheme(missing, 'system', true).id).toBe(DEFAULT_DARK_THEME_ID)
    expect(resolveTheme(missing, 'system', false).id).toBe(DEFAULT_LIGHT_THEME_ID)
  })

  it('merges theme app overrides onto the matching complete base palette', () => {
    const dark = { ...BUILT_IN_THEMES[0], type: 'dark' as const, app: { 'surface-0': '#010203' } }
    const light = { ...BUILT_IN_THEMES[0], type: 'light' as const, app: { 'surface-0': '#fefefe' } }

    expect(mergeThemeApp(dark)).toEqual({ ...BASE_DARK, 'surface-0': '#010203' })
    expect(mergeThemeApp(light)).toEqual({ ...BASE_LIGHT, 'surface-0': '#fefefe' })
  })
})
