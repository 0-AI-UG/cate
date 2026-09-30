// CanvasNode wiring: connection ports, the drag-source look, and routing a
// press to a node drag, a group drag (the whole selection, never collapsed
// first) or a tab detach. The drag layer and the dock are fakes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { rect } from '@workspace/canvas/contract'
import { applyOp, type WorkspaceDocument } from '@workspace/document/contract'
import { canvasViewFor, resetCanvasViews, setCanvasAnimations } from '../registry'
import { installCanvasDrag, type CanvasDragPort, type CanvasDragState, type CanvasNodeDragSource, type CanvasTabDragSource } from '../ports'
import { canvasDocument } from '../testing.canvas'
import { openTestDocument, testRelationHost } from '../testing'
import { focusedNodeId } from '../selection'
import type { CanvasViewStore } from '../store'
import { CanvasViewProvider } from './context'
import { installCanvasSlots, type NodeDockProps } from './slots'
import CanvasNode from './CanvasNode'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function FakeDock({ dock, onTabBarMouseDown, trailingControls }: NodeDockProps) {
  const stack = dock.kind === 'stack' ? dock : null
  return (
    <div data-dock-stack-id={stack?.id}>
      <div className="dock-tab-bar" onMouseDown={(e) => onTabBarMouseDown?.(e)}>
        {stack?.panels.map((id) => (
          <span key={id} data-tab-panel-id={id} onMouseDown={(e) => { e.stopPropagation(); onTabBarMouseDown?.(e, id) }}>{id}</span>
        ))}
        {trailingControls}
      </div>
      <div data-panel-surface />
    </div>
  )
}

function fakeDrag() {
  let state: CanvasDragState = { dragging: false, sourceNodeId: null }
  const listeners = new Set<() => void>()
  const port: CanvasDragPort & { nodeDrags: CanvasNodeDragSource[]; tabDrags: CanvasTabDragSource[]; set(next: CanvasDragState): void } = {
    nodeDrags: [],
    tabDrags: [],
    getState: () => state,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l) } },
    beginNodeDrag: (_e, source) => { port.nodeDrags.push(source) },
    beginTabDrag: (_e, source) => { port.tabDrags.push(source) },
    wasDragged: () => false,
    set(next) {
      state = next
      for (const l of [...listeners]) l()
    },
  }
  return port
}

let container: HTMLDivElement
let root: Root
let closeDoc: () => void
let relations: ReturnType<typeof testRelationHost>
let drag: ReturnType<typeof fakeDrag>

function open(doc: WorkspaceDocument): CanvasViewStore {
  closeDoc = openTestDocument('ws', doc)
  return canvasViewFor('ws', 'c1')!
}

function render(store: CanvasViewStore, nodeIds: string[]) {
  act(() => root.render(
    <CanvasViewProvider store={store}>
      {nodeIds.map((id) => (
        <CanvasNode key={id} workspaceId="ws" canvasId="c1" canvasPanelId="canvas-panel" nodeId={id} isFocused={focusedNodeId(store.getState()) === id} />
      ))}
    </CanvasViewProvider>,
  ))
}

function mouseDown(el: Element) {
  act(() => { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })) })
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  setCanvasAnimations(false)
  installCanvasSlots({ NodeDock: FakeDock })
  relations = testRelationHost()
  drag = fakeDrag()
  installCanvasDrag(drag)
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => { root = createRoot(container) })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  resetCanvasViews()
  closeDoc()
  relations.uninstall()
  installCanvasDrag(null)
  vi.unstubAllGlobals()
})

const twoNodes = () => canvasDocument([
  { nodeId: 'n1', panelId: 'p1', rect: rect(100, 100, 300, 200) },
  { nodeId: 'n2', panelId: 'p2', rect: rect(500, 100, 300, 200) },
])

