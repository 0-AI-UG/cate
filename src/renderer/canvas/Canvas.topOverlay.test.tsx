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
vi.mock('./GhostPlacementLayer', () => ({ default: () => null }))
vi.mock('./placementViz/PlacementVizOverlay', () => ({ default: () => null }))
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
  })
})
