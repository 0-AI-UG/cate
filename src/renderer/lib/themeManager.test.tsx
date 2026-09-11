import { afterEach, expect, it, vi } from 'vitest'
import { applyTheme, getActiveTheme, subscribeTheme } from './themeManager'
import { useSettingsStore } from '../stores/settingsStore'
import { DEFAULT_SETTINGS } from '../../shared/types'
import { BUILT_IN_BY_ID, DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID } from '../../shared/themes'
import { mergeThemeApp } from '../../shared/themeResolution'

const custom = {
  ...BUILT_IN_BY_ID[DEFAULT_DARK_THEME_ID], id: 'custom',
  app: { 'surface-1': '#ff00ff', 'text-primary': '#abcdef', 'custom-token': '#123456' },
}

afterEach(() => {
  useSettingsStore.setState(DEFAULT_SETTINGS)
  applyTheme(DEFAULT_DARK_THEME_ID)
  document.documentElement.style.removeProperty('--unrelated')
})

it.each([DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID, 'deleted-theme'])('fully replaces custom colors when switching to %s', (selection) => {
  useSettingsStore.setState({ customThemes: [custom] })
  applyTheme(custom.id)
  expect(document.documentElement.style.getPropertyValue('--surface-1')).toBe('#ff00ff')
  expect(document.documentElement.style.getPropertyValue('--custom-token')).toBe('#123456')
  document.documentElement.style.setProperty('--unrelated', '42px')
  useSettingsStore.setState({ customThemes: [] })
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