describe('CanvasNode', () => {
  it('shows connection ports on the focused node', () => {
    const store = open(twoNodes())
    act(() => store.getState().focusNode('n1'))
    render(store, ['n1'])
    expect(container.querySelector('[data-panel-connection-handles-for="n1"]')).not.toBeNull()
    expect(container.querySelector<HTMLElement>('[data-node-id="n1"]')!.dataset.activePanelId).toBe('p1')
  })

  it('hides the drag source and its ports while the ghost stands in', () => {
    const store = open(twoNodes())
    act(() => store.getState().focusNode('n1'))
    render(store, ['n1'])
    act(() => drag.set({ dragging: true, sourceNodeId: 'n1', ghostOrigin: { x: 180, y: 160 } }))
    const node = container.querySelector<HTMLElement>('[data-node-id="n1"]')!
    expect(node.style.left).toBe('100px')
    expect(node.style.visibility).toBe('hidden')
    expect(node.querySelector('[data-panel-surface]')).not.toBeNull()
    expect(container.querySelector('[data-panel-connection-handles-for="n1"]')).toBeNull()
    expect(container.querySelector('[data-resize-frame-for="n1"]')).toBeNull()
    act(() => drag.set({ dragging: false, sourceNodeId: null }))
    expect(container.querySelector('[data-panel-connection-handles-for="n1"]')).not.toBeNull()
  })

  it('a tab bar press on a single node drags the node', () => {
    const store = open(twoNodes())
    render(store, ['n1', 'n2'])
    mouseDown(container.querySelector('[data-node-id="n1"] [data-tab-panel-id="p1"]')!)
    expect(drag.nodeDrags).toEqual([{ workspaceId: 'ws', canvasId: 'c1', nodeId: 'n1', panelId: 'p1' }])
    expect(drag.tabDrags).toEqual([])
  })

  it('a press on a selected node drags the whole group without collapsing the selection', () => {
    const store = open(twoNodes())
    act(() => store.getState().selectNodes(['n1', 'n2']))
    render(store, ['n1', 'n2'])
    mouseDown(container.querySelector('[data-node-id="n1"] .dock-tab-bar')!)
    expect(store.getState().selection).toEqual(['n1', 'n2'])
    expect(drag.nodeDrags).toHaveLength(1)
    expect(drag.nodeDrags[0]).toMatchObject({
      nodeId: 'n1',
      startOrigin: { x: 100, y: 100 },
      members: [{ nodeId: 'n2', startOrigin: { x: 500, y: 100 } }],
    })
  })

  it('the dim overlay of an unfocused group member starts the group drag', () => {
    const store = open(twoNodes())
    act(() => store.getState().selectNodes(['n1', 'n2']))
    render(store, ['n1', 'n2'])
    mouseDown(container.querySelector('[data-node-id="n2"] [data-unfocused-overlay]')!)
    expect(store.getState().selection).toEqual(['n1', 'n2'])
    expect(drag.nodeDrags[0]).toMatchObject({ nodeId: 'n2', members: [{ nodeId: 'n1' }] })
  })

  it('a tab press in a multi-tab node detaches that tab', () => {
    let doc = twoNodes()
    doc = applyOp(doc, {
      kind: 'addPanel',
      record: { id: 'p3', type: 'terminal', title: 'p3', fields: {} },
      at: { to: 'stack', dock: { canvasId: 'c1', nodeId: 'n1' }, stackId: 'stack-n1' },
    }).doc
    const store = open(doc)
    render(store, ['n1'])
    mouseDown(container.querySelector('[data-node-id="n1"] [data-tab-panel-id="p3"]')!)
    expect(drag.tabDrags).toEqual([{ workspaceId: 'ws', canvasId: 'c1', nodeId: 'n1', stackId: 'stack-n1', panelId: 'p3' }])
    expect(drag.nodeDrags).toEqual([])
  })

  it('a locked node does not drag', () => {
    const store = open(twoNodes())
    act(() => store.getState().togglePin('n1'))
    render(store, ['n1'])
    mouseDown(container.querySelector('[data-node-id="n1"] .dock-tab-bar')!)
    expect(drag.nodeDrags).toEqual([])
  })
})
