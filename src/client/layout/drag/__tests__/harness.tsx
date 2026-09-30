// Drag integration harness over the document model. It mounts real dock
// views (DockView, whose stacks register their drop zones and start tab
// drags) and minimal canvases (registered drop surfaces whose nodes start
// node drags), attached to a workspace whose document runtime is in memory.
// Drags run through real DOM events: a mousedown on the rendered tab or node,
// then window mousemove/mouseup caught by the dispatcher. elementFromPoint and
// element rects are stubbed from the scene's geometry.

import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { canvasToView, type Point } from '@workspace/canvas/contract'
import { MAIN_WINDOW, dockPanels, type DockRef, type WorkspaceDocument } from '@workspace/document/contract'
import { createClientIdentity, installClientIdentity } from '@client/connections'
import { registerPanelDefinitions } from '@client/host'
import type { ClientFeature } from '@kernel/rpc/contract'
import { DockView } from '../../dock/DockView'
import { resetPresentations } from '../../dock/presentation'
import { attachTestWorkspace, testPanelDefinitions, type TestWorkspace } from '../../testing'
import { installDragShell, type DragShell } from '../ports'
import { registerCanvasDropSurface, resetDragRegistry } from '../registry'
import { useDragStore } from '../store'
import { beginDrag, resetDragDispatch } from '../useDragOp'
import { INITIAL_DRAG_STATE } from '../types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export const WS = 'ws'

export interface Box { x: number; y: number; w: number; h: number }

export interface CanvasSpec {
  canvasId: string
  rect: Box
  zoom?: number
  offset?: Point
  /** Draw each node's mini dock (its stacks become drop targets). */
  miniDocks?: boolean
}

export interface SceneSpec {
  doc: WorkspaceDocument
  /** Screen rects of the main window's stacks by stack id. */
  stacks?: Record<string, Box>
  canvases?: CanvasSpec[]
  features?: ClientFeature[]
  shell?: DragShell
  /** Node selection per canvas (group drags). */
  selection?: Record<string, string[]>
}

const domRect = (b: Box): DOMRect => ({
  x: b.x, y: b.y, left: b.x, top: b.y, right: b.x + b.w, bottom: b.y + b.h, width: b.w, height: b.h, toJSON() { return {} },
}) as DOMRect

interface HitRect { el: Element; rect: () => Box; z: number }
const hitRects = new Set<HitRect>()

function stubRect(el: Element, rect: () => Box, z: number): void {
  Object.defineProperty(el, 'getBoundingClientRect', { value: () => domRect(rect()), configurable: true })
  hitRects.add({ el, rect, z })
}

function installElementFromPoint(): void {
  ;(document as Document).elementFromPoint = (x: number, y: number) => {
    let best: HitRect | null = null
    for (const hit of hitRects) {
      if (!hit.el.isConnected) continue
      const r = hit.rect()
      if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue
      if (!best || hit.z > best.z) best = hit
    }
    return best?.el ?? null
  }
}

function nodeBox(doc: WorkspaceDocument, spec: CanvasSpec, nodeId: string): Box {
  const node = doc.canvases[spec.canvasId].nodes[nodeId]
  const zoom = spec.zoom ?? 1
  const view = canvasToView(node.rect.origin, zoom, spec.offset ?? { x: 0, y: 0 })
  return { x: spec.rect.x + view.x, y: spec.rect.y + view.y, w: node.rect.size.width * zoom, h: node.rect.size.height * zoom }
}

function TestCanvas({ spec, workspace }: { spec: CanvasSpec; workspace: TestWorkspace }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [doc, setDoc] = React.useState(() => workspace.document.getSnapshot())
  React.useEffect(() => workspace.document.subscribe(() => setDoc(workspace.document.getSnapshot())), [workspace])
  React.useEffect(() => {
    const el = ref.current!
    stubRect(el, () => spec.rect, 0)
    return registerCanvasDropSurface({
      workspaceId: WS,
      canvasId: spec.canvasId,
      getElement: () => ref.current,
      getViewport: () => ({ offset: spec.offset ?? { x: 0, y: 0 }, zoom: spec.zoom ?? 1 }),
    })
  }, [spec])
  const nodes = Object.values(doc.canvases[spec.canvasId]?.nodes ?? {})
  return (
    <div ref={ref} data-test-canvas={spec.canvasId}>
      {nodes.map((node) => (
        <TestNode key={node.id} spec={spec} nodeId={node.id} panelId={dockPanels(node.dock)[0]} workspace={workspace} />
      ))}
    </div>
  )
}

