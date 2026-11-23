import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { createClientSettingsStore } from '@kernel/settings/client'
import { clientSettingsTable } from '../../../../settings'
import { installClientSettings } from '../../../kernel/settings'
import { BUILTIN_WALLPAPERS } from '../../../client/layout/canvas'
import { CanvasPage, installBuiltinWallpapers } from './CanvasPage'

it('selects bundled wallpapers, persists the choice and restores the selected swatch', async () => {
  const device = createMemoryDeviceStore()
  const store = createClientSettingsStore(device, clientSettingsTable)
  await store.load()
  installClientSettings(store)
  installBuiltinWallpapers(BUILTIN_WALLPAPERS)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)

  try {
    act(() => root.render(<CanvasPage />))
    for (const name of ['Lighthouse', 'Snowy Pass']) {
      const wallpaper = BUILTIN_WALLPAPERS.find((w) => w.name === name)!
      const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!
      expect(button).not.toBeNull()
      act(() => button.click())
      expect(store.get('canvasBackgroundImagePath')).toBe(`builtin:${wallpaper.id}`)
      expect(button.getAttribute('aria-pressed')).toBe('true')
      expect(host.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(1)
      expect(await device.get('settings')).toMatchObject({ canvasBackgroundImagePath: `builtin:${wallpaper.id}` })
    }

    const reloaded = createClientSettingsStore(device, clientSettingsTable)
    await reloaded.load()
    act(() => installClientSettings(reloaded))
    expect(host.querySelector('button[aria-label="Snowy Pass"]')?.getAttribute('aria-pressed')).toBe('true')
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="None"]')!.click())
    expect(reloaded.get('canvasBackgroundImagePath')).toBe('')
    reloaded.dispose()
  } finally {
    act(() => root.unmount())
    host.remove()
    installClientSettings(null)
    installBuiltinWallpapers([])
    store.dispose()
  }
})
