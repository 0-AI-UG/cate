// =============================================================================
// useCanvasInteraction — gesture behavior tests.
//
// Pins the canvas pan/zoom feel end-to-end through real DOM events:
//   - wheel-intent disambiguation (Cmd/Ctrl+scroll & pinch → zoom, trackpad
//     two-finger scroll → pan, physical mouse wheel → zoom under the select
//     tool / pan under the hand tool);
//   - cursor-anchored zoom (the canvas point under the cursor must not move in
//     view-space) and ZOOM_MIN/ZOOM_MAX clamping;
//   - right-click drag panning, the 4-px context-menu threshold, and the
//     context-menu canvas-coordinate math under non-default zoom/offset;
//   - momentum coasting after a fast right-drag (decays to a stop; killed
//     instantly by a new drag or a zoom);
//   - rAF lifecycle (wheel-pan throttling, unmount mid-animation).
//
// Driven like useNodeResize.gesture.test.tsx: a real React tree, native events
// dispatched on the rendered canvas div (wheel via a passive:false native
// listener, mirroring Canvas.tsx's wiring), a manually pumped
// requestAnimationFrame stub, and a fake performance.now clock so the
// velocity-sample windows and inertia decay are deterministic.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Heavy renderer modules whose import-time side effects explode under jsdom —
// pulled in transitively via the canvas store. Mirrors the sibling gesture tests.
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
import {
  getOrCreateCanvasStoreForPanel,
  releaseCanvasStoreForPanel,
  type CanvasStore,
} from '../stores/canvasStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useDragStore } from '../drag'
import { viewToCanvas } from '../lib/canvas/coordinates'
import { focusedNodeId } from '../stores/canvas/selectionModel'
import { ZOOM_MIN, ZOOM_MAX } from '../../shared/types'
import type { Point } from '../../shared/types'

// createRoot + act needs this flag, or React logs "environment is not
// configured to support act(...)" to console.error — which the unmount test
// asserts stays clean.
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// -----------------------------------------------------------------------------
// rAF pump — multi-slot (the hook can have a zoom loop, a wheel-pan throttle
// commit, and an inertia loop alive in the same test). cancelAnimationFrame
// must only kill the handle it's given, otherwise "kill momentum on zoom"
// couldn't be told apart from "kill everything".
// -----------------------------------------------------------------------------

let rafCallbacks = new Map<number, FrameRequestCallback>()
let nextRafId = 1

/** Fake clock driving performance.now(); advanced by pumpFrame. */
let fakeNow = 1000

function pendingRafCount() {
  return rafCallbacks.size
}

/** Advance the clock and run every callback that was pending BEFORE the pump
 *  (callbacks scheduled during the pump wait for the next frame, like real rAF). */
function pumpFrame(advanceMs = 16) {
  fakeNow += advanceMs
  const cbs = [...rafCallbacks.values()]
  rafCallbacks.clear()
  for (const cb of cbs) {
    act(() => cb(fakeNow))
  }
}

function pumpUntilIdle(maxFrames = 400) {
  let n = 0
  while (rafCallbacks.size > 0 && n < maxFrames) {
    pumpFrame()
    n++
  }
  if (rafCallbacks.size > 0) throw new Error(`rAF did not settle within ${maxFrames} frames`)
  return n
}

// -----------------------------------------------------------------------------
// Scene
// -----------------------------------------------------------------------------

let container: HTMLDivElement
let root: Root
let rootUnmounted = false
let sceneCounter = 0
const releaseStore: Array<() => void> = []

type Handlers = ReturnType<typeof useCanvasInteraction>

function CanvasProbe({
  store,
  expose,
}: {
  store: StoreApi<CanvasStore>
  expose: { current: Handlers | null }
}) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const handlers = useCanvasInteraction(ref, store)
  expose.current = handlers

  // Mirror Canvas.tsx: handleWheel is wired through a NATIVE wheel listener
  // (capture, passive:false) so preventDefault works, with the event cast to
  // React's type.
  const wheelRef = React.useRef(handlers.handleWheel)
  wheelRef.current = handlers.handleWheel
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) =>
      wheelRef.current(e as unknown as React.WheelEvent<HTMLDivElement>)
    el.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => el.removeEventListener('wheel', onWheel, { capture: true })
  }, [])

  return (
    <div
      ref={ref}
      data-testid="canvas"
      onMouseDown={handlers.handleMouseDown}
      onMouseMove={handlers.handleMouseMove}
      onMouseUp={handlers.handleMouseUp}
      onContextMenu={handlers.handleContextMenu}
    >
      {/* A fake node — right-clicks targeted here must NOT open the canvas menu. */}
      <div data-node-id="node-A" data-testid="node" />
    </div>
  )
}

