import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clientSettingsTable, type ClientSettings } from '@kernel/settings/contract'
import { installCanvasSettings } from '../settings'
import CanvasBackgroundImage from './CanvasBackgroundImage'

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
})

describe('CanvasBackgroundImage', () => {
  it('uses the theme scrim token so themes can opt out', () => {
    act(() => root.render(<CanvasBackgroundImage />))

    const scrim = host.firstElementChild?.lastElementChild as HTMLDivElement
    expect(scrim.style.backgroundColor).toBe('var(--canvas-backdrop-scrim)')
  })
})
