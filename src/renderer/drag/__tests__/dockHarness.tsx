// =============================================================================
// Dock drag integration harness. Extends the ideas in harness.tsx to the dock
// path: it mounts a real DockTabStack-shaped source (a draggable tab element
// wired to `useDragOp` with a real `dock-tab` spec) and registers a REAL
// drop-zone entry backed by a REAL dockStore instance with synthetic geometry.
//
// Unlike harness.tsx this does NOT mount the production DockZone/DockTabStack
// React components (their layout/measurement assumes a real browser box model
// jsdom can't provide). Instead it reproduces exactly the two collaborators the
// drag pipeline actually consults:
//   - a real dockStore (createDockStore) seeded with a tab-stack layout, so
//     `dockPanel` / `undockPanel` mutate genuine dock state, and the
//     self-stack guard in resolveDrop reads a real `zones` tree;
//   - a real drop-zone registry entry (registerDropZone) with stackId +
//     dockStoreApi + a synthetic getRect(), so `resolveDockHit` hit-tests and
//     routes the commit to that store.
//
// The tab itself is a real `[data-node-id]`-free element whose onMouseDown calls
// `handleDragStart` with a `dock-tab` DragOpSourceSpec — the same spec
// useDockTabDrag builds in production. Mouse events are driven through the same
// real-DOM path as harness.tsx.
//
// Only window.electronAPI is mocked (see setup.ts).
// =============================================================================

import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { StoreApi } from 'zustand'
import { useDragOp, type DragOpSourceSpec } from '../useDragOp'
import { useDragStore } from '../store'
import { INITIAL_DRAG_STATE } from '../types'
import { registerDropZone } from '../registry'
import { getDefaultSession } from '../session'
import {
  getOrCreateCanvasStoreForPanel,
  releaseCanvasStoreForPanel,
  getAllCanvasStores,
  useCanvasStore,
  type CanvasStore,
} from '../../stores/canvasStore'
import { createDockStore, type DockStore } from '../../stores/dockStore'
import type {
  DockTabStack,
  DockZonePosition,
  PanelState,
  PanelType,
  Point,
  WindowDockState,
} from '../../../shared/types'

// -----------------------------------------------------------------------------
// Scene spec
// -----------------------------------------------------------------------------

export interface DockStackSpec {
  /** Stable stack id used by both the layout tree and the drop-zone entry. */
  stackId: string
  /** Dock zone the stack lives in. */
  zone: DockZonePosition
  /** Panel ids in the stack, in tab order. The first is the active tab. */
  panelIds: string[]
  /** Per-panel type (defaults to 'editor'). */
  panelType?: PanelType
  /** Synthetic screen-space rect for the stack's drop zone. */
  rect: { x: number; y: number; w: number; h: number }
}

export interface DockCanvasSpec {
  panelId: string
  rect: { x: number; y: number; w: number; h: number }
  zoom?: number
  viewportOffset?: Point
}

export interface DockSceneSpec {
  stack: DockStackSpec
  /** Optional canvas surface for detach-to-canvas scenarios. */
  canvas?: DockCanvasSpec
}

export interface DockSceneApi {
  unmount(): void
  /** The real dock store backing the stack. */
  dockStore: StoreApi<DockStore>
  /** Live panel ids in the named stack (empty if the stack is gone). */
  stackPanelIds(stackId: string): string[]
  /** The canvas store for the (optional) canvas surface. */
  getCanvasStore(panelId: string): StoreApi<CanvasStore>
  mouse: DockMouseDriver
  drag(): ReturnType<typeof useDragStore.getState>
}

export interface DockMouseDriver {
  /** Fire a real mousedown on the named tab's DOM element. */
  downOnTab(panelId: string, opts?: { offset?: Point }): void
  moveTo(client: Point): void
  moveBy(delta: Point): void
  /** Arm past the dead zone then land at start + delta. */
  dragBy(delta: Point): void
  up(): void
  blur(): void
}

// -----------------------------------------------------------------------------
// Synthetic-rect registry + elementFromPoint (mirrors harness.tsx).
// -----------------------------------------------------------------------------

interface RectReg {
  el: HTMLElement
  rect: () => DOMRect
  z: number
}

const registeredRects = new Map<HTMLElement, RectReg>()

function installElementFromPoint() {
  ;(document as Document).elementFromPoint = (x: number, y: number) => {
    let best: RectReg | null = null
    for (const reg of registeredRects.values()) {
      if (!reg.el.isConnected) continue
      const r = reg.rect()
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue
      if (!best || reg.z > best.z) best = reg
    }
    return best?.el ?? null
  }
}