function setupScene(init?: { zoom?: number; offset?: Point }) {
  const panelId = `canvas-interaction-test-${sceneCounter++}`
  const store = getOrCreateCanvasStoreForPanel(panelId)
  releaseStore.push(() => releaseCanvasStoreForPanel(panelId))
  act(() => {
    store.getState().setZoomAndOffset(init?.zoom ?? 1, init?.offset ?? { x: 0, y: 0 })
  })

  const expose: { current: Handlers | null } = { current: null }
  act(() => {
    root.render(<CanvasProbe store={store} expose={expose} />)
  })
  const el = container.querySelector<HTMLElement>('[data-testid="canvas"]')
  if (!el) throw new Error('canvas not rendered')
  return { store, el, expose }
}

// -----------------------------------------------------------------------------
// Event drivers
// -----------------------------------------------------------------------------

interface WheelOpts {
  deltaX?: number
  deltaY?: number
  metaKey?: boolean
  ctrlKey?: boolean
  clientX?: number
  clientY?: number
  /** Chromium's non-standard physical-wheel marker (multiples of 120). Leave
   *  undefined to simulate a trackpad. */
  wheelDeltaY?: number
}

function wheel(el: HTMLElement, opts: WheelOpts): WheelEvent {
  const e = new WheelEvent('wheel', {
    deltaX: opts.deltaX ?? 0,
    deltaY: opts.deltaY ?? 0,
    deltaMode: 0,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    clientX: opts.clientX ?? 0,
    clientY: opts.clientY ?? 0,
    bubbles: true,
    cancelable: true,
  })
  if (opts.wheelDeltaY !== undefined) {
    Object.defineProperty(e, 'wheelDeltaY', { value: opts.wheelDeltaY })
  }
  act(() => {
    el.dispatchEvent(e)
  })
  return e
}

function mouse(el: HTMLElement, type: string, button: number, clientX: number, clientY: number) {
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { button, clientX, clientY, bubbles: true }))
  })
}

const rightDown = (el: HTMLElement, x: number, y: number) => mouse(el, 'mousedown', 2, x, y)
const moveTo = (el: HTMLElement, x: number, y: number) => mouse(el, 'mousemove', 2, x, y)
const rightUp = (el: HTMLElement, x: number, y: number) => mouse(el, 'mouseup', 2, x, y)

/** Expected anchored offset for a zoom to `targetZoom` around view point `v`,
 *  given the state at the moment the gesture began. */
function anchoredOffset(v: Point, zoom: number, offset: Point, targetZoom: number): Point {
  const c = viewToCanvas(v, zoom, offset)
  return { x: v.x - c.x * targetZoom, y: v.y - c.y * targetZoom }
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  rafCallbacks = new Map()
  nextRafId = 1
  fakeNow = 1000
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextRafId++
    rafCallbacks.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafCallbacks.delete(id)
  })
  vi.spyOn(performance, 'now').mockImplementation(() => fakeNow)

  container = document.createElement('div')
  document.body.appendChild(container)
  rootUnmounted = false
  act(() => {
    root = createRoot(container)
  })

  useSettingsStore.setState({ zoomSpeed: 1.0 })
  useUIStore.setState({ activeTool: 'select', marquee: null })
  useDragStore.setState({ isDragging: false })
})

afterEach(() => {
  if (!rootUnmounted) act(() => root.unmount())
  container.remove()
  rafCallbacks.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.classList.remove('canvas-interacting', 'canvas-dragging')
  useUIStore.setState({ activeTool: 'select', marquee: null })
  useDragStore.setState({ isDragging: false })
  while (releaseStore.length) releaseStore.pop()!()
})

// =============================================================================
// 1. Wheel intent — zoom vs pan
// =============================================================================

