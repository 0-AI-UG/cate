import { beforeAll, describe, expect, it } from 'vitest'
import {
  MAIN_WINDOW,
  applyOp,
  canvasOf,
  dockOf,
  dockPanels,
  nodeOfPanel,
  placementOf,
  type DocChange,
  type DockRef,
  type WorkspaceDocument,
} from '@workspace/document/contract'
import { registerPanelDefinitions } from '@client/host'
import { add, buildDocument, testPanelDefinitions } from '../../../../../../test/clientWorkspace'
import { detachBounds, detachChange, dropChanges } from './commit'
import type { DragPanel, DragSource, DropTarget } from './types'

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

const main = { layoutId: 'main' }
const rect = (x: number, y: number) => ({ origin: { x, y }, size: { width: 400, height: 300 } })

function fixture(): WorkspaceDocument {
  return buildDocument([
    add('cv', { to: 'stack', dock: main, stackId: 's1' }, 'canvas', { canvasId: 'C' }),
    add('p1', { to: 'stack', dock: main, stackId: 's1' }),
    add('p2', { to: 'stack', dock: main, stackId: 's1' }),
    add('p3', { to: 'split', dock: main, beside: 's1', side: 'right', stackId: 's2', splitId: 'sp' }),
    add('a', { to: 'canvas', canvasId: 'C', nodeId: 'N1', layoutId: 'L-N1', stackId: 'ns1', rect: rect(0, 0) }),
    add('b', { to: 'canvas', canvasId: 'C', nodeId: 'N2', layoutId: 'L-N2', stackId: 'ns2', rect: rect(500, 0) }),
    add('c', { to: 'stack', dock: { layoutId: 'L-N2' }, stackId: 'ns2' }),
  ])
}

let ids = 0
const ctx = { newId: () => `id${++ids}` }
let counter = 0
function run(doc: WorkspaceDocument, changes: DocChange[] | null): WorkspaceDocument {
  expect(changes).not.toBeNull()
  const op = { kind: 'batch', changes: changes!, opId: { clientId: 't', counter: ++counter } } as Parameters<typeof applyOp>[1]
  const result = applyOp(doc, op)
  expect(result.error).toBeUndefined()
  return result.doc
}

const panel = (doc: WorkspaceDocument, id: string): DragPanel => ({ id, type: doc.panels[id].type, title: id })
const tab = (stackId: string, panelId: string, dock: DockRef = main): DragSource => ({
  workspaceId: 'ws', panelId, origin: { kind: 'dock-tab', dock, host: { windowId: 'main' }, stackId },
})
const nodeSource = (nodeId: string, panelId: string, extra: object = {}): DragSource => ({
  workspaceId: 'ws', panelId, origin: { kind: 'canvas-node', canvasId: 'C', nodeId, ...extra },
})

