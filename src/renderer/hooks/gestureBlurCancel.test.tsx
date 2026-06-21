// =============================================================================
// Gesture blur/cancel scenarios — pins the window-level cleanup paths that the
// element-scoped handlers can't reach:
//   - a pan released OUTSIDE the canvas (or interrupted by Cmd+Tab) clears
//     isPanning, the grabbing cursor, and the refcounted body class;
//   - a window blur mid-group-drag stops translating the selection and drops
//     the body class;
//   - a window blur mid-resize tears down the window listeners and unpins the
//     forced cursor;
//   - Escape cancels an in-flight panel drag WITHOUT clearing the canvas
//     selection (and stops the keypress from reaching the global handler).
//
// Driven through real DOM events, mirroring useNodeResize.gesture.test.tsx and
// the drag harness.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Heavy renderer modules whose import-time side effects explode under jsdom —
// pulled in transitively via the canvas/app stores and the drag dispatcher.
vi.mock('../lib/terminal/terminalRegistry', () => ({
  terminalRegistry: { release: vi.fn() },
}))
vi.mock('../lib/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))

import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { StoreApi } from 'zustand'
import { useCanvasInteraction } from './useCanvasInteraction'
import { useNodeResize, type ResizeEdge } from './useNodeResize'
import { useGroupNodeDrag } from '../canvas/useGroupNodeDrag'
import {
  getOrCreateCanvasStoreForPanel,
  releaseCanvasStoreForPanel,
  type CanvasStore,
} from '../stores/canvasStore'
import { bodyClassRefCount } from '../lib/dom/bodyClassRefcount'
import type { PanelType, Point, Size } from '../../shared/types'
import { renderDragScene, type SceneApi } from '../drag/__tests__/harness'

// -----------------------------------------------------------------------------
// Shared scaffolding
// -----------------------------------------------------------------------------

let container: HTMLDivElement
let root: Root
let sceneCounter = 0
const releaseStore: Array<() => void> = []

let rafCb: FrameRequestCallback | null = null
function flushRaf() {
  const cb = rafCb
  rafCb = null
  if (cb) cb(0)
}

function freshStore(): StoreApi<CanvasStore> {
  const panelId = `gesture-test-${sceneCounter++}`
  const store = getOrCreateCanvasStoreForPanel(panelId)
  releaseStore.push(() => releaseCanvasStoreForPanel(panelId))
  act(() => store.getState().setZoomAndOffset(1, { x: 0, y: 0 }))
  return store
}

function addNode(store: StoreApi<CanvasStore>, id: string, origin: Point, size: Size, type: PanelType = 'editor') {
  act(() => {
    const created = store.getState().addNode(`panel-${id}`, type, origin, size)
    store.setState((s) => {
      const node = s.nodes[created]
      if (!node) return s
      const next = { ...s.nodes }
      delete next[created]
      next[id] = { ...node, id, origin: { ...origin }, size: { ...size } }
      return { ...s, nodes: next }
    })
  })
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCb = cb
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {
    rafCb = null
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container)
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  rafCb = null
  vi.unstubAllGlobals()
  document.body.classList.remove('canvas-interacting', 'canvas-dragging')
  while (releaseStore.length) releaseStore.pop()!()
})

// =============================================================================
// 1. Pan released outside the canvas / interrupted by blur
// =============================================================================

function PanProbe({ store }: { store: StoreApi<CanvasStore> }) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const { handleMouseDown } = useCanvasInteraction(ref, store)
  return (
    <div
      ref={ref}
      data-testid="canvas"
      style={{ width: 800, height: 600 }}
      onMouseDown={handleMouseDown}
    />
  )
}

function renderPanProbe(store: StoreApi<CanvasStore>): HTMLElement {
  act(() => root.render(<PanProbe store={store} />))
  const el = container.querySelector<HTMLElement>('[data-testid="canvas"]')
  if (!el) throw new Error('canvas not rendered')
  return el
}

function mouseDownOn(el: HTMLElement, button: number, clientX: number, clientY: number) {
  act(() => {
    el.dispatchEvent(
      new MouseEvent('mousedown', { button, clientX, clientY, bubbles: true }),
    )
  })
}

function windowMouseUp(clientX: number, clientY: number) {
  act(() => {
    window.dispatchEvent(new MouseEvent('mouseup', { clientX, clientY, bubbles: true }))
  })
}

function windowBlur() {
  act(() => window.dispatchEvent(new Event('blur')))
}