describe('wheel intent', () => {
  it('Cmd+trackpad-scroll zooms about the cursor: zoom changes, the canvas point under the cursor stays fixed', () => {
    const { store, el } = setupScene()
    const cursor = { x: 400, y: 300 }
    const before = store.getState()

    // deltaY -100 → target = 1 + 100*0.01*zoomSpeed = 2.0
    const e = wheel(el, { deltaY: -100, metaKey: true, clientX: cursor.x, clientY: cursor.y })
    expect(e.defaultPrevented).toBe(true)

    // Smooth zoom is rAF-driven; nothing applied synchronously beyond frame 0.
    pumpUntilIdle()

    const after = store.getState()
    expect(after.zoomLevel).toBeCloseTo(2.0, 6)
    // Anchor invariance: the canvas point under the cursor before == after.
    const canvasBefore = viewToCanvas(cursor, before.zoomLevel, before.viewportOffset)
    const canvasAfter = viewToCanvas(cursor, after.zoomLevel, after.viewportOffset)
    expect(canvasAfter.x).toBeCloseTo(canvasBefore.x, 6)
    expect(canvasAfter.y).toBeCloseTo(canvasBefore.y, 6)
    // Exact anchored offset: (400,300) at zoom 1/offset 0 → offset (-400,-300).
    expect(after.viewportOffset.x).toBeCloseTo(-400, 6)
    expect(after.viewportOffset.y).toBeCloseTo(-300, 6)
  })

  it('trackpad pinch (ctrlKey synthesized by Chromium) zooms about the cursor', () => {
    const { store, el } = setupScene()
    const cursor = { x: 100, y: 50 }

    wheel(el, { deltaY: -50, ctrlKey: true, clientX: cursor.x, clientY: cursor.y })
    pumpUntilIdle()

    const after = store.getState()
    expect(after.zoomLevel).toBeCloseTo(1.5, 6)
    const expected = anchoredOffset(cursor, 1, { x: 0, y: 0 }, 1.5)
    expect(after.viewportOffset.x).toBeCloseTo(expected.x, 6)
    expect(after.viewportOffset.y).toBeCloseTo(expected.y, 6)
  })

  it('clamps zoom at ZOOM_MAX (huge zoom-in) and ZOOM_MIN (huge zoom-out)', () => {
    const { store, el } = setupScene()

    // 1 + 1000*0.01 = 11 → clamped to ZOOM_MAX.
    wheel(el, { deltaY: -1000, metaKey: true, clientX: 200, clientY: 200 })
    pumpUntilIdle()
    expect(store.getState().zoomLevel).toBeCloseTo(ZOOM_MAX, 6)

    // From 3.0: 3 - 1000*0.01 = -7 → clamped to ZOOM_MIN.
    wheel(el, { deltaY: 1000, metaKey: true, clientX: 200, clientY: 200 })
    pumpUntilIdle()
    expect(store.getState().zoomLevel).toBeCloseTo(ZOOM_MIN, 6)
  })

  it('rapid zoom wheels accumulate from the in-flight target, not the live zoom', () => {
    const { store, el } = setupScene()

    // Two -50 deltas before any frame runs: 1.0 → target 1.5 → target 2.0.
    wheel(el, { deltaY: -50, metaKey: true, clientX: 300, clientY: 300 })
    wheel(el, { deltaY: -50, metaKey: true, clientX: 300, clientY: 300 })
    pumpUntilIdle()

    expect(store.getState().zoomLevel).toBeCloseTo(2.0, 6)
  })

  it('plain trackpad two-finger scroll pans (rAF-throttled, deltas coalesced into one commit)', () => {
    const { store, el } = setupScene()

    // No modifiers, no wheelDeltaY, deltaMode 0 → classified as trackpad → pan.
    const e1 = wheel(el, { deltaX: 30, deltaY: 50 })
    expect(e1.defaultPrevented).toBe(true)
    expect(document.body.classList.contains('canvas-interacting')).toBe(true)

    // Second wheel before the frame fires — must coalesce into ONE rAF commit.
    wheel(el, { deltaX: -10, deltaY: 20 })
    expect(pendingRafCount()).toBe(1)
    // Nothing applied until the frame runs.
    expect(store.getState().viewportOffset).toEqual({ x: 0, y: 0 })

    pumpFrame()
    // offset -= summed deltas: (30-10, 50+20) = (20, 70).
    expect(store.getState().viewportOffset).toEqual({ x: -20, y: -70 })
    expect(store.getState().zoomLevel).toBe(1)

    // Throttle is drained — extra frames change nothing.
    pumpFrame()
    expect(store.getState().viewportOffset).toEqual({ x: -20, y: -70 })
  })

  it('releases the canvas-interacting body class ~150ms after the wheel goes quiet', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { el } = setupScene()

    wheel(el, { deltaX: 0, deltaY: 40 })
    pumpFrame()
    expect(document.body.classList.contains('canvas-interacting')).toBe(true)

    // Another wheel within the quiet window re-arms the timer.
    act(() => vi.advanceTimersByTime(100))
    wheel(el, { deltaX: 0, deltaY: 10 })
    act(() => vi.advanceTimersByTime(100))
    expect(document.body.classList.contains('canvas-interacting')).toBe(true)

    act(() => vi.advanceTimersByTime(60)) // past 150ms since the last wheel
    expect(document.body.classList.contains('canvas-interacting')).toBe(false)
  })

  it('physical mouse wheel zooms proportionally under the select tool', () => {
    const { store, el } = setupScene()
    const cursor = { x: 200, y: 150 }

    // wheelDeltaY ±120 + deltaX 0 → physical mouse notch → zoom, not pan.
    wheel(el, { deltaY: -100, wheelDeltaY: 120, clientX: cursor.x, clientY: cursor.y })
    pumpUntilIdle()

    const after = store.getState()
    // One notch: 1 * (1 + 0.15 * zoomSpeed) = 1.15, anchored at the cursor.
    expect(after.zoomLevel).toBeCloseTo(1.15, 6)
    const expected = anchoredOffset(cursor, 1, { x: 0, y: 0 }, 1.15)
    expect(after.viewportOffset.x).toBeCloseTo(expected.x, 6)
    expect(after.viewportOffset.y).toBeCloseTo(expected.y, 6)
  })

  it('physical mouse wheel PANS under the hand tool (no zoom)', () => {
    useUIStore.setState({ activeTool: 'hand' })
    const { store, el } = setupScene()

    wheel(el, { deltaY: 100, wheelDeltaY: -120 })
    pumpFrame()

    expect(store.getState().zoomLevel).toBe(1)
    expect(store.getState().viewportOffset).toEqual({ x: 0, y: -100 })
  })

  it('swallows wheel input while a marquee selection is in progress', () => {
    const { store, el } = setupScene()
    useUIStore.setState({ marquee: { startX: 0, startY: 0, currentX: 10, currentY: 10 } })

    const e = wheel(el, { deltaY: -100, metaKey: true, clientX: 100, clientY: 100 })

    expect(e.defaultPrevented).toBe(true)
    expect(pendingRafCount()).toBe(0)
    expect(store.getState().zoomLevel).toBe(1)
    expect(store.getState().viewportOffset).toEqual({ x: 0, y: 0 })
  })

  it('swallows wheel input while a dock-drag is active', () => {
    const { store, el } = setupScene()
    act(() => {
      useDragStore.setState({ isDragging: true })
    })

    const zoomWheel = wheel(el, { deltaY: -100, metaKey: true, clientX: 100, clientY: 100 })
    const panWheel = wheel(el, { deltaX: 20, deltaY: 30 })

    expect(zoomWheel.defaultPrevented).toBe(true)
    expect(panWheel.defaultPrevented).toBe(true)
    expect(pendingRafCount()).toBe(0)
    expect(store.getState().zoomLevel).toBe(1)
    expect(store.getState().viewportOffset).toEqual({ x: 0, y: 0 })
  })
})