describe('dock tab drops', () => {
  it('same stack tab bar: the tab moves to the end', () => {
    const doc = fixture()
    const next = run(doc, dropChanges(doc, tab('s1', 'p1'), { kind: 'dock-tab', workspaceId: 'ws', dock: main, stackId: 's1' }, panel(doc, 'p1'), ctx))
    expect(dockOf(next, main)).toMatchObject({ children: [{ panels: ['cv', 'p2', 'p1'] }, { panels: ['p3'] }] })
  })

  it('a lone tab dropped on its own tab bar is a no-op', () => {
    const doc = fixture()
    expect(dropChanges(doc, tab('s2', 'p3'), { kind: 'dock-tab', workspaceId: 'ws', dock: main, stackId: 's2' }, panel(doc, 'p3'), ctx)).toBeNull()
  })

  it('another stack tab bar: it becomes a tab there', () => {
    const doc = fixture()
    const next = run(doc, dropChanges(doc, tab('s1', 'p1'), { kind: 'dock-tab', workspaceId: 'ws', dock: main, stackId: 's2' }, panel(doc, 'p1'), ctx))
    expect(placementOf(next, 'p1')?.stackId).toBe('s2')
  })

  it('left and top edges insert before, right and bottom after; same direction stays flat', () => {
    const doc = fixture()
    const left = run(doc, dropChanges(doc, tab('s1', 'p2'), { kind: 'dock-split', workspaceId: 'ws', dock: main, stackId: 's2', edge: 'left' }, panel(doc, 'p2'), ctx))
    const tree = dockOf(left, main)
    expect(tree?.kind === 'split' && tree.children.map((c) => dockPanels(c))).toEqual([['cv', 'p1'], ['p2'], ['p3']])
    const bottom = run(doc, dropChanges(doc, tab('s1', 'p2'), { kind: 'dock-split', workspaceId: 'ws', dock: main, stackId: 's2', edge: 'bottom' }, panel(doc, 'p2'), ctx))
    const right = dockOf(bottom, main)
    expect(right?.kind === 'split' && right.children[1]).toMatchObject({ kind: 'split', direction: 'vertical' })
    expect(dockPanels(right?.kind === 'split' ? right.children[1] : null)).toEqual(['p3', 'p2'])
  })

  it('empty canvas: a new node holding the panel', () => {
    const doc = fixture()
    const target: DropTarget = { kind: 'canvas-add', workspaceId: 'ws', canvasId: 'C', origin: { x: 40, y: 800 }, size: { width: 480, height: 320 }, zoom: 1 }
    const next = run(doc, dropChanges(doc, tab('s1', 'p1'), target, panel(doc, 'p1'), ctx))
    const placement = placementOf(next, 'p1')
    expect(canvasOf(next, 'p1')).toBe('C')
    const nodeId = nodeOfPanel(next, 'p1')!.nodeId
    expect(next.canvases.C.nodes[nodeId].rect).toEqual({ origin: { x: 40, y: 800 }, size: { width: 480, height: 320 } })
  })

  it('canvas-node tab bar and edge: a tab or split pane there', () => {
    const doc = fixture()
    const n1 = { layoutId: 'L-N1' }
    const asTab = run(doc, dropChanges(doc, tab('s1', 'p1'), { kind: 'dock-tab', workspaceId: 'ws', dock: n1, stackId: 'ns1' }, panel(doc, 'p1'), ctx))
    expect(dockPanels(dockOf(asTab, n1))).toEqual(['a', 'p1'])
    const asSplit = run(doc, dropChanges(doc, tab('s1', 'p1'), { kind: 'dock-split', workspaceId: 'ws', dock: n1, stackId: 'ns1', edge: 'right' }, panel(doc, 'p1'), ctx))
    expect(dockOf(asSplit, n1)).toMatchObject({ kind: 'split', direction: 'horizontal' })
  })

  it('a canvas panel never lands on a canvas', () => {
    const doc = fixture()
    const target: DropTarget = { kind: 'canvas-add', workspaceId: 'ws', canvasId: 'C', origin: { x: 0, y: 0 }, size: { width: 1, height: 1 }, zoom: 1 }
    expect(dropChanges(doc, tab('s1', 'cv'), target, panel(doc, 'cv'), ctx)).toBeNull()
  })

  it('a window edge strip splits the whole dock', () => {
    const doc = fixture()
    const next = run(doc, dropChanges(doc, tab('s1', 'p1'), { kind: 'dock-zone', workspaceId: 'ws', dock: main, edge: 'bottom' }, panel(doc, 'p1'), ctx))
    const tree = dockOf(next, main)
    expect(tree).toMatchObject({ kind: 'split', direction: 'vertical' })
    expect(tree?.kind === 'split' && dockPanels(tree.children[1])).toEqual(['p1'])
  })
})