describe('pan — window-level cleanup', () => {
  it('clears the grabbing cursor + body class when the mouse is released OUTSIDE the canvas', () => {
    const store = freshStore()
    const el = renderPanProbe(store)

    // Right-button pan begins on the canvas.
    mouseDownOn(el, 2, 100, 100)
    expect(el.style.cursor).toBe('grabbing')
    expect(bodyClassRefCount('canvas-interacting')).toBe(1)
    expect(document.body.classList.contains('canvas-interacting')).toBe(true)

    // Mouse-up happens OFF the canvas div — only the window listener catches it.
    windowMouseUp(5000, 5000)

    expect(el.style.cursor).not.toBe('grabbing')
    expect(bodyClassRefCount('canvas-interacting')).toBe(0)
    expect(document.body.classList.contains('canvas-interacting')).toBe(false)
  })

  it('clears a stuck pan on window blur (Cmd+Tab mid-pan)', () => {
    const store = freshStore()
    const el = renderPanProbe(store)

    mouseDownOn(el, 1, 200, 200) // middle-button pan
    expect(bodyClassRefCount('canvas-interacting')).toBe(1)

    windowBlur()

    expect(el.style.cursor).not.toBe('grabbing')
    expect(bodyClassRefCount('canvas-interacting')).toBe(0)
    expect(document.body.classList.contains('canvas-interacting')).toBe(false)
  })

  it('does not double-release when both the element and window mouseup fire', () => {
    const store = freshStore()
    const el = renderPanProbe(store)

    mouseDownOn(el, 2, 100, 100)
    expect(bodyClassRefCount('canvas-interacting')).toBe(1)

    // Element-level React onMouseUp would normally also run for an in-canvas
    // release. Simulate both the element handler and the window fallback.
    act(() => {
      el.dispatchEvent(new MouseEvent('mouseup', { button: 2, clientX: 100, clientY: 100, bubbles: true }))
    })
    // (the window listener also catches the bubbled event above)
    expect(bodyClassRefCount('canvas-interacting')).toBe(0)
    expect(document.body.classList.contains('canvas-interacting')).toBe(false)
  })
})

// =============================================================================
// 2. Group drag — blur cancellation
// =============================================================================

function GroupDragProbe({
  nodeId,
  store,
  wasDragged,
  onResult,
}: {
  nodeId: string
  store: StoreApi<CanvasStore>
  wasDragged: { current: boolean }
  // Reports whether startGroupDrag took over the gesture (true) or bailed (false).
  onResult?: (took: boolean) => void
}) {
  const { startGroupDrag } = useGroupNodeDrag(nodeId, store, wasDragged)
  return (
    <div
      data-testid="group-handle"
      onMouseDown={(e) => {
        const took = startGroupDrag(e)
        onResult?.(took)
      }}
    />
  )
}