// =============================================================================
// 2. Right-click drag panning
// =============================================================================

describe('right-drag panning', () => {
  it('pans the viewport by the cursor delta past the threshold; release ends the pan', () => {
    const { store, el } = setupScene()

    rightDown(el, 100, 100)
    moveTo(el, 150, 130) // 58px — far past the 4px threshold
    expect(store.getState().viewportOffset).toEqual({ x: 50, y: 30 })

    moveTo(el, 160, 120) // incremental: +10, -10
    expect(store.getState().viewportOffset).toEqual({ x: 60, y: 20 })

    rightUp(el, 160, 120)
    // Dragged → no context menu, no coast (only 2 slow samples is fine, but
    // assert the pan state itself is torn down):
    const after = { ...store.getState().viewportOffset }
    moveTo(el, 400, 400) // mousemove after release must NOT pan
    expect(store.getState().viewportOffset).toEqual(after)
  })

  it('sub-threshold movement still opens the context menu on release (viewport tracks the tiny delta 1:1)', () => {
    const { store, el, expose } = setupScene()

    rightDown(el, 100, 100)
    moveTo(el, 102, 101) // √5 ≈ 2.24px — below the 4px drag threshold
    // BUG?: the threshold only gates the context menu, not the pan itself —
    // the viewport already moved by the sub-threshold delta. Expected: a
    // movement that's too small to count as a "drag" arguably shouldn't pan at
    // all; actual: setViewportOffset runs on every mousemove while panning.
    // Documented as current behavior (the menu math below compensates exactly).
    expect(store.getState().viewportOffset).toEqual({ x: 2, y: 1 })

    rightUp(el, 102, 101)

    // Not a drag → the canvas context menu opens at the release point...
    const menu = expose.current!.canvasContextMenu
    expect(menu).not.toBeNull()
    expect(menu!.x).toBe(102)
    expect(menu!.y).toBe(101)
    // ...and the canvasPoint accounts for the (slightly moved) offset:
    // ((102-2)/1, (101-1)/1) = the original press point.
    expect(menu!.canvasPoint).toEqual({ x: 100, y: 100 })
    // The pan itself is torn down.
    expect(document.body.classList.contains('canvas-interacting')).toBe(false)
  })

  it('does not open the context menu after a real drag', () => {
    const { el, expose } = setupScene()

    rightDown(el, 100, 100)
    moveTo(el, 200, 100)
    rightUp(el, 200, 100)

    expect(expose.current!.canvasContextMenu).toBeNull()
  })
})