describe('canvas node drops', () => {
  it('empty area of the same canvas: one setNodeRects keeping size', () => {
    const doc = fixture()
    const changes = dropChanges(doc, nodeSource('N2', 'b'), { kind: 'canvas-reposition', workspaceId: 'ws', canvasId: 'C', nodeId: 'N2', origin: { x: 60, y: 900 }, zoom: 1 }, panel(doc, 'b'), ctx)
    expect(changes).toEqual([{ kind: 'setNodeRects', canvasId: 'C', rects: [{ nodeId: 'N2', rect: { origin: { x: 60, y: 900 }, size: { width: 400, height: 300 } } }] }])
    expect(dockPanels(dockOf(run(doc, changes), { layoutId: 'L-N2' }))).toEqual(['b', 'c'])
  })

  it('a group moves every member by the anchor delta in the same op', () => {
    const doc = fixture()
    const source = nodeSource('N1', 'a', { startOrigin: { x: 0, y: 0 }, members: [{ nodeId: 'N2', startOrigin: { x: 500, y: 0 } }] })
    const next = run(doc, dropChanges(doc, source, { kind: 'canvas-reposition', workspaceId: 'ws', canvasId: 'C', nodeId: 'N1', origin: { x: 20, y: 40 }, zoom: 1 }, panel(doc, 'a'), ctx))
    expect(next.canvases.C.nodes.N1.rect.origin).toEqual({ x: 20, y: 40 })
    expect(next.canvases.C.nodes.N2.rect.origin).toEqual({ x: 520, y: 40 })
  })

  it('another node tab bar: merges as a tab and removes the emptied node', () => {
    const doc = fixture()
    const next = run(doc, dropChanges(doc, nodeSource('N1', 'a'), { kind: 'dock-tab', workspaceId: 'ws', dock: { layoutId: 'L-N2' }, stackId: 'ns2' }, panel(doc, 'a'), ctx))
    expect(next.canvases.C.nodes.N1).toBeUndefined()
    expect(dockPanels(dockOf(next, { layoutId: 'L-N2' }))).toEqual(['b', 'c', 'a'])
  })

  it('main dock tab bar and edge', () => {
    const doc = fixture()
    const asTab = run(doc, dropChanges(doc, nodeSource('N1', 'a'), { kind: 'dock-tab', workspaceId: 'ws', dock: main, stackId: 's2' }, panel(doc, 'a'), ctx))
    expect(placementOf(asTab, 'a')?.stackId).toBe('s2')
    const asSplit = run(doc, dropChanges(doc, nodeSource('N1', 'a'), { kind: 'dock-split', workspaceId: 'ws', dock: main, stackId: 's2', edge: 'top' }, panel(doc, 'a'), ctx))
    expect(placementOf(asSplit, 'a')?.dock).toEqual(main)
  })

  it('outside the window: a new detached window, opened here at the drop point', () => {
    const doc = fixture()
    const next = run(doc, [detachChange(panel(doc, 'b'), 'W9', ctx.newId)])
    expect(next.windows.W9).toMatchObject({ kind: 'detached' })
    expect(next.windows.W9).not.toHaveProperty('bounds')
    expect(dockPanels(next.windows.W9.layouts[0].dock)).toEqual(['b'])
    expect(detachBounds({ x: 900, y: 500 }, { x: 12, y: 12 }, { width: 400, height: 300 })).toEqual({ origin: { x: 888, y: 488 }, size: { width: 400, height: 300 } })
  })
})

describe('tab strip drops', () => {
  const host = { windowId: 'main' }
  // Layouts: main [cv, p1, p2 | p3], T1 [x], T2 [y], T3 [z].
  const strip = (): WorkspaceDocument => buildDocument([
    add('p1', { to: 'stack', dock: main, stackId: 's1' }),
    add('p3', { to: 'split', dock: main, beside: 's1', side: 'right', stackId: 's2', splitId: 'sp' }),
    add('x', { to: 'tab', host, layoutId: 'T1', stackId: 'sx' }),
    add('y', { to: 'tab', host, layoutId: 'T2', stackId: 'sy' }),
    add('z', { to: 'tab', host, layoutId: 'T3', stackId: 'sz' }),
  ])
  const ids = (doc: WorkspaceDocument) => doc.windows.main.layouts.map((l) => l.id)
  const slot = (index: number): DropTarget => ({ kind: 'tab-slot', workspaceId: 'ws', host, index })
  const source = (panelId: string, doc: WorkspaceDocument): DragSource => {
    const placement = placementOf(doc, panelId)!
    return tab(placement.stackId, panelId, placement.dock)
  }
  const layoutSource = (layoutId: string, panelId: string): DragSource => ({ workspaceId: 'ws', panelId, origin: { kind: 'layout', host, layoutId } })

  it('a lone tab dropped on a later gap moves there; its own gaps do nothing', () => {
    const doc = strip()
    const drop = (index: number) => dropChanges(doc, source('x', doc), slot(index), panel(doc, 'x'), ctx)
    expect(drop(1)).toBeNull() // right before itself
    expect(drop(2)).toBeNull() // right after itself
    expect(ids(run(doc, drop(4)))).toEqual(['main', 'T2', 'T3', 'T1'])
    expect(ids(run(doc, dropChanges(doc, source('z', doc), slot(0), panel(doc, 'z'), ctx)))).toEqual(['T3', 'main', 'T1', 'T2'])
  })

  it('a pane of a group dropped on a gap becomes a plain tab there', () => {
    const doc = strip()
    const next = run(doc, dropChanges(doc, source('p3', doc), slot(2), panel(doc, 'p3'), ctx))
    expect(ids(next)).toEqual(['main', 'T1', expect.any(String), 'T2', 'T3'])
    expect(dockPanels(dockOf(next, main))).toEqual(['p1'])
    expect(placementOf(next, 'p3')?.dock.layoutId).toBe(ids(next)[2])
  })

  it('a dragged layout moves along the strip', () => {
    const doc = strip()
    const drop = (index: number) => dropChanges(doc, layoutSource('main', 'p1'), slot(index), panel(doc, 'p1'), ctx)
    expect(drop(0)).toBeNull()
    expect(drop(1)).toBeNull()
    expect(ids(run(doc, drop(4)))).toEqual(['T1', 'T2', 'T3', 'main'])
    expect(ids(run(doc, dropChanges(doc, layoutSource('T3', 'z'), slot(1), panel(doc, 'z'), ctx)))).toEqual(['main', 'T3', 'T1', 'T2'])
  })

  it('a panel dropped in a group becomes a pane beside the chip next to the gap', () => {
    const doc = strip()
    const target: DropTarget = { kind: 'group-slot', workspaceId: 'ws', layoutId: 'main', beside: 's2', side: 'right', slot: 2 }
    const next = run(doc, dropChanges(doc, source('x', doc), target, panel(doc, 'x'), ctx))
    expect(ids(next)).toEqual(['main', 'T2', 'T3'])
    expect(dockOf(next, main)).toMatchObject({ children: [{ panels: ['p1'] }, { panels: ['p3'] }, { panels: ['x'] }] })
  })

  it('a pane dropped beside itself stays put', () => {
    const doc = strip()
    const target: DropTarget = { kind: 'group-slot', workspaceId: 'ws', layoutId: 'main', beside: 's2', side: 'left', slot: 1 }
    expect(dropChanges(doc, source('p3', doc), target, panel(doc, 'p3'), ctx)).toBeNull()
  })
})