function TestNode({ spec, nodeId, panelId, workspace }: { spec: CanvasSpec; nodeId: string; panelId: string; workspace: TestWorkspace }) {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => {
    stubRect(ref.current!, () => nodeBox(workspace.document.getSnapshot(), spec, nodeId), 1)
    for (const stack of ref.current!.querySelectorAll('[data-dock-stack-id]')) {
      stubRect(stack, () => nodeBox(workspace.document.getSnapshot(), spec, nodeId), 2)
    }
  })
  const dock = React.useMemo<DockRef>(() => ({ canvasId: spec.canvasId, nodeId }), [spec.canvasId, nodeId])
  return (
    <div
      ref={ref}
      data-node-id={nodeId}
      onMouseDown={(e) => {
        if ((e.target as Element).closest('[data-tab-panel-id]')) return
        const selection = workspace.state.getSnapshot().selection[spec.canvasId] ?? []
        const grouped = selection.length > 1 && selection.includes(nodeId)
        const canvas = workspace.document.getSnapshot().canvases[spec.canvasId]
        beginDrag(e, {
          kind: 'canvas-node',
          workspaceId: WS,
          canvasId: spec.canvasId,
          nodeId,
          panelId,
          ...(grouped ? {
            startOrigin: canvas.nodes[nodeId].rect.origin,
            members: selection.filter((id) => id !== nodeId).map((id) => ({ nodeId: id, startOrigin: canvas.nodes[id].rect.origin })),
          } : {}),
        })
      }}
    >
      {spec.miniDocks && <DockView workspaceId={WS} dock={dock} compact renderPanel={() => null} />}
    </div>
  )
}

export interface Scene {
  workspace: TestWorkspace
  doc(): WorkspaceDocument
  drag(): ReturnType<typeof useDragStore.getState>
  mouse: {
    downOnTab(panelId: string, at?: Point): void
    downOnNode(nodeId: string, at?: Point): void
    moveTo(p: Point): void
    moveBy(d: Point): void
    /** Past the dead zone, then to start + delta. */
    dragBy(d: Point): void
    up(): void
    blur(): void
  }
  unmount(): void
}

export function renderScene(spec: SceneSpec): Scene {
  registerPanelDefinitions(testPanelDefinitions())
  installClientIdentity(createClientIdentity({ device: { name: 'd', keyFingerprint: 'FP' }, features: spec.features ?? [] }))
  const restoreShell = installDragShell(spec.shell ?? {})
  installElementFromPoint()
  const workspace = attachTestWorkspace(WS, spec.doc)
  for (const [canvasId, nodes] of Object.entries(spec.selection ?? {})) workspace.state.setSelection(canvasId, nodes)

  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const stackBox = (stackId: string) => spec.stacks?.[stackId] ?? { x: 0, y: 0, w: 0, h: 0 }
  act(() => {
    root.render(
      <>
        <div data-test-main>
          <DockView workspaceId={WS} dock={{ windowId: MAIN_WINDOW }} renderPanel={() => null} />
        </div>
        {spec.canvases?.map((c) => <TestCanvas key={c.canvasId} spec={c} workspace={workspace} />)}
      </>,
    )
  })
  const stubStacks = () => {
    for (const el of container.querySelectorAll('[data-test-main] [data-dock-stack-id]')) {
      const id = el.getAttribute('data-dock-stack-id')!
      stubRect(el, () => stackBox(id), 1)
      for (const tab of el.querySelectorAll('[data-tab-panel-id]')) {
        const box = stackBox(id)
        stubRect(tab, () => ({ x: box.x + 8, y: box.y + 4, w: 100, h: 24 }), 3)
      }
    }
  }
  stubStacks()

  let last: Point = { x: 0, y: 0 }
  const fire = (target: EventTarget, type: string, p: Point) => {
    last = p
    act(() => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: p.x, clientY: p.y, screenX: p.x + 1000, screenY: p.y + 1000 }))
    })
  }
  const center = (el: Element): Point => {
    const r = el.getBoundingClientRect()
    return { x: r.left + Math.min(r.width / 2, 40), y: r.top + Math.min(r.height / 2, 10) }
  }

  return {
    workspace,
    doc: () => workspace.document.getSnapshot(),
    drag: () => useDragStore.getState(),
    mouse: {
      downOnTab(panelId, at) {
        stubStacks()
        const el = container.querySelector(`[data-tab-panel-id="${panelId}"]`)
        if (!el) throw new Error(`no tab ${panelId}`)
        fire(el, 'mousedown', at ?? center(el))
      },
      downOnNode(nodeId, at) {
        const el = container.querySelector(`[data-node-id="${nodeId}"]`)
        if (!el) throw new Error(`no node ${nodeId}`)
        fire(el, 'mousedown', at ?? center(el))
      },
      moveTo(p) { fire(window, 'mousemove', p) },
      moveBy(d) { fire(window, 'mousemove', { x: last.x + d.x, y: last.y + d.y }) },
      dragBy(d) {
        const start = last
        fire(window, 'mousemove', { x: start.x + Math.sign(d.x || 1) * 5, y: start.y + Math.sign(d.y || 1) * 5 })
        fire(window, 'mousemove', { x: start.x + d.x, y: start.y + d.y })
      },
      up() { fire(window, 'mouseup', last) },
      blur() { act(() => { window.dispatchEvent(new Event('blur')) }) },
    },
    unmount() {
      act(() => root.unmount())
      container.remove()
      workspace.detach()
      resetDragDispatch()
      resetDragRegistry()
      resetPresentations()
      restoreShell()
      hitRects.clear()
      installClientIdentity(null)
      useDragStore.setState({ ...INITIAL_DRAG_STATE, pendingDetach: [] })
    },
  }
}
