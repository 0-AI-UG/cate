import React, { act } from 'react'
import { createPortal } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanelType } from '../../shared/types'

vi.mock('../hooks/useAutoFocusLargestVisible', () => ({ useAutoFocusLargestVisible: vi.fn() }))
vi.mock('./CanvasGrid', () => ({ default: () => null }))
vi.mock('./CanvasBackgroundImage', () => ({ default: () => null }))
vi.mock('./SnapGuides', () => ({ default: () => null }))
vi.mock('./worktree', () => ({ WorktreeTerritoryLayer: () => null }))

import Canvas from './Canvas'
import { CanvasStoreProvider } from '../stores/CanvasStoreContext'
import { createCanvasStore } from '../stores/canvasStore'
import { focusedNodeId } from '../stores/canvas/selectionModel'
import { useUIStore } from '../stores/uiStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let store: ReturnType<typeof createCanvasStore>
let seed: string
const originalCamera = { zoomLevel: 1, viewportOffset: { x: 100, y: 100 } }

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 800,
    width: 1200, height: 800, toJSON() {},
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  store = createCanvasStore()
  seed = store.getState().addNode('existing', 'terminal', { x: 0, y: 0 }, { width: 640, height: 400 })
  store.getState().focusNode(seed)
  store.setState(originalCamera)
  useUIStore.setState({ activeTool: 'select', marquee: null })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useUIStore.setState({ activeTool: 'select', marquee: null })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderToolbar(onClick: () => void, portalledMenu = false) {
  const button = <button data-action onClick={onClick}>Open target picker</button>
  act(() => root.render(
    <CanvasStoreProvider store={store}>
      <Canvas panelId="test-canvas" overlayChildren={portalledMenu ? createPortal(button, document.body) : button} />
    </CanvasStoreProvider>,
  ))
  act(() => store.getState().setContainerSize({ width: 1200, height: 800 }))
}

// Include mouseup: the background marquee handler clears focus there, before
// the click handler starts placement. A click-only test misses the regression.
function click(element: Element) {
  for (const type of ['mousedown', 'mouseup', 'click']) {
    act(() => { element.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: 900, clientY: 650 })) })
  }
}

function startTarget(availability: 'new' | 'existing' | 'both', onSelected = vi.fn(), onCancelled = vi.fn()) {
  return store.getState().beginPanelTarget({
    panelType: 'review', availability,
    existing: [{ panelId: 'existing', title: 'Existing panel' }],
    onSelected, onCancelled,
  })
}

describe('canvas chrome and panel-target gestures', () => {
  const panelTypes: PanelType[] = ['terminal', 'browser', 'editor', 'agent', 'document', 'review']
  it.each(panelTypes.flatMap((panelType) => [0.75, 1, 1.5].map((zoom) => ({ panelType, zoom }))))(
    '$panelType creation at zoom $zoom preserves focus and offers multiple recommendations', ({ panelType, zoom }) => {
      store.setState({ zoomLevel: zoom })
      renderToolbar(() => store.getState().beginPanelTarget({
        panelId: 'new', panelType, availability: 'new', existing: [], onCancelled: vi.fn(),
      }))
      click(document.querySelector('[data-action]')!)
      expect(focusedNodeId(store.getState())).toBe(seed)
      expect(store.getState().pendingPanelTarget!.candidates.length).toBeGreaterThan(1)
      expect(store.getState().zoomLevel).toBeLessThan(zoom)
      act(() => store.getState().cancelPanelTarget())
      expect(store.getState()).toMatchObject({ ...originalCamera, zoomLevel: zoom })
    },
  )

  it.each(['new', 'existing', 'both'] as const)('preserves focus when a portalled menu starts a %s target request', (availability) => {
    renderToolbar(() => startTarget(availability), true)
    click(document.querySelector('[data-action]')!)
    expect(focusedNodeId(store.getState())).toBe(seed)
    expect(store.getState().pendingPanelTarget?.availability).toBe(availability)
  })

  it.each(['new', 'existing', 'both'] as const)('selects a %s target without background deselection', (availability) => {
    const selected = vi.fn()
    renderToolbar(vi.fn())
    act(() => startTarget(availability, selected))
    const target = availability === 'new'
      ? document.querySelector('[data-ghost-candidate="0"]')!
      : document.querySelector('button[data-panel-target]:not([data-ghost-candidate])')!
    click(target)
    expect(selected).toHaveBeenCalledOnce()
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ kind: availability === 'new' ? 'new' : 'existing' }))
    expect(focusedNodeId(store.getState())).toBe(seed)
    expect(store.getState().pendingPanelTarget).toBeNull()
    expect(store.getState()).toMatchObject(originalCamera)
  })

  it('commits free placement without clearing focus or beginning a marquee', () => {
    const selected = vi.fn()
    renderToolbar(vi.fn())
    act(() => startTarget('both', selected))
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true })))
    click(document.querySelector('[data-placement-surface]')!)
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ kind: 'new' }))
    expect(focusedNodeId(store.getState())).toBe(seed)
    expect(useUIStore.getState().marquee).toBeNull()
    expect(store.getState()).toMatchObject(originalCamera)
  })

  it('keeps a pending target while using unrelated chrome, but cancels on actual background clicks', () => {
    const cancelled = vi.fn()
    renderToolbar(vi.fn())
    act(() => startTarget('both', vi.fn(), cancelled))
    click(document.querySelector('[data-action]')!)
    expect(cancelled).not.toHaveBeenCalled()
    expect(focusedNodeId(store.getState())).toBe(seed)
    click(container.querySelector('[data-canvas-container]')!)
    expect(cancelled).toHaveBeenCalledOnce()
    expect(store.getState()).toMatchObject(originalCamera)
  })

  it('does not pan or marquee when dragging chrome with the hand tool', () => {
    renderToolbar(vi.fn())
    act(() => useUIStore.setState({ activeTool: 'hand' }))
    const button = document.querySelector('[data-action]')!
    act(() => {
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 500, clientY: 500 }))
      button.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 600, clientY: 600 }))
      button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 600, clientY: 600 }))
    })
    expect(store.getState()).toMatchObject(originalCamera)
    expect(focusedNodeId(store.getState())).toBe(seed)
    expect(useUIStore.getState().marquee).toBeNull()
  })
})