describe('group drag — blur cancellation', () => {
  it('stops translating the selection and drops the body class on blur', () => {
    const store = freshStore()
    addNode(store, 'A', { x: 0, y: 0 }, { width: 100, height: 100 })
    addNode(store, 'B', { x: 200, y: 0 }, { width: 100, height: 100 })
    act(() => store.getState().selectNodes(['A', 'B'], false))

    const wasDragged = { current: false }
    act(() => root.render(<GroupDragProbe nodeId="A" store={store} wasDragged={wasDragged} />))
    const handle = container.querySelector<HTMLElement>('[data-testid="group-handle"]')!

    act(() => {
      handle.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 50, clientY: 50, bubbles: true }))
    })

    // Move past the dead zone → both nodes translate, body class acquired.
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 80, bubbles: true })))
    expect(store.getState().nodes['A'].origin).toEqual({ x: 50, y: 30 })
    expect(store.getState().nodes['B'].origin).toEqual({ x: 250, y: 30 })
    expect(document.body.classList.contains('canvas-interacting')).toBe(true)

    // Cmd+Tab: window blurs. The capture listeners must detach.
    windowBlur()
    expect(document.body.classList.contains('canvas-interacting')).toBe(false)
    expect(bodyClassRefCount('canvas-interacting')).toBe(0)

    // A buttonless mousemove after returning must NOT keep translating.
    const before = { ...store.getState().nodes['A'].origin }
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, clientY: 400, bubbles: true })))
    expect(store.getState().nodes['A'].origin).toEqual(before)
  })

  it('moves the whole selection and marks wasDragged so the follow-up click cannot collapse it', () => {
    const store = freshStore()
    addNode(store, 'A', { x: 0, y: 0 }, { width: 100, height: 100 })
    addNode(store, 'B', { x: 200, y: 0 }, { width: 100, height: 100 })
    addNode(store, 'C', { x: 400, y: 0 }, { width: 100, height: 100 })
    act(() => store.getState().selectNodes(['A', 'B', 'C'], false))

    const wasDragged = { current: false }
    act(() => root.render(<GroupDragProbe nodeId="B" store={store} wasDragged={wasDragged} />))
    const handle = container.querySelector<HTMLElement>('[data-testid="group-handle"]')!

    // Grab B (a non-lead member) and drag past the dead zone.
    act(() => {
      handle.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 50, clientY: 50, bubbles: true }))
    })
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 90, clientY: 70, bubbles: true })))

    // Every selected node translated by the same delta — not just the grabbed one.
    expect(store.getState().nodes['A'].origin).toEqual({ x: 40, y: 20 })
    expect(store.getState().nodes['B'].origin).toEqual({ x: 240, y: 20 })
    expect(store.getState().nodes['C'].origin).toEqual({ x: 440, y: 20 })

    // The drag latches wasDragged — this is what makes the node's onClick bail
    // instead of running selectNodes([id])+focus and collapsing the group.
    expect(wasDragged.current).toBe(true)
    // Selection is untouched by the move itself.
    expect(store.getState().selection).toEqual(['A', 'B', 'C'])

    act(() => window.dispatchEvent(new MouseEvent('mouseup', { clientX: 90, clientY: 70, bubbles: true })))
  })

  it('does NOT take over (returns false) when the grabbed node is OUTSIDE the selection', () => {
    const store = freshStore()
    addNode(store, 'A', { x: 0, y: 0 }, { width: 100, height: 100 })
    addNode(store, 'B', { x: 200, y: 0 }, { width: 100, height: 100 })
    addNode(store, 'C', { x: 400, y: 0 }, { width: 100, height: 100 })
    // Multi-selection of A+B, but the user grabs C (not in the selection).
    act(() => store.getState().selectNodes(['A', 'B'], false))

    let took = true
    const wasDragged = { current: false }
    act(() =>
      root.render(
        <GroupDragProbe
          nodeId="C"
          store={store}
          wasDragged={wasDragged}
          onResult={(r) => { took = r }}
        />,
      ),
    )
    const handle = container.querySelector<HTMLElement>('[data-testid="group-handle"]')!

    act(() => {
      handle.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 50, clientY: 50, bubbles: true }))
    })

    // startGroupDrag bailed → the caller falls through to single-node dock drag.
    expect(took).toBe(false)
    expect(wasDragged.current).toBe(false)

    // No window listeners were installed: a window mousemove moves nothing.
    const aBefore = { ...store.getState().nodes['A'].origin }
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 200, bubbles: true })))
    expect(store.getState().nodes['A'].origin).toEqual(aBefore)
    expect(document.body.classList.contains('canvas-interacting')).toBe(false)
  })

  it('does NOT take over for a single-node selection (returns false → single-node drag)', () => {
    const store = freshStore()
    addNode(store, 'A', { x: 0, y: 0 }, { width: 100, height: 100 })
    addNode(store, 'B', { x: 200, y: 0 }, { width: 100, height: 100 })
    act(() => store.getState().selectNodes(['A'], false)) // selection of one

    let took = true
    const wasDragged = { current: false }
    act(() =>
      root.render(
        <GroupDragProbe
          nodeId="A"
          store={store}
          wasDragged={wasDragged}
          onResult={(r) => { took = r }}
        />,
      ),
    )
    const handle = container.querySelector<HTMLElement>('[data-testid="group-handle"]')!

    act(() => {
      handle.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 50, clientY: 50, bubbles: true }))
    })

    expect(took).toBe(false)
    // No takeover → a window mousemove must not translate anything.
    const aBefore = { ...store.getState().nodes['A'].origin }
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 200, bubbles: true })))
    expect(store.getState().nodes['A'].origin).toEqual(aBefore)
  })

  it('ignores non-left buttons (right-click on a group member returns false)', () => {
    const store = freshStore()
    addNode(store, 'A', { x: 0, y: 0 }, { width: 100, height: 100 })
    addNode(store, 'B', { x: 200, y: 0 }, { width: 100, height: 100 })
    act(() => store.getState().selectNodes(['A', 'B'], false))

    let took = true
    const wasDragged = { current: false }
    act(() =>
      root.render(
        <GroupDragProbe
          nodeId="A"
          store={store}
          wasDragged={wasDragged}
          onResult={(r) => { took = r }}
        />,
      ),
    )
    const handle = container.querySelector<HTMLElement>('[data-testid="group-handle"]')!

    act(() => {
      handle.dispatchEvent(new MouseEvent('mousedown', { button: 2, clientX: 50, clientY: 50, bubbles: true }))
    })

    expect(took).toBe(false)
  })

  it('grabbing the LEAD member also moves the whole selection', () => {
    const store = freshStore()
    addNode(store, 'A', { x: 0, y: 0 }, { width: 100, height: 100 })
    addNode(store, 'B', { x: 200, y: 0 }, { width: 100, height: 100 })
    // Lead = last element = B.
    act(() => store.getState().selectNodes(['A', 'B'], false))

    const wasDragged = { current: false }
    act(() => root.render(<GroupDragProbe nodeId="B" store={store} wasDragged={wasDragged} />))
    const handle = container.querySelector<HTMLElement>('[data-testid="group-handle"]')!

    act(() => {
      handle.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 50, clientY: 50, bubbles: true }))
    })
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 80, clientY: 70, bubbles: true })))

    expect(store.getState().nodes['A'].origin).toEqual({ x: 30, y: 20 })
    expect(store.getState().nodes['B'].origin).toEqual({ x: 230, y: 20 })
    expect(store.getState().selection).toEqual(['A', 'B'])

    act(() => window.dispatchEvent(new MouseEvent('mouseup', { clientX: 80, clientY: 70, bubbles: true })))
  })

  it('pushes history exactly ONCE per group drag (on the first real move)', () => {
    const store = freshStore()
    addNode(store, 'A', { x: 0, y: 0 }, { width: 100, height: 100 })
    addNode(store, 'B', { x: 200, y: 0 }, { width: 100, height: 100 })
    act(() => store.getState().selectNodes(['A', 'B'], false))
    act(() => store.getState().clearHistory())

    const wasDragged = { current: false }
    act(() => root.render(<GroupDragProbe nodeId="A" store={store} wasDragged={wasDragged} />))
    const handle = container.querySelector<HTMLElement>('[data-testid="group-handle"]')!

    act(() => {
      handle.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 50, clientY: 50, bubbles: true }))
    })
    // Three moves across the dead zone — history must still be pushed only once.
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: 60, bubbles: true })))
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 90, clientY: 80, bubbles: true })))
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 120, clientY: 100, bubbles: true })))

    expect(store.getState().history.length).toBe(1)
    // And that one snapshot captured the pre-move origins, so undo restores them.
    act(() => window.dispatchEvent(new MouseEvent('mouseup', { clientX: 120, clientY: 100, bubbles: true })))
    act(() => store.getState().undo())
    expect(store.getState().nodes['A'].origin).toEqual({ x: 0, y: 0 })
    expect(store.getState().nodes['B'].origin).toEqual({ x: 200, y: 0 })
  })

  it('a press WITHOUT crossing the dead zone neither moves nodes nor sets wasDragged', () => {
    const store = freshStore()
    addNode(store, 'A', { x: 0, y: 0 }, { width: 100, height: 100 })
    addNode(store, 'B', { x: 200, y: 0 }, { width: 100, height: 100 })
    act(() => store.getState().selectNodes(['A', 'B'], false))

    const wasDragged = { current: false }
    act(() => root.render(<GroupDragProbe nodeId="A" store={store} wasDragged={wasDragged} />))
    const handle = container.querySelector<HTMLElement>('[data-testid="group-handle"]')!

    act(() => {
      handle.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 50, clientY: 50, bubbles: true }))
    })
    // A 2px jitter — below DEAD_ZONE_PX (4).
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 51, clientY: 51, bubbles: true })))

    expect(store.getState().nodes['A'].origin).toEqual({ x: 0, y: 0 })
    expect(store.getState().nodes['B'].origin).toEqual({ x: 200, y: 0 })
    // No real drag → the follow-up click is allowed to collapse the selection.
    expect(wasDragged.current).toBe(false)
    expect(document.body.classList.contains('canvas-interacting')).toBe(false)

    act(() => window.dispatchEvent(new MouseEvent('mouseup', { clientX: 51, clientY: 51, bubbles: true })))
  })

  it('swallows wheel events while the group drag is live', () => {
    const store = freshStore()
    addNode(store, 'A', { x: 0, y: 0 }, { width: 100, height: 100 })
    addNode(store, 'B', { x: 200, y: 0 }, { width: 100, height: 100 })
    act(() => store.getState().selectNodes(['A', 'B'], false))

    const wasDragged = { current: false }
    act(() => root.render(<GroupDragProbe nodeId="A" store={store} wasDragged={wasDragged} />))
    const handle = container.querySelector<HTMLElement>('[data-testid="group-handle"]')!

    act(() => {
      handle.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 50, clientY: 50, bubbles: true }))
    })
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 80, bubbles: true })))

    const wheel = new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true })
    act(() => window.dispatchEvent(wheel))
    expect(wheel.defaultPrevented).toBe(true)

    // Cleanup.
    act(() => window.dispatchEvent(new MouseEvent('mouseup', { clientX: 100, clientY: 80, bubbles: true })))
    expect(bodyClassRefCount('canvas-interacting')).toBe(0)
  })
})

