import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AppearanceSettings } from './AppearanceSettings'
import { useSettingsStore } from '../stores/settingsStore'
import { useThemeAndScaleHydration } from '../lib/hooks/useThemeAndScaleHydration'
import { applyTheme, getActiveTheme } from '../lib/themeManager'
import { DEFAULT_SETTINGS } from '../../shared/types'
import { BUILT_IN_BY_ID, DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID } from '../../shared/themes'
import { mergeThemeApp } from '../../shared/themeResolution'

let host: HTMLDivElement
let root: Root
const custom = { ...BUILT_IN_BY_ID[DEFAULT_DARK_THEME_ID], id: 'custom', name: 'Custom', builtIn: false, app: { 'surface-1': '#ff00ff' } }

function Settings() {
  useThemeAndScaleHydration()
  return <AppearanceSettings />
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('electronAPI', { ...window.electronAPI, settingsSet: vi.fn().mockResolvedValue(undefined) })
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  useSettingsStore.setState({ ...DEFAULT_SETTINGS, customThemes: [custom] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useSettingsStore.setState(DEFAULT_SETTINGS)
  applyTheme(DEFAULT_DARK_THEME_ID)
  vi.unstubAllGlobals()
})

it.each(['system', 'custom'])('restores the standard system palette when deleting its custom theme from %s mode', (selection) => {
  useSettingsStore.setState({ activeThemeId: selection, systemDarkThemeId: custom.id, systemLightThemeId: custom.id })
  act(() => root.render(<Settings />))
  expect(document.documentElement.style.getPropertyValue('--surface-1')).toBe('#ff00ff')
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Remove theme"]')!.click())
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Confirm removal"]')!.click())
  const settings = useSettingsStore.getState()
  expect(settings.customThemes).toEqual([])
  expect(settings.activeThemeId).toBe('system')
  expect(settings.systemDarkThemeId).toBe(DEFAULT_DARK_THEME_ID)
  expect(settings.systemLightThemeId).toBe(DEFAULT_LIGHT_THEME_ID)
  expect(getActiveTheme().id).toBe(DEFAULT_DARK_THEME_ID)
  expect(document.documentElement.style.getPropertyValue('--surface-1')).toBe(mergeThemeApp(BUILT_IN_BY_ID[DEFAULT_DARK_THEME_ID])['surface-1'])
})
