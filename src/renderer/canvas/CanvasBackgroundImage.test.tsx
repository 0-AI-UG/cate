import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import CanvasBackgroundImage from './CanvasBackgroundImage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const initialSettingsState = useSettingsStore.getState()

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useSettingsStore.setState({
    canvasBackgroundImagePath: 'builtin:hillside',
    canvasBackgroundImageOpacity: 1,
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useSettingsStore.setState(initialSettingsState, true)
})

describe('CanvasBackgroundImage', () => {
  it('uses the theme scrim token so themes can opt out', () => {
    act(() => root.render(<CanvasBackgroundImage />))

    const scrim = host.firstElementChild?.lastElementChild as HTMLDivElement
    expect(scrim.style.backgroundColor).toBe('var(--canvas-backdrop-scrim)')
  })
})