// =============================================================================
// 2b. Marquee selection
// =============================================================================

const leftDown = (el: HTMLElement, x: number, y: number) => mouse(el, 'mousedown', 0, x, y)
const winMove = (x: number, y: number) =>
  act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true })))
const winUp = (x: number, y: number) =>
  act(() =>
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: x, clientY: y, bubbles: true })),
  )

describe('marquee selection', () => {
  // Regression: the marquee must suppress iframe/webview/monaco/xterm hit-testing
  // (via the shared `canvas-interacting` body class) like every other canvas
  // gesture. Without it, the cursor crossing onto the FOCUSED panel — whose dim
  // overlay is pointer-events:none — lets that panel's content swallow the
  // window-level mousemove/mouseup, freezing and mis-selecting the marquee.
  it('holds canvas-interacting for the duration of a marquee drag', () => {
    const { el } = setupScene()

    leftDown(el, 100, 100)
    // A bare press (no drag yet) must not suppress panel hit-testing.
    expect(document.body.classList.contains('canvas-interacting')).toBe(false)

    winMove(120, 120) // > 4px → the drag (and marquee) begins
    expect(document.body.classList.contains('canvas-interacting')).toBe(true)

    winMove(180, 160)
    expect(document.body.classList.contains('canvas-interacting')).toBe(true)

    winUp(180, 160)
    expect(document.body.classList.contains('canvas-interacting')).toBe(false)
  })

  it('does not leave canvas-interacting set after a click without a drag', () => {
    const { el } = setupScene()

    leftDown(el, 100, 100)
    winUp(101, 101) // < 4px → not a drag
    expect(document.body.classList.contains('canvas-interacting')).toBe(false)
  })

  it('releases canvas-interacting if the window blurs mid-marquee', () => {
    const { el } = setupScene()

    leftDown(el, 100, 100)
    winMove(140, 140)
    expect(document.body.classList.contains('canvas-interacting')).toBe(true)

    act(() => window.dispatchEvent(new Event('blur')))
    expect(document.body.classList.contains('canvas-interacting')).toBe(false)
  })
})

// =============================================================================
// 2c. Marquee selection — the SELECTION RESULT (which nodes get selected).
//
// The canvas div's getBoundingClientRect is (0,0) under jsdom and the scene runs
// at zoom 1 / offset 0, so client coords map 1:1 to canvas coords. Node geometry
// is read straight from the store (canvasStoreApi.getState().nodes), so we seed
// nodes there and drag a box over them. rectsOverlap is half-open: a box whose
// edge merely touches a node's edge does NOT count as a hit.
// =============================================================================