function registerRect(el: HTMLElement, rect: () => DOMRect, z: number): () => void {
  registeredRects.set(el, { el, rect, z })
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => rect(),
    configurable: true,
  })
  return () => {
    registeredRects.delete(el)
  }
}

function makeRect(x: number, y: number, w: number, h: number): DOMRect {
  return {
    x,
    y,
    left: x,
    top: y,
    right: x + w,
    bottom: y + h,
    width: w,
    height: h,
    toJSON() {
      return {}
    },
  } as DOMRect
}

// -----------------------------------------------------------------------------
// Dock-state seed
// -----------------------------------------------------------------------------

function seededDockState(spec: DockStackSpec): WindowDockState {
  const stack: DockTabStack = {
    type: 'tabs',
    id: spec.stackId,
    panelIds: [...spec.panelIds],
    activeIndex: 0,
  }
  const base = createDockStore().getState().zones
  return {
    ...base,
    [spec.zone]: {
      ...base[spec.zone],
      visible: true,
      layout: stack,
    },
  }
}

// -----------------------------------------------------------------------------
// React scene
// -----------------------------------------------------------------------------

/** A single draggable tab wired to `useDragOp` with a real `dock-tab` spec —
 *  exactly the spec useDockTabDrag builds in production. */
function TabElement({
  panelId,
  spec,
  dockStore,
}: {
  panelId: string
  spec: DockStackSpec
  dockStore: StoreApi<DockStore>
}) {
  const elRef = React.useRef<HTMLDivElement | null>(null)
  const { handleDragStart } = useDragOp()
  const panelType = spec.panelType ?? 'editor'

  const panelState: PanelState = React.useMemo(
    () => ({ id: panelId, type: panelType, title: panelId, isDirty: false }),
    [panelId, panelType],
  )

  const dragSpec = React.useMemo<DragOpSourceSpec>(
    () => ({
      kind: 'dock-tab',
      dockStoreApi: dockStore,
      zone: spec.zone,
      stackId: spec.stackId,
      panelId,
      panelType,
      panelTitle: panelId,
      panel: panelState,
    }),
    [dockStore, spec.zone, spec.stackId, panelId, panelType, panelState],
  )

  // Each tab gets a small synthetic rect inside the stack's tab-bar strip so a
  // mousedown can target it; the index spreads tabs across the top edge.
  React.useEffect(() => {
    const el = elRef.current
    if (!el) return
    const idx = spec.panelIds.indexOf(panelId)
    const tabW = 80
    const rectFn = () =>
      makeRect(spec.rect.x + idx * tabW, spec.rect.y + 2, tabW, 30)
    return registerRect(el, rectFn, 20)
  }, [panelId, spec.panelIds, spec.rect.x, spec.rect.y])

  return (
    <div
      ref={elRef}
      data-tab-panel-id={panelId}
      onMouseDown={(e) => handleDragStart(e, dragSpec)}
      style={{ position: 'absolute' }}
    />
  )
}

function CanvasSurface({ spec }: { spec: DockCanvasSpec }) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const store = React.useMemo(
    () => getOrCreateCanvasStoreForPanel(spec.panelId),
    [spec.panelId],
  )
  React.useEffect(() => {
    store.getState().setZoomAndOffset(spec.zoom ?? 1, spec.viewportOffset ?? { x: 0, y: 0 })
  }, [store, spec.zoom, spec.viewportOffset])
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    return registerRect(
      el,
      () => makeRect(spec.rect.x, spec.rect.y, spec.rect.w, spec.rect.h),
      0,
    )
  }, [spec.rect.x, spec.rect.y, spec.rect.w, spec.rect.h])
  return (
    <div
      ref={ref}
      data-canvas-container
      data-canvas-panel-id={spec.panelId}
      style={{ position: 'absolute' }}
    />
  )
}

function DockScene({
  spec,
  dockStore,
}: {
  spec: DockSceneSpec
  dockStore: StoreApi<DockStore>
}) {
  return (
    <>
      {spec.stack.panelIds.map((pid) => (
        <TabElement key={pid} panelId={pid} spec={spec.stack} dockStore={dockStore} />
      ))}
      {spec.canvas && <CanvasSurface spec={spec.canvas} />}
    </>
  )
}

// -----------------------------------------------------------------------------
// renderDockScene
// -----------------------------------------------------------------------------

const HARNESS_DEAD_ZONE = 4

