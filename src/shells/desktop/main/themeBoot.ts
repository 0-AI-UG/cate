// The theme boot cache in `boot.json`: the active theme's id, background and
// native appearance, read synchronously at the next launch so the first frame
// has the right color. Rebuilt in main from the client settings whenever they
// or the OS appearance change, including hand edits of settings.json.

import { clientSettingsTable } from '@kernel/settings/contract'
import { resolveTheme, themeBootSnapshot, type ThemeBootSnapshot } from '@kernel/ui/contract'
import type { DeviceFiles } from './deviceFiles'

export function themeBootFields(settings: unknown, prefersDark: boolean): ThemeBootSnapshot {
  const values = clientSettingsTable.normalize(settings)
  return themeBootSnapshot(resolveTheme(values, values.activeThemeId, prefersDark), values.activeThemeId)
}

export interface NativeThemeLike {
  shouldUseDarkColors: boolean
  themeSource: 'system' | 'light' | 'dark'
  on(event: 'updated', listener: () => void): unknown
}

export function installThemeBootCache(device: DeviceFiles, nativeTheme: NativeThemeLike): () => void {
  const refresh = () => {
    const fields = themeBootFields(device.get('settings'), nativeTheme.shouldUseDarkColors)
    const boot = device.boot()
    if (boot.theme !== fields.theme || boot.backgroundColor !== fields.backgroundColor || boot.appearance !== fields.appearance) {
      device.updateBoot(fields)
    }
    if (nativeTheme.themeSource !== fields.appearance) nativeTheme.themeSource = fields.appearance
  }
  refresh()
  nativeTheme.on('updated', refresh)
  return device.subscribe((name) => { if (name === 'settings') refresh() })
}