// =============================================================================
// 3. Resize — blur cancellation
// =============================================================================

function ResizeProbe({
  nodeId,
  edge,
  panelType,
  store,
}: {
  nodeId: string
  edge: ResizeEdge
  panelType: PanelType
  store: StoreApi<CanvasStore>
}) {
  const { handleResizeStart } = useNodeResize(nodeId, panelType, store)
  return <div data-testid="resize-handle" onMouseDown={(e) => handleResizeStart(e, edge)} />
}

describe('resize — blur cancellation', () => {
  it('detaches window listeners and unpins the cursor on blur', () => {
    const store = freshStore()
    addNode(store, 'A', { x: 100, y: 100 }, { width: 500, height: 400 })
    act(() => root.render(<ResizeProbe nodeId="A" edge="right" panelType="editor" store={store} />))
    const handle = container.querySelector<HTMLElement>('[data-testid="resize-handle"]')!

    act(() => {
      handle.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 600, clientY: 300, bubbles: true }))
    })
    expect(document.body.style.cursor).not.toBe('')
    expect(bodyClassRefCount('canvas-interacting')).toBe(1)

    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 650, clientY: 300, bubbles: true })))
    flushRaf()
    const widthAfterMove = store.getState().nodes['A'].size.width
    expect(widthAfterMove).toBe(550)

    // Cmd+Tab mid-resize.
    windowBlur()

    // Cursor unpinned, refcount released, no leftover pin <style> element.
    expect(document.body.style.cursor).toBe('')
    expect(bodyClassRefCount('canvas-interacting')).toBe(0)
    expect(document.querySelector('style')?.textContent ?? '').not.toContain('cursor:')

    // A stale mousemove after blur must NOT keep resizing.
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 900, clientY: 300, bubbles: true })))
    flushRaf()
    expect(store.getState().nodes['A'].size.width).toBe(widthAfterMove)
  })
})