describe('layout drops across hosts', () => {
  const main = { windowId: 'main' }
  const doc = (): WorkspaceDocument => buildDocument([
    add('cv', { to: 'stack', dock: { layoutId: 'main' }, stackId: 's1' }, 'canvas', { canvasId: 'C' }),
    add('x', { to: 'tab', host: main, layoutId: 'T1', layoutName: 'Notes', stackId: 'sx' }),
    add('y', { to: 'window', windowId: 'W2', layoutId: 'T2', layoutName: 'Other', stackId: 'sy' }),
  ])
  const layoutSource = (layoutId: string, panelId: string, host: { windowId: string }): DragSource => ({ workspaceId: 'ws', panelId, origin: { kind: 'layout', host, layoutId } })
  const slot: DropTarget = { kind: 'tab-slot', workspaceId: 'ws', host: { windowId: 'W2' }, index: 0 }

  it('a layout dropped on another window strip moves there', () => {
    const d = doc()
    const next = run(d, dropChanges(d, layoutSource('T1', 'x', main), slot, panel(d, 'x'), ctx))
    expect(next.windows.W2.layouts.map((l) => l.id)).toEqual(['T1', 'T2'])
  })

  it('a lone tab moved to another window keeps its layout name', () => {
    const d = doc()
    const placement = placementOf(d, 'x')!
    const source: DragSource = { workspaceId: 'ws', panelId: 'x', origin: { kind: 'dock-tab', dock: placement.dock, host: main, stackId: placement.stackId } }
    const next = run(d, dropChanges(d, source, slot, panel(d, 'x'), ctx))
    expect(next.windows.W2.layouts[0]).toMatchObject({ id: 'T1', name: 'Notes' })
  })

  it('a layout dropped on a canvas becomes a node', () => {
    const d = doc()
    const target: DropTarget = { kind: 'canvas-add', workspaceId: 'ws', canvasId: 'C', origin: { x: 5, y: 6 }, size: { width: 300, height: 200 }, zoom: 1 }
    const next = run(d, dropChanges(d, layoutSource('T1', 'x', main), target, panel(d, 'x'), ctx))
    expect(canvasOf(next, 'x')).toBe('C')
    expect(next.windows.main.layouts.map((l) => l.id)).not.toContain('T1')
  })
})

