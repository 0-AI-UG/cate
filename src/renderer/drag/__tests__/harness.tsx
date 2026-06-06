// =============================================================================
// Drag integration harness. Mounts a real React tree, registers real canvas
// stores, and drives `useDragOp` through **real DOM events**:
//   - `mousedown` on the rendered `[data-node-id]` element bubbles to React's
//     synthetic-event listener, which invokes the `onMouseDown` prop calling
//     `handleDragStart`. The dispatcher is not invoked by any back-channel.
//   - `mousemove`/`mouseup` are real window events caught by the capture-phase
//     listeners installed by `useDragOp`; `blur` is caught in bubble phase.
//   - `document.elementFromPoint` is replaced by a real top-down scan over the
//     rendered `[data-canvas-container]` / `[data-node-id]` nodes (using their
//     stubbed `getBoundingClientRect`), so `resolveDrop`'s DOM-coupling path
//     in `resolve.ts:48-57` is exercised for every scenario.
//
// The only mocked surface is `window.electronAPI` (see setup.ts).
// =============================================================================

import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { StoreApi } from 'zustand'
import { useDragOp, type DragOpSourceSpec } from '../useDragOp'
import { useDragStore } from '../store'
import { INITIAL_DRAG_STATE } from '../types'
import {
  getOrCreateCanvasStoreForPanel,
  releaseCanvasStoreForPanel,
  getAllCanvasStores,
  useCanvasStore,
  type CanvasStore,
} from '../../stores/canvasStore'
import { getDefaultSession } from '../session'
import type { PanelState, PanelType, Point, Size } from '../../../shared/types'

// -----------------------------------------------------------------------------
// Scene spec
// -----------------------------------------------------------------------------

export interface CanvasSpec {
  panelId: string
  rect: { x: number; y: number; w: number; h: number }
  zoom?: number
  viewportOffset?: Point
}

export interface NodeSpec {
  canvasPanelId: string
  nodeId?: string
  panelType?: PanelType
  origin: Point
  size: Size
  preMaximizeOrigin?: Point
  preMaximizeSize?: Size
}

export interface SceneSpec {
  canvases: CanvasSpec[]
  nodes?: NodeSpec[]
}

export interface SceneApi {
  unmount(): void
  getCanvasStore(panelId: string): StoreApi<CanvasStore>
  nodeIdAt(index: number): string
  mouse: MouseDriver
  drag(): ReturnType<typeof useDragStore.getState>
}

export interface MouseDriver {
  /** Fire a real `mousedown` on the node's rendered DOM element so React's
   *  onMouseDown handler runs end-to-end. */
  downOnNode(nodeId: string, opts?: { offset?: Point }): void
  /** Absolute client-coord move. */
  moveTo(client: Point): void
  /** Relative move from the last cursor position. */
  moveBy(delta: Point): void
  /** Move past the dead zone *and* land at `start + delta`. Two `mousemove`
   *  events under the hood — arms the drag, then carries it to the target.
   *  Removes the need for callers to know DEAD_ZONE_PX. */
  dragBy(delta: Point): void
  up(): void
  blur(): void
}

// -----------------------------------------------------------------------------
// Bounding-rect stubs + real elementFromPoint over rendered DOM
// -----------------------------------------------------------------------------

interface RectRegistration {
  el: HTMLElement
  rect: () => DOMRect
  /** Higher z = preferred for top-most hit (nodes > containers). */
  z: number
}

const registeredRects = new Map<HTMLElement, RectRegistration>()