function seedNode(
  store: StoreApi<CanvasStore>,
  id: string,
  origin: Point,
  size: { width: number; height: number },
) {
  act(() => {
    const created = store.getState().addNode(`panel-${id}`, 'editor', origin, size)
    store.setState((s) => {
      const node = s.nodes[created]
      if (!node) return s
      const next = { ...s.nodes }
      delete next[created]
      next[id] = { ...node, id, origin: { ...origin }, size: { ...size } }
      return { ...s, nodes: next }
    })
  })
  // addNode/seed leave a stale selection from the dedupe path; reset to a clean
  // empty, deactivated selection so each test starts from a known state.
  act(() => store.getState().clearSelection())
}

describe('marquee selection — result', () => {
  it('selects exactly the nodes the box overlaps, and leaves the rest alone', () => {
    const { store, el } = setupScene()
    seedNode(store, 'A', { x: 50, y: 50 }, { width: 60, height: 60 })   // inside the box
    seedNode(store, 'B', { x: 130, y: 130 }, { width: 60, height: 60 }) // partially inside
    seedNode(store, 'C', { x: 400, y: 400 }, { width: 60, height: 60 }) // far outside

    // Drag a box from (40,40) to (200,200): overlaps A fully and B partially.
    leftDown(el, 40, 40)
    winMove(60, 60) // > 4px → drag begins
    winMove(200, 200)
    winUp(200, 200)

    const sel = new Set(store.getState().selection)
    expect(sel.has('A')).toBe(true)
    expect(sel.has('B')).toBe(true)
    expect(sel.has('C')).toBe(false)
    // Pure selection → no active lead.
    expect(store.getState().selectionActive).toBe(false)
    expect(focusedNodeId(store.getState())).toBeNull()
  })

  it('a node the box does not reach is NOT selected (edge-touch is not an overlap)', () => {
    const { store, el } = setupScene()
    // Node B's left edge is at x=200; a box ending exactly at x=200 only touches it.
    seedNode(store, 'A', { x: 50, y: 50 }, { width: 60, height: 60 })
    seedNode(store, 'B', { x: 200, y: 50 }, { width: 60, height: 60 })

    leftDown(el, 40, 40)
    winMove(60, 60)
    winMove(200, 120) // right edge exactly at B's left edge
    winUp(200, 120)

    const sel = new Set(store.getState().selection)
    expect(sel.has('A')).toBe(true)
    expect(sel.has('B')).toBe(false)
  })

  it('a plain marquee REPLACES the prior selection', () => {
    const { store, el } = setupScene()
    seedNode(store, 'A', { x: 50, y: 50 }, { width: 60, height: 60 })
    seedNode(store, 'B', { x: 400, y: 400 }, { width: 60, height: 60 })
    act(() => store.getState().selectNodes(['B'], false)) // pre-existing selection

    // Box over A only (no shift) → selection becomes just {A}.
    leftDown(el, 40, 40)
    winMove(60, 60)
    winMove(150, 150)
    winUp(150, 150)

    expect(store.getState().selection).toEqual(['A'])
  })

  it('shift-marquee is ADDITIVE — it unions with the existing selection', () => {
    const { store, el } = setupScene()
    seedNode(store, 'A', { x: 50, y: 50 }, { width: 60, height: 60 })
    seedNode(store, 'B', { x: 400, y: 400 }, { width: 60, height: 60 })
    act(() => store.getState().selectNodes(['B'], false)) // keep B selected

    // Shift held: box over A unions with {B}.
    act(() => el.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 40, clientY: 40, shiftKey: true, bubbles: true })))
    winMove(60, 60)
    winMove(150, 150)
    winUp(150, 150)

    expect(new Set(store.getState().selection)).toEqual(new Set(['A', 'B']))
    expect(store.getState().selectionActive).toBe(false)
  })

  it('a bare click (no drag) on empty canvas clears the selection and unfocuses', () => {
    const { store, el } = setupScene()
    seedNode(store, 'A', { x: 50, y: 50 }, { width: 60, height: 60 })
    act(() => store.getState().focusNode('A')) // active selection
    expect(focusedNodeId(store.getState())).toBe('A')

    leftDown(el, 600, 600) // empty canvas, far from A
    winUp(601, 601) // < 4px → not a drag

    expect(store.getState().selection).toEqual([])
    expect(store.getState().selectionActive).toBe(false)
    expect(focusedNodeId(store.getState())).toBeNull()
  })

  it('an empty-box marquee (no nodes overlapped) clears the selection', () => {
    const { store, el } = setupScene()
    seedNode(store, 'A', { x: 50, y: 50 }, { width: 60, height: 60 })
    act(() => store.getState().selectNodes(['A'], false))

    // Drag a box over empty space → nothing overlapped → selection cleared.
    leftDown(el, 500, 500)
    winMove(520, 520)
    winMove(600, 600)
    winUp(600, 600)

    expect(store.getState().selection).toEqual([])
  })
})

