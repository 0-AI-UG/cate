import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CanvasViewProvider } from '../context'
import { createCanvasView, type CanvasViewStore } from '../store'
import { canvasDocument, fakeDocument } from '../testing.canvas'
import CanvasGrid from './CanvasGrid'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let store: CanvasViewStore

beforeEach(() => {
  store = createCanvasView({ workspaceId: 'ws', canvasId: 'c1', document: fakeDocument(canvasDocument([])), animate: false })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  store.getState().dispose()
  host.remove()
})

it.each([0.25, 0.65, 1, 1.23])('pans without changing the painted grid or exposing its edges at zoom %s', (zoom) => {
  act(() => {
    store.getState().setZoom(zoom)
    root.render(<CanvasViewProvider store={store}><CanvasGrid containerWidth={800} containerHeight={600} /></CanvasViewProvider>)
  })
  const grid = host.querySelector<HTMLElement>('[data-canvas-grid]')!
  const step = parseFloat(grid.style.backgroundSize)
  const background = grid.style.backgroundPosition
  const image = grid.style.backgroundImage
  for (const offset of [{ x: 19.99, y: -20.01 }, { x: 20.01, y: -19.99 }, { x: -100023, y: 999999 }, { x: 0.5, y: -0.5 }]) {
    act(() => store.getState().setViewportOffset(offset))
    const [, x, y] = grid.style.transform.match(/translate\(([-\d.e]+)px, ([-\d.e]+)px\)/)!
    const dx = Number(x), dy = Number(y)
    // Repeating the same picture at another whole period preserves phase.
    expect((dx - offset.x) / step).toBeCloseTo(Math.round((dx - offset.x) / step), 8)
    expect((dy - offset.y) / step).toBeCloseTo(Math.round((dy - offset.y) / step), 8)
    expect(parseFloat(grid.style.left) + dx).toBeLessThanOrEqual(0)
    expect(parseFloat(grid.style.top) + dy).toBeLessThanOrEqual(0)
    expect(parseFloat(grid.style.left) + dx + parseFloat(grid.style.width)).toBeGreaterThanOrEqual(800)
    expect(parseFloat(grid.style.top) + dy + parseFloat(grid.style.height)).toBeGreaterThanOrEqual(600)
    expect(grid.style.backgroundPosition).toBe(background)
    expect(grid.style.backgroundImage).toBe(image)
  }
})
