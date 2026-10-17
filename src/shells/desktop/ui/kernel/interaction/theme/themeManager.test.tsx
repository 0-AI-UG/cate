import { afterEach, expect, it, vi } from 'vitest'
import { applyTheme, applyUiScale, getActiveTheme, installAppearanceHost, subscribeTheme } from './themeManager'
import { BUILT_IN_BY_ID, DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID, mergeThemeApp, type Theme } from '@kernel/interaction/contract'

const custom = {
  ...BUILT_IN_BY_ID[DEFAULT_DARK_THEME_ID], id: 'custom',
  app: { 'surface-1': '#ff00ff', 'text-primary': '#abcdef', 'custom-token': '#123456' },
} as Theme

let customThemes: Theme[] = []
const onThemeApplied = vi.fn()
const setUiScale = vi.fn()
installAppearanceHost({
  themeSettings: () => ({ customThemes, systemDarkThemeId: DEFAULT_DARK_THEME_ID, systemLightThemeId: DEFAULT_LIGHT_THEME_ID }),
  onThemeApplied,
  setUiScale,
})

afterEach(() => {
  customThemes = []
  applyTheme(DEFAULT_DARK_THEME_ID)
  document.documentElement.style.removeProperty('--unrelated')
})

it.each([DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID, 'deleted-theme'])('fully replaces custom colors when switching to %s', (selection) => {
  customThemes = [custom]
  applyTheme(custom.id)
  expect(document.documentElement.style.getPropertyValue('--surface-1')).toBe('#ff00ff')
  expect(document.documentElement.style.getPropertyValue('--custom-token')).toBe('#123456')
  document.documentElement.style.setProperty('--unrelated', '42px')
  customThemes = []
  const listener = vi.fn()
  const unsubscribe = subscribeTheme(listener)
  try {
    applyTheme(selection)
    const expected = BUILT_IN_BY_ID[selection] ?? BUILT_IN_BY_ID[DEFAULT_DARK_THEME_ID]
    expect(getActiveTheme()).toBe(expected)
    for (const [key, value] of Object.entries(mergeThemeApp(expected))) {
      expect(document.documentElement.style.getPropertyValue('--' + key)).toBe(value)
    }
    expect(document.documentElement.style.getPropertyValue('--custom-token')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--unrelated')).toBe('42px')
    expect(document.documentElement.dataset.theme).toBe(expected.type)
    expect(listener).toHaveBeenCalledWith(expected)
  } finally {
    unsubscribe()
  }
})

it('hands the host a boot snapshot with the exact background and appearance', () => {
  applyTheme(DEFAULT_LIGHT_THEME_ID)
  const light = BUILT_IN_BY_ID[DEFAULT_LIGHT_THEME_ID]
  expect(onThemeApplied).toHaveBeenLastCalledWith({
    theme: light.id,
    backgroundColor: light.bootBackground ?? mergeThemeApp(light)['surface-0'],
    appearance: 'light',
  })
})

it('clamps the UI scale before handing it to the host', () => {
  applyUiScale(5)
  expect(setUiScale).toHaveBeenLastCalledWith(2)
  applyUiScale(Number.NaN)
  expect(setUiScale).toHaveBeenLastCalledWith(1)
})