// =============================================================================
// 3. Momentum / inertia
// =============================================================================

/** Fast right-drag along +x: three 30px samples 16ms apart. Leaves the store
 *  offset at (90, 0) and a coast rAF armed. */
function flickRight(el: HTMLElement) {
  rightDown(el, 100, 100)
  fakeNow += 16
  moveTo(el, 130, 100)
  fakeNow += 16
  moveTo(el, 160, 100)
  fakeNow += 16
  moveTo(el, 190, 100)
  fakeNow += 2
  rightUp(el, 190, 100)
}

describe('momentum / inertia', () => {
  it('coasts after a fast right-drag release and decays to a stop', () => {
    const { store, el } = setupScene()

    flickRight(el)
    // Release itself doesn't move the viewport; the coast loop is armed.
    expect(store.getState().viewportOffset.x).toBe(90)
    expect(pendingRafCount()).toBe(1)

    pumpFrame()
    const afterOneFrame = store.getState().viewportOffset.x
    expect(afterOneFrame).toBeGreaterThan(90) // still moving in the fling direction
    expect(store.getState().viewportOffset.y).toBe(0)

    const frames = pumpUntilIdle()
    const settled = store.getState().viewportOffset.x
    expect(settled).toBeGreaterThan(afterOneFrame) // kept coasting...
    expect(frames).toBeGreaterThan(2) // ...over multiple frames
    expect(pendingRafCount()).toBe(0) // ...and stopped on its own

    // Dead after settling: more frames change nothing.
    pumpFrame()
    pumpFrame()
    expect(store.getState().viewportOffset.x).toBe(settled)
  })

  it('a release after a pause (stale velocity samples) does NOT coast', () => {
    const { store, el } = setupScene()

    rightDown(el, 100, 100)
    fakeNow += 16
    moveTo(el, 130, 100)
    fakeNow += 16
    moveTo(el, 160, 100)
    fakeNow += 200 // hold still — samples are now older than the 100ms window
    rightUp(el, 160, 100)

    expect(pendingRafCount()).toBe(0)
    expect(store.getState().viewportOffset).toEqual({ x: 60, y: 0 })
  })

  it('a slow / single-sample drag does NOT coast', () => {
    const { el } = setupScene()

    rightDown(el, 100, 100)
    fakeNow += 16
    moveTo(el, 150, 100) // one sample only
    rightUp(el, 150, 100)

    expect(pendingRafCount()).toBe(0)
  })

  it('starting a NEW right-drag mid-coast kills the momentum immediately', () => {
    const { store, el } = setupScene()

    flickRight(el)
    pumpFrame()
    pumpFrame()
    expect(pendingRafCount()).toBe(1) // coast still alive

    rightDown(el, 500, 500) // new pan begins
    expect(pendingRafCount()).toBe(0) // inertia rAF cancelled on the spot

    const frozen = { ...store.getState().viewportOffset }
    pumpFrame()
    pumpFrame()
    expect(store.getState().viewportOffset).toEqual(frozen) // no fighting

    // The new drag still pans normally.
    moveTo(el, 510, 505)
    expect(store.getState().viewportOffset).toEqual({ x: frozen.x + 10, y: frozen.y + 5 })
    rightUp(el, 510, 505)
  })

  it('a zoom wheel mid-coast kills the momentum: the final state is purely zoom-anchored', () => {
    const { store, el } = setupScene()

    flickRight(el)
    pumpFrame()
    pumpFrame()
    expect(pendingRafCount()).toBe(1)

    // Capture the state at the moment the zoom starts; if inertia kept
    // running, the final offset would deviate from the pure zoom anchor.
    const atWheel = store.getState()
    const cursor = { x: 400, y: 300 }
    wheel(el, { deltaY: -100, metaKey: true, clientX: cursor.x, clientY: cursor.y })
    pumpUntilIdle()

    const after = store.getState()
    expect(after.zoomLevel).toBeCloseTo(2.0, 6)
    const expected = anchoredOffset(cursor, atWheel.zoomLevel, atWheel.viewportOffset, 2.0)
    expect(after.viewportOffset.x).toBeCloseTo(expected.x, 6)
    expect(after.viewportOffset.y).toBeCloseTo(expected.y, 6)
  })
})