// =============================================================================
// 4. Escape cancels a drag without clearing the canvas selection
// =============================================================================

describe('drag — Escape cancellation', () => {
  let scene: SceneApi | null = null

  afterEach(() => {
    scene?.unmount()
    scene = null
    document.body.classList.remove('canvas-interacting', 'canvas-dragging')
  })

  it('Escape aborts an in-flight drag and does NOT clear the selection (stops propagation)', () => {
    scene = renderDragScene({
      canvases: [{ panelId: 'c1', rect: { x: 0, y: 0, w: 1000, h: 800 } }],
      nodes: [
        { canvasPanelId: 'c1', nodeId: 'n1', origin: { x: 100, y: 100 }, size: { width: 200, height: 150 } },
        { canvasPanelId: 'c1', nodeId: 'n2', origin: { x: 400, y: 100 }, size: { width: 200, height: 150 } },
      ],
    })
    const store = scene.getCanvasStore('c1')
    act(() => store.getState().selectNodes(['n1', 'n2'], false))
    expect(store.getState().selection.length).toBe(2)

    // Begin and arm a drag.
    scene.mouse.downOnNode('n1')
    scene.mouse.dragBy({ x: 60, y: 40 })
    expect(scene.drag().isDragging).toBe(true)

    // A global Escape handler that would clear the selection if the keypress
    // reached it. useDragOp's capture-phase handler must stopPropagation first.
    let reachedGlobal = false
    const globalEsc = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        reachedGlobal = true
        store.getState().clearSelection()
      }
    }
    window.addEventListener('keydown', globalEsc)

    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => window.dispatchEvent(esc))

    window.removeEventListener('keydown', globalEsc)

    // Drag was cancelled.
    expect(scene.drag().isDragging).toBe(false)
    // The keypress was stopped before the global handler — selection intact.
    expect(reachedGlobal).toBe(false)
    expect(store.getState().selection.length).toBe(2)
    expect(esc.defaultPrevented).toBe(true)
  })
})
