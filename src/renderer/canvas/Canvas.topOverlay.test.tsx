import React, { act } from 'react'
import { createPortal } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../hooks/useCanvasInteraction', () => ({
  useCanvasInteraction: () => ({
    handleWheel: vi.fn(),
    handleMouseDown: vi.fn(),
    handleMouseMove: vi.fn(),
    handleMouseUp: vi.fn(),
    handleContextMenu: vi.fn(),
    canvasContextMenu: null,
    closeCanvasContextMenu: vi.fn(),
  }),
}))
vi.mock('../hooks/useAutoFocusLargestVisible', () => ({ useAutoFocusLargestVisible: vi.fn() }))
vi.mock('./CanvasGrid', () => ({ default: () => null }))
vi.mock('./CanvasBackgroundImage', () => ({ default: () => null }))
vi.mock('./SnapGuides', () => ({ default: () => null }))
vi.mock('./PanelTargetLayer', () => ({ default: () => null }))
vi.mock('./worktree', () => ({ WorktreeTerritoryLayer: () => null }))

import Canvas from './Canvas'
import { CanvasTopOverlayContext } from './CanvasTopOverlayContext'
import { CanvasStoreProvider } from '../stores/CanvasStoreContext'
import { createCanvasStore } from '../stores/canvasStore'
import { useUIStore } from '../stores/uiStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function PortalledGlowProbe(): React.ReactElement | null {
  const target = React.useContext(CanvasTopOverlayContext)
  return target ? createPortal(<div data-glow-probe />, target) : null
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useUIStore.setState({
    activeTool: 'select',
    marquee: { startX: 10, startY: 20, currentX: 60, currentY: 80 },
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useUIStore.setState({ marquee: null })
  vi.unstubAllGlobals()
})

describe('Canvas top overlay', () => {
  it('preserves viewport measurements and pan through maximize and restore', () => {
    const observers: ResizeObserverCallback[] = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { observers.push(callback) }
      observe() {}
      disconnect() {}
    })
    let bounds = new DOMRect(0, 0, 1000, 600)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => bounds)
    const store = createCanvasStore()
    act(() => root.render(<CanvasStoreProvider store={store}><Canvas panelId="canvas-one" /></CanvasStoreProvider>))
    const notify = (width: number, height: number) => act(() => {
      bounds = new DOMRect(0, 0, width, height)
      for (const callback of observers) callback([{ contentRect: bounds } as ResizeObserverEntry], {} as ResizeObserver)
    })
    notify(1000, 600)
    act(() => store.getState().setZoomAndOffset(0.5, { x: 20, y: 30 }))
    let id = ''
    act(() => {
      id = store.getState().addNode('terminal', 'terminal', { x: 200, y: 200 }, { width: 640, height: 400 })
      store.getState().toggleMaximize(id, { width: 1100, height: 700 })
    })
    notify(1000, 1)
    notify(1100, 700)
    expect(store.getState().containerSize).toEqual({ width: 1000, height: 600 })
    act(() => store.getState().toggleMaximize(id, { width: 1100, height: 700 }))
    notify(1000, 600)
    expect(store.getState().viewportOffset).toEqual({ x: 20, y: 30 })
    expect(store.getState().zoomLevel).toBe(0.5)
  })

  it('portals above-panel canvas chrome into one transformed screen-space layer', () => {
    const store = createCanvasStore()
    act(() => store.getState().setZoomAndOffset(2, { x: 30, y: 40 }))

    act(() => root.render(
      <CanvasStoreProvider store={store}>
        <Canvas panelId="canvas-one" overlayChildren={<div data-toolbar-probe />}>
          <PortalledGlowProbe />
        </Canvas>
      </CanvasStoreProvider>,
    ))

    const overlay = document.body.querySelector<HTMLElement>('[data-canvas-top-overlay="canvas-one"]')!
    const marquee = overlay.querySelector<HTMLElement>('[data-canvas-marquee]')!
    const world = marquee.parentElement!
    expect(overlay.style.position).toBe('fixed')
    expect(overlay.style.zIndex).toBe('1')
    expect(world.style.transform).toBe('scale(2) translate(15px, 20px)')
    expect(overlay.querySelector('[data-glow-probe]')).not.toBeNull()
    expect(overlay.querySelector('[data-toolbar-probe]')).not.toBeNull()
    expect(container.querySelector('[data-canvas-marquee]')).toBeNull()

    const nodeId = store.getState().addNode('editor', 'editor', { x: 100, y: 100 }, { width: 400, height: 300 })
    act(() => store.getState().toggleMaximize(nodeId, { width: 1280, height: 800 }))
    expect(overlay.hidden).toBe(true)
    act(() => store.getState().toggleMaximize(nodeId, { width: 1280, height: 800 }))
    expect(overlay.hidden).toBe(false)
    expect(world.style.transform).toBe('scale(2) translate(15px, 20px)')
  })
})