describe('slot drops (the tree)', () => {
  const stackSlot = (stackId: string | null, after: string | null, layoutId = 'main'): DropTarget => ({ kind: 'stack-slot', workspaceId: 'ws', layoutId, stackId, after })
  const canvasSlot = (canvasPanelId: string): DropTarget => ({ kind: 'canvas-slot', workspaceId: 'ws', canvasPanelId, after: null, order: [] })

  it('stack-slot after a neighbour places the panel into that stack', () => {
    const doc = fixture()
    const next = run(doc, dropChanges(doc, tab('s2', 'p3'), stackSlot('s1', 'p1'), panel(doc, 'p3'), ctx))
    expect(dockPanels(dockOf(next, main))).toEqual(['cv', 'p1', 'p3', 'p2'])
  })

  it("stack-slot on the panel's own spot returns null", () => {
    const doc = fixture()
    expect(dropChanges(doc, tab('s1', 'p2'), stackSlot('s1', 'p1'), panel(doc, 'p2'), ctx)).toBeNull()
    expect(dropChanges(doc, tab('s1', 'cv'), stackSlot('s1', null), panel(doc, 'cv'), ctx)).toBeNull()
  })

  it('stack-slot with stackId null creates a stack', () => {
    const doc = buildDocument([
      add('p1', { to: 'stack', dock: main, stackId: 's1' }),
      { kind: 'addLayout', host: { windowId: MAIN_WINDOW }, layoutId: 'empty' },
    ])
    expect(dropChanges(doc, tab('s1', 'p1'), stackSlot(null, null, 'empty'), panel(doc, 'p1'), { newId: () => 'new' }))
      .toEqual([{ kind: 'placePanel', id: 'p1', at: { to: 'stack', dock: { layoutId: 'empty' }, stackId: 'new', after: null } }])
  })

  it('canvas-slot adds a canvas node', () => {
    const doc = fixture()
    const next = run(doc, dropChanges(doc, tab('s1', 'p1'), canvasSlot('cv'), panel(doc, 'p1'), ctx))
    expect(canvasOf(next, 'p1')).toBe('C')
  })

  it("canvas-slot on the panel's own canvas returns null", () => {
    const doc = fixture()
    expect(dropChanges(doc, nodeSource('N1', 'a'), canvasSlot('cv'), panel(doc, 'a'), ctx)).toBeNull()
  })

  it('canvas-slot for a canvas panel returns null (a canvas never nests)', () => {
    const doc = fixture()
    expect(dropChanges(doc, tab('s1', 'cv'), canvasSlot('cv'), panel(doc, 'cv'), ctx)).toBeNull()
  })
})

describe('canvas-node drops on tree slots', () => {
  const stackSlot = (stackId: string | null, after: string | null, layoutId = 'main'): DropTarget => ({ kind: 'stack-slot', workspaceId: 'ws', layoutId, stackId, after })

  it('a canvas node dropped on a stack-slot moves to that stack and removes the emptied node', () => {
    const doc = fixture()
    const next = run(doc, dropChanges(doc, nodeSource('N1', 'a'), stackSlot('s2', null, 'main'), panel(doc, 'a'), ctx))
    expect(next.canvases.C.nodes.N1).toBeUndefined()
    expect(placementOf(next, 'a')?.stackId).toBe('s2')
    expect(dockPanels(dockOf(next, main))).toContain('a')
  })

  it('a canvas node with a lone panel dropped on a tab-slot moves its layout there', () => {
    const doc = fixture()
    const host = { windowId: 'main' }
    const next = run(doc, dropChanges(doc, nodeSource('N1', 'a'), { kind: 'tab-slot', workspaceId: 'ws', host, index: 2 }, panel(doc, 'a'), ctx))
    expect(next.canvases.C.nodes.N1).toBeUndefined()
    expect(next.windows.main.layouts.map((l) => l.id)).toContain('L-N1')
  })

  it('a canvas node with multiple panels dropped on a tab-slot creates a new tab', () => {
    const doc = fixture()
    const host = { windowId: 'main' }
    // Add another panel to the node's layout so it's not a lone panel
    const docWithExtra = run(doc, [{ kind: 'placePanel', id: 'p1', at: { to: 'stack', dock: { layoutId: 'L-N1' }, stackId: 'ns1' } }])
    const next = run(docWithExtra, dropChanges(docWithExtra, nodeSource('N1', 'a'), { kind: 'tab-slot', workspaceId: 'ws', host, index: 2 }, panel(docWithExtra, 'a'), ctx))
    // The node layout should still exist
    expect(next.canvases.C.nodes.N1).toBeDefined()
    // 'a' should be in the new tab
    expect(placementOf(next, 'a')?.dock.layoutId).not.toBe('L-N1')
  })
})