// =============================================================================
// 4. Lifecycle — unmount mid-animation
// =============================================================================

describe('lifecycle', () => {
  it('unmounting mid-coast cancels the rAF: no further viewport updates, no errors', () => {
    const errorSpy = vi.spyOn(console, 'error')
    const { store, el } = setupScene()

    flickRight(el)
    pumpFrame()
    expect(pendingRafCount()).toBe(1)

    act(() => root.unmount())
    rootUnmounted = true

    expect(pendingRafCount()).toBe(0) // coast handle cancelled by the unmount cleanup
    const frozen = { ...store.getState().viewportOffset }
    pumpFrame()
    pumpFrame()
    expect(store.getState().viewportOffset).toEqual(frozen)
    // No act()/unmounted-update warnings (ignore unrelated one-time deprecation
    // notices, which would otherwise make this order-dependent).
    const offending = errorSpy.mock.calls.filter(
      (args) => String(args[0]).includes('act(') || String(args[0]).includes('unmounted'),
    )
    expect(offending).toEqual([])
  })

  it('unmounting mid smooth-zoom cancels the rAF and freezes the zoom', () => {
    const { store, el } = setupScene()

    wheel(el, { deltaY: -100, metaKey: true, clientX: 400, clientY: 300 })
    pumpFrame()
    pumpFrame()
    const midZoom = store.getState().zoomLevel
    expect(midZoom).toBeGreaterThan(1)
    expect(midZoom).toBeLessThan(2)
    expect(pendingRafCount()).toBe(1)

    act(() => root.unmount())
    rootUnmounted = true

    expect(pendingRafCount()).toBe(0)
    pumpFrame()
    expect(store.getState().zoomLevel).toBe(midZoom)
  })
})

// =============================================================================
// 5. Context menu
// =============================================================================

describe('context menu', () => {
  it('right-click without drag converts the click point to canvas space under non-default zoom/offset', () => {
    const { el, expose } = setupScene({ zoom: 2, offset: { x: 50, y: -20 } })

    rightDown(el, 300, 200)
    rightUp(el, 300, 200) // no movement

    const menu = expose.current!.canvasContextMenu
    expect(menu).not.toBeNull()
    // Screen coords pass through untouched.
    expect(menu!.x).toBe(300)
    expect(menu!.y).toBe(200)
    // canvasPoint = (view - offset) / zoom = ((300-50)/2, (200+20)/2).
    expect(menu!.canvasPoint).toEqual({ x: 125, y: 110 })

    act(() => expose.current!.closeCanvasContextMenu())
    expect(expose.current!.canvasContextMenu).toBeNull()
  })

  it('right-click on a node does NOT open the canvas background menu', () => {
    const { expose } = setupScene()
    const node = container.querySelector<HTMLElement>('[data-testid="node"]')!

    rightDown(node, 50, 50)
    rightUp(node, 50, 50)

    expect(expose.current!.canvasContextMenu).toBeNull()
  })

  it('suppresses the native contextmenu event', () => {
    const { el } = setupScene()
    let prevented = false
    act(() => {
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      el.dispatchEvent(e)
      prevented = e.defaultPrevented
    })
    expect(prevented).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// Sanity for the harness itself: the menu state must be a fresh snapshot, so a
// stale `expose.current` would invalidate the assertions above.
// -----------------------------------------------------------------------------

it('expose ref tracks re-renders (harness sanity)', () => {
  const { expose } = setupScene()
  expect(expose.current).not.toBeNull()
  expect(typeof expose.current!.handleWheel).toBe('function')
  expect(expose.current!.canvasContextMenu).toBeNull()
})
