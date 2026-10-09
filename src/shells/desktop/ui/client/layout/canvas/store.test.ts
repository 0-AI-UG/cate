import { afterEach, describe, expect, it, vi } from 'vitest'
import { rect } from '@workspace/canvas/contract'
import { createClientStateStore } from '@client/document'
import { createCanvasView } from './store'
import { focusedNodeId } from './selection'
import { canvasDocument, fakeDocument } from './testing.canvas'

const nodes = [
  { nodeId: 'a', panelId: 'pa', rect: rect(0, 0, 400, 300) },
  { nodeId: 'b', panelId: 'pb', rect: rect(500, 0, 400, 300) },
  { nodeId: 'c', panelId: 'pc', rect: rect(0, 400, 400, 300) },
]

function setup(options: { animate?: boolean } = {}) {
  const document = fakeDocument(canvasDocument(nodes))
  const clientState = createClientStateStore()
  let n = 0
  const store = createCanvasView({ workspaceId: 'ws', canvasId: 'c1', document, clientState, animate: options.animate ?? false, newId: () => `id-${++n}` })
  store.getState().setContainerSize({ width: 1000, height: 800 })
  return { store, document, clientState }
}

afterEach(() => vi.useRealTimers())

describe('canvas view store', () => {
  it('derives nodes from the document in creation order', () => {
    const { store } = setup()
    const s = store.getState()
    expect(Object.keys(s.nodes)).toEqual(['a', 'b', 'c'])
    expect(s.nodes.b.origin).toEqual({ x: 500, y: 0 })
    expect(s.nodes.b.rect.origin).toBe(s.nodes.b.origin)
    expect(s.sortedNodesByCreationOrder().map((node) => node.creationIndex)).toEqual([0, 1, 2])
  })

  it('keeps node identity across pan and zoom', () => {
    const { store } = setup()
    const before = store.getState().nodes
    store.getState().setViewportOffset({ x: 10, y: 20 })
    store.getState().setZoom(2)
    expect(store.getState().nodes).toBe(before)
  })

  it('previews a move locally and sends one op on commit', () => {
    const { store, document } = setup()
    store.getState().moveNode('a', { x: 10, y: 10 })
    store.getState().moveNode('a', { x: 20, y: 30 })
    expect(store.getState().nodes.a.origin).toEqual({ x: 20, y: 30 })
    expect(document.proposed).toHaveLength(0)
    store.getState().commitPreview()
    expect(document.proposed).toEqual([{ kind: 'setNodeRects', canvasId: 'c1', rects: [{ nodeId: 'a', rect: rect(20, 30, 400, 300) }] }])
    expect(store.getState().preview).toEqual({})
    expect(document.getSnapshot().canvases.c1.nodes.a.rect.origin).toEqual({ x: 20, y: 30 })
  })

  it('sends nothing when a gesture ends where it started', () => {
    const { store, document } = setup()
    store.getState().moveNode('a', { x: 0, y: 0 })
    store.getState().commitPreview()
    expect(document.proposed).toHaveLength(0)
  })

  it('arranges with one op each', () => {
    const { store, document } = setup()
    store.getState().autoLayout()
    expect(document.proposed).toHaveLength(1)
    expect(document.proposed[0]).toMatchObject({ kind: 'setNodeRects', canvasId: 'c1' })
    store.getState().selectNodes(['a', 'b'])
    store.getState().stackSelected('column')
    expect(document.proposed).toHaveLength(2)
    store.getState().tidyGridSelected()
    expect(document.proposed).toHaveLength(3)
  })

  it('focus activates, raises and focuses the node panel in client state', () => {
    const { store, clientState } = setup()
    const zBefore = store.getState().nodes.a.zOrder
    store.getState().focusNode('a')
    const s = store.getState()
    expect(focusedNodeId(s)).toBe('a')
    expect(s.nodes.a.zOrder).toBeGreaterThan(zBefore)
    expect(s.nodes.a.zOrder).toBeGreaterThan(s.nodes.c.zOrder)
    expect(clientState.getSnapshot().focusedPanelId).toBe('pa')
    expect(clientState.getSnapshot().selection.c1).toEqual({ nodes: ['a'], active: 'a' })
  })

  it('pure selection never activates', () => {
    const { store } = setup()
    store.getState().focusNode('a')
    store.getState().selectNodes(['b', 'c'], true)
    expect(store.getState().selection).toEqual(['a', 'b', 'c'])
    expect(focusedNodeId(store.getState())).toBeNull()
  })

  it('returns focus to the canvas panel when the selection loses its active node', () => {
    const { store, clientState } = setup()
    store.getState().focusNode('a')
    expect(clientState.getSnapshot().focusedPanelId).toBe('pa')
    store.getState().selectNodes(['b'], true)
    expect(clientState.getSnapshot().selection.c1).toEqual({ nodes: ['a', 'b'], active: null })
    expect(clientState.getSnapshot().focusedPanelId).toBe('canvas-panel')
  })

  it('leaves focus held outside the canvas alone', () => {
    const { store, clientState } = setup()
    store.getState().focusNode('a')
    clientState.focus('elsewhere')
    store.getState().unfocus()
    expect(clientState.getSnapshot().focusedPanelId).toBe('elsewhere')
  })

  it('drops a removed node from the selection', () => {
    const { store, document } = setup()
    store.getState().focusNode('b')
    document.propose({ kind: 'removePanels', ids: ['pb'] })
    expect(store.getState().nodes.b).toBeUndefined()
    expect(store.getState().selection).toEqual([])
    expect(store.getState().selectionActive).toBe(false)
  })

  it('plays an exit for a closed node, then drops it', () => {
    vi.useFakeTimers()
    const { store, document } = setup({ animate: true })
    document.propose({ kind: 'removePanels', ids: ['pb'] })
    expect(store.getState().nodes.b.animationState).toBe('exiting')
    expect(store.getState().nodeForPanel('pb')).toBeNull()
    vi.advanceTimersByTime(250)
    expect(store.getState().nodes.b).toBeUndefined()
  })

  it('new nodes enter after the first sync', () => {
    const { store, document } = setup({ animate: true })
    expect(store.getState().nodes.a.animationState).toBe('idle')
    document.propose({
      kind: 'addPanel',
      record: { id: 'pd', type: 'terminal', title: 'd', fields: {} },
      at: { to: 'canvas', canvasId: 'c1', nodeId: 'd', stackId: 'sd', rect: rect(900, 900, 100, 100) },
    })
    expect(store.getState().nodes.d.animationState).toBe('entering')
  })

  it('places a panel on a free spot with one placePanel op', () => {
    const { store, document } = setup()
    document.propose({
      kind: 'addPanel',
      record: { id: 'loose', type: 'terminal', title: 'loose', fields: {} },
      at: { to: 'stack', dock: { windowId: 'main', layoutId: 'main' }, stackId: 'main-stack' },
    })
    const nodeId = store.getState().placePanel('loose', { size: { width: 400, height: 300 } })
    expect(nodeId).not.toBeNull()
    const placed = document.proposed.at(-1)
    expect(placed).toMatchObject({ kind: 'placePanel', id: 'loose', at: { to: 'canvas', canvasId: 'c1' } })
    const node = store.getState().nodes[nodeId!]
    for (const other of ['a', 'b', 'c']) {
      const o = store.getState().nodes[other].rect
      const overlap = !(node.origin.x + 400 <= o.origin.x || o.origin.x + o.size.width <= node.origin.x
        || node.origin.y + 300 <= o.origin.y || o.origin.y + o.size.height <= node.origin.y)
      expect(overlap).toBe(false)
    }
    expect(focusedNodeId(store.getState())).toBe(nodeId)
  })

  it('pins and z-order are client state', () => {
    const { store, document } = setup()
    store.getState().togglePin('a')
    store.getState().moveToBack('b')
    expect(store.getState().nodes.a.isPinned).toBe(true)
    expect(store.getState().nodes.b.zOrder).toBeLessThan(store.getState().nodes.a.zOrder)
    expect(document.proposed).toHaveLength(0)
  })

  it('navigates to the nearest node in a direction', () => {
    const { store } = setup()
    store.getState().focusNode('a')
    store.getState().navigateDirection('right')
    expect(focusedNodeId(store.getState())).toBe('b')
    store.getState().navigateSelect('left')
    expect(store.getState().selection).toEqual(['a'])
    expect(store.getState().selectionActive).toBe(false)
  })

  it('offers placement candidates and places through the caller', () => {
    const { store } = setup()
    const place = vi.fn(() => 'new-node')
    const onCancelled = vi.fn()
    const zoom = store.getState().zoomLevel
    expect(store.getState().beginPanelTarget({ panelType: 'terminal', availability: 'new', existing: [], size: { width: 400, height: 300 }, place, onCancelled })).toBe(true)
    const pending = store.getState().pendingPanelTarget!
    expect(pending.candidates.length).toBeGreaterThan(0)
    expect(store.getState().selectNewPanelTarget(0)).toBe('new-node')
    expect(place).toHaveBeenCalledWith(pending.candidates[0].point, pending.candidates[0].size)
    expect(store.getState().pendingPanelTarget).toBeNull()
    expect(store.getState().zoomLevel).toBe(zoom)
    expect(onCancelled).not.toHaveBeenCalled()
  })

  it('cancelling a target restores the camera', () => {
    const { store } = setup()
    store.getState().setZoomAndOffset(1.7, { x: 33, y: 44 })
    const onCancelled = vi.fn()
    store.getState().beginPanelTarget({ panelType: 'terminal', availability: 'both', existing: [{ panelId: 'pb', title: 'b' }], size: { width: 400, height: 300 }, onCancelled })
    store.getState().cancelPanelTarget()
    expect(onCancelled).toHaveBeenCalledOnce()
    expect(store.getState().zoomLevel).toBe(1.7)
    expect(store.getState().viewportOffset).toEqual({ x: 33, y: 44 })
  })

  it('mirrors the settled viewport into client state', () => {
    vi.useFakeTimers()
    const { store, clientState } = setup()
    store.getState().setZoomAndOffset(2, { x: 5, y: 6 })
    expect(clientState.getSnapshot().viewports.c1).toBeUndefined()
    vi.advanceTimersByTime(300)
    expect(clientState.getSnapshot().viewports.c1).toEqual({ x: 5, y: 6, zoom: 2 })
  })

  it('starts from the viewport client state remembers', () => {
    const document = fakeDocument(canvasDocument(nodes))
    const clientState = createClientStateStore()
    clientState.setViewport('c1', { x: 7, y: 8, zoom: 1.5 })
    const store = createCanvasView({ workspaceId: 'ws', canvasId: 'c1', document, clientState, animate: false })
    expect(store.getState().zoomLevel).toBe(1.5)
    expect(store.getState().viewportOffset).toEqual({ x: 7, y: 8 })
  })
})