function installElementFromPoint() {
  ;(document as Document).elementFromPoint = (x: number, y: number) => {
    let best: RectRegistration | null = null
    for (const reg of registeredRects.values()) {
      // Skip elements unmounted since registration.
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

// -----------------------------------------------------------------------------
// React scene
// -----------------------------------------------------------------------------

function TestCanvas({ spec, nodeSpecs }: { spec: CanvasSpec; nodeSpecs: NodeSpec[] }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const store = React.useMemo(() => getOrCreateCanvasStoreForPanel(spec.panelId), [spec.panelId])

  React.useEffect(() => {
    store.getState().setZoomAndOffset(spec.zoom ?? 1, spec.viewportOffset ?? { x: 0, y: 0 })
  }, [store, spec.zoom, spec.viewportOffset])

  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const rectFn = (): DOMRect => ({
      x: spec.rect.x,
      y: spec.rect.y,
      left: spec.rect.x,
      top: spec.rect.y,
      right: spec.rect.x + spec.rect.w,
      bottom: spec.rect.y + spec.rect.h,
      width: spec.rect.w,
      height: spec.rect.h,
      toJSON() { return {} },
    } as DOMRect)
    return registerRect(el, rectFn, 0)
  }, [spec.rect.x, spec.rect.y, spec.rect.w, spec.rect.h])

  return (
    <div
      ref={containerRef}
      data-canvas-container
      data-canvas-panel-id={spec.panelId}
      style={{ position: 'absolute', left: spec.rect.x, top: spec.rect.y, width: spec.rect.w, height: spec.rect.h }}
    >
      {nodeSpecs.map((n, i) => (
        <TestNode key={n.nodeId ?? `n-${spec.panelId}-${i}`} spec={n} canvasStore={store} />
      ))}
    </div>
  )
}

function TestNode({ spec, canvasStore }: { spec: NodeSpec; canvasStore: StoreApi<CanvasStore> }) {
  const stableNodeIdRef = React.useRef<string | null>(null)
  if (stableNodeIdRef.current == null) {
    const created = canvasStore.getState().addNode(
      `panel-${spec.nodeId ?? Math.random().toString(36).slice(2, 9)}`,
      spec.panelType ?? 'editor',
      spec.origin,
      spec.size,
    )
    const finalId = spec.nodeId ?? created
    canvasStore.setState((s) => {
      const node = s.nodes[created]
      if (!node) return s
      const next = { ...s.nodes }
      delete next[created]
      next[finalId] = {
        ...node,
        id: finalId,
        origin: spec.origin,
        size: spec.size,
        ...(spec.preMaximizeOrigin && spec.preMaximizeSize
          ? { preMaximizeOrigin: spec.preMaximizeOrigin, preMaximizeSize: spec.preMaximizeSize }
          : {}),
      }
      return { ...s, nodes: next }
    })
    stableNodeIdRef.current = finalId
  }
  const nodeId = stableNodeIdRef.current

  const elRef = React.useRef<HTMLDivElement | null>(null)
  const node = React.useSyncExternalStore(
    canvasStore.subscribe,
    () => canvasStore.getState().nodes[nodeId],
  )

  const panelState: PanelState = React.useMemo(
    () => ({ id: nodeId, type: spec.panelType ?? 'editor', title: 'test', isDirty: false }),
    [nodeId, spec.panelType],
  )

  const { handleDragStart } = useDragOp()

  const dragSpec = React.useMemo<DragOpSourceSpec>(
    () => ({
      kind: 'canvas-node',
      canvasStoreApi: canvasStore,
      nodeId,
      panelId: nodeId,
      panelType: spec.panelType ?? 'editor',
      panelTitle: 'test',
      panel: panelState,
    }),
    [canvasStore, nodeId, spec.panelType, panelState],
  )

  React.useEffect(() => {
    const el = elRef.current
    if (!el || !node) return
    const zoom = canvasStore.getState().zoomLevel
    const off = canvasStore.getState().viewportOffset
    const compute = (): DOMRect => {
      const container = (el.closest('[data-canvas-container]') as HTMLElement | null)?.getBoundingClientRect()
      const cx = container?.left ?? 0
      const cy = container?.top ?? 0
      const live = canvasStore.getState().nodes[nodeId]
      if (!live) {
        return { x: cx, y: cy, left: cx, top: cy, right: cx, bottom: cy, width: 0, height: 0, toJSON() { return {} } } as DOMRect
      }
      const x = cx + off.x + live.origin.x * zoom
      const y = cy + off.y + live.origin.y * zoom
      const w = live.size.width * zoom
      const h = live.size.height * zoom
      return { x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, toJSON() { return {} } } as DOMRect
    }
    return registerRect(el, compute, 10)
  }, [canvasStore, nodeId, node])

  if (!node) return null
  return (
    <div
      ref={elRef}
      data-node-id={nodeId}
      onMouseDown={(e) => handleDragStart(e, dragSpec)}
      style={{ position: 'absolute' }}
    />
  )
}

function Scene({ spec }: { spec: SceneSpec }) {
  return (
    <>
      {spec.canvases.map((c) => (
        <TestCanvas
          key={c.panelId}
          spec={c}
          nodeSpecs={(spec.nodes ?? []).filter((n) => n.canvasPanelId === c.panelId)}
        />
      ))}
    </>
  )
}

// -----------------------------------------------------------------------------
// renderDragScene
// -----------------------------------------------------------------------------

/** Matches DEAD_ZONE_PX in useDragOp.ts. The harness probes this via dragBy. */
const HARNESS_DEAD_ZONE = 4

export function renderDragScene(spec: SceneSpec): SceneApi {
  installElementFromPoint()
  getDefaultSession().resetDispatch()
  useDragStore.getState().applyDragState(INITIAL_DRAG_STATE)
  for (const store of [useCanvasStore, ...getAllCanvasStores()]) {
    store.setState((s) => ({
      ...s,
      nodes: {},
      focusedNodeId: null,
      selectedNodeIds: new Set<string>(),
      history: [],
      historyIndex: -1,
    }))
  }

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)

  act(() => {
    root.render(<Scene spec={spec} />)
  })

  const assignedNodeIds: string[] = []
  for (const c of spec.canvases) {
    const store = getOrCreateCanvasStoreForPanel(c.panelId)
    const ids = Object.keys(store.getState().nodes)
    for (const n of spec.nodes ?? []) {
      if (n.canvasPanelId !== c.panelId) continue
      if (n.nodeId && ids.includes(n.nodeId)) assignedNodeIds.push(n.nodeId)
    }
  }
  if (assignedNodeIds.length === 0) {
    for (const n of spec.nodes ?? []) {
      const store = getOrCreateCanvasStoreForPanel(n.canvasPanelId)
      for (const id of Object.keys(store.getState().nodes)) {
        if (!assignedNodeIds.includes(id)) assignedNodeIds.push(id)
      }
    }
  }

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

  const mouse: MouseDriver = {
    downOnNode(nodeId, opts) {
      const el = document.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`)
      if (!el) throw new Error(`No DOM element for node ${nodeId}`)
      const rect = el.getBoundingClientRect()
      const offset = opts?.offset ?? { x: rect.width / 2, y: rect.height / 2 }
      const client: Point = { x: rect.left + offset.x, y: rect.top + offset.y }
      lastClient = client
      downClient = client
      // Real mousedown bubbles to React's root-level synthetic event listener
      // installed by createRoot — the onMouseDown prop on TestNode runs.
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
      // Step 1: nudge past the dead zone from the *down* position so the
      // dispatcher arms. Step 2: move to the final delta from `down`.
      const sx = delta.x === 0 ? 0 : delta.x > 0 ? 1 : -1
      const sy = delta.y === 0 ? 0 : delta.y > 0 ? 1 : -1
      const arm: Point = {
        x: downClient.x + sx * (HARNESS_DEAD_ZONE + 1),
        y: downClient.y + sy * (HARNESS_DEAD_ZONE + 1),
      }
      mouse.moveTo(arm)
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
      for (const c of spec.canvases) releaseCanvasStoreForPanel(c.panelId)
      registeredRects.clear()
    },
    getCanvasStore(panelId) {
      return getOrCreateCanvasStoreForPanel(panelId)
    },
    nodeIdAt(index) {
      return assignedNodeIds[index]
    },
    mouse,
    drag() {
      return useDragStore.getState()
    },
  }
}
