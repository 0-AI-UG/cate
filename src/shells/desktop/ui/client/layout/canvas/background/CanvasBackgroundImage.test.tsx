import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clientSettingsTable, type ClientSettings } from '../../../../../settings'
import { installCanvasSettings } from '../settings'
import CanvasBackgroundImage from './CanvasBackgroundImage'
import { installCanvasBackgroundPort } from '../background'
import { BUILTIN_WALLPAPERS } from './builtinWallpapers'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  const values: ClientSettings = {
    ...clientSettingsTable.defaults,
    canvasBackgroundImagePath: 'builtin:hillside',
    canvasBackgroundImageOpacity: 1,
  }
  installCanvasSettings({
    client: {
      get: (key) => values[key],
      subscribe: () => () => {},
    },
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  installCanvasSettings(null)
  installCanvasBackgroundPort(null)
  vi.unstubAllGlobals()
})

describe('CanvasBackgroundImage', () => {
  it('releases the Blob URL for a custom wallpaper on unmount', async () => {
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:wallpaper', revokeObjectURL })
    const values = { ...clientSettingsTable.defaults, canvasBackgroundImagePath: '/wall.png' }
    installCanvasSettings({ client: { get: key => values[key], subscribe: () => () => {} } })
    installCanvasBackgroundPort({ pickImage: async () => null, readImage: async () => ({ bytes: new Uint8Array([1, 2]), mimeType: 'image/png' }) })
    await act(async () => root.render(<CanvasBackgroundImage />))
    const image = host.firstElementChild?.firstElementChild as HTMLDivElement
    expect(image.style.backgroundImage).toContain('blob:wallpaper')
    act(() => root.unmount())
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:wallpaper')
    root = createRoot(host)
  })

  it.each(BUILTIN_WALLPAPERS)('renders the bundled $name image without a desktop port', (wallpaper) => {
    const values = {
      ...clientSettingsTable.defaults,
      canvasBackgroundImagePath: `builtin:${wallpaper.id}`,
    }
    installCanvasSettings({
      client: {
        get: (key) => values[key],
        subscribe: () => () => {},
      },
    })
    act(() => root.render(<CanvasBackgroundImage />))

    const image = host.firstElementChild?.firstElementChild as HTMLDivElement
    expect(image.style.backgroundImage).toContain(wallpaper.url)
  })

  it('uses the theme scrim token so themes can opt out', () => {
    act(() => root.render(<CanvasBackgroundImage />))

    const scrim = host.firstElementChild?.lastElementChild as HTMLDivElement
    expect(scrim.style.backgroundColor).toBe('var(--canvas-backdrop-scrim)')
  })
})