export function renderDockScene(spec: DockSceneSpec): DockSceneApi {
  installElementFromPoint()
  getDefaultSession().resetDispatch()
  useDragStore.getState().applyDragState(INITIAL_DRAG_STATE)
  for (const store of [useCanvasStore, ...getAllCanvasStores()]) {
    store.setState((s) => ({
      ...s,
      nodes: {},
      selection: [],
      selectionActive: false,
      history: [],
      historyIndex: -1,
    }))
  }

  // Real dock store seeded with the requested stack layout.
  const dockStore = createDockStore({
    zones: seededDockState(spec.stack),
    locations: {},
  })

  // Register the canvas store with the session so canvas-add commits can find
  // the destination store via the reverse index (matches CanvasPanel).
  let releaseCanvasReg: (() => void) | null = null
  if (spec.canvas) {
    const canvasStore = getOrCreateCanvasStoreForPanel(spec.canvas.panelId)
    releaseCanvasReg = getDefaultSession().registerCanvasStore(
      spec.canvas.panelId,
      canvasStore,
    )
  }

  // Register the real stack-level drop zone backed by the real dock store.
  const releaseZone = registerDropZone({
    id: `zone-${spec.stack.stackId}`,
    zone: spec.stack.zone,
    stackId: spec.stack.stackId,
    dockStoreApi: dockStore,
    getRect: () =>
      makeRect(spec.stack.rect.x, spec.stack.rect.y, spec.stack.rect.w, spec.stack.rect.h),
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)

  act(() => {
    root.render(<DockScene spec={spec} dockStore={dockStore} />)
  })

  let lastClient: Point = { x: 0, y: 0 }
  let downClient: Point = { x: 0, y: 0 }

  function fireWindowMouse(type: 'mousemove' | 'mouseup', client: Point): void {
    act(() => {
      window.dispatchEvent(
        new MouseEvent(type, {
          clientX: client.x,
          clientY: client.y,
          screenX: client.x,
          screenY: client.y,
          bubbles: true,
        }),
      )
    })
  }

  const mouse: DockMouseDriver = {
    downOnTab(panelId, opts) {
      const el = document.querySelector<HTMLElement>(`[data-tab-panel-id="${panelId}"]`)
      if (!el) throw new Error(`No DOM element for tab ${panelId}`)
      const rect = el.getBoundingClientRect()
      const offset = opts?.offset ?? { x: rect.width / 2, y: rect.height / 2 }
      const client: Point = { x: rect.left + offset.x, y: rect.top + offset.y }
      lastClient = client
      downClient = client
      act(() => {
        el.dispatchEvent(
          new MouseEvent('mousedown', {
            clientX: client.x,
            clientY: client.y,
            screenX: client.x,
            screenY: client.y,
            button: 0,
            bubbles: true,
          }),
        )
      })
    },
    moveTo(client) {
      lastClient = client
      fireWindowMouse('mousemove', client)
    },
    moveBy(delta) {
      mouse.moveTo({ x: lastClient.x + delta.x, y: lastClient.y + delta.y })
    },
    dragBy(delta) {
      const sx = delta.x === 0 ? 0 : delta.x > 0 ? 1 : -1
      const sy = delta.y === 0 ? 0 : delta.y > 0 ? 1 : -1
      mouse.moveTo({
        x: downClient.x + sx * (HARNESS_DEAD_ZONE + 1),
        y: downClient.y + sy * (HARNESS_DEAD_ZONE + 1),
      })
      mouse.moveTo({ x: downClient.x + delta.x, y: downClient.y + delta.y })
    },
    up() {
      fireWindowMouse('mouseup', lastClient)
    },
    blur() {
      act(() => {
        window.dispatchEvent(new Event('blur'))
      })
    },
  }

  return {
    unmount() {
      act(() => {
        root.unmount()
      })
      host.remove()
      releaseZone()
      releaseCanvasReg?.()
      if (spec.canvas) releaseCanvasStoreForPanel(spec.canvas.panelId)
      registeredRects.clear()
    },
    dockStore,
    stackPanelIds(stackId) {
      const zones = dockStore.getState().zones
      for (const pos of ['left', 'right', 'bottom', 'center'] as DockZonePosition[]) {
        const layout = zones[pos].layout
        const found = layout ? findStackById(layout, stackId) : null
        if (found) return [...found.panelIds]
      }
      return []
    },
    getCanvasStore(panelId) {
      return getOrCreateCanvasStoreForPanel(panelId)
    },
    mouse,
    drag() {
      return useDragStore.getState()
    },
  }
}

function findStackById(
  node: import('../../../shared/types').DockLayoutNode,
  stackId: string,
): DockTabStack | null {
  if (node.type === 'tabs') return node.id === stackId ? node : null
  for (const child of node.children) {
    const f = findStackById(child, stackId)
    if (f) return f
  }
  return null
}
