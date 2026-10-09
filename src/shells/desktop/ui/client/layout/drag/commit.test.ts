import { beforeAll, describe, expect, it } from 'vitest'
import {
  MAIN_WINDOW,
  applyOp,
  dockOf,
  dockPanels,
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

const main = { windowId: MAIN_WINDOW, layoutId: 'main' }
const rect = (x: number, y: number) => ({ origin: { x, y }, size: { width: 400, height: 300 } })

function fixture(): WorkspaceDocument {
  return buildDocument([
    add('cv', { to: 'stack', dock: main, stackId: 's1' }, 'canvas', { canvasId: 'C' }),
    add('p1', { to: 'stack', dock: main, stackId: 's1' }),
    add('p2', { to: 'stack', dock: main, stackId: 's1' }),
    add('p3', { to: 'split', dock: main, beside: 's1', side: 'right', stackId: 's2', splitId: 'sp' }),
    add('a', { to: 'canvas', canvasId: 'C', nodeId: 'N1', stackId: 'ns1', rect: rect(0, 0) }),
    add('b', { to: 'canvas', canvasId: 'C', nodeId: 'N2', stackId: 'ns2', rect: rect(500, 0) }),
    add('c', { to: 'stack', dock: { canvasId: 'C', nodeId: 'N2' }, stackId: 'ns2' }),
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
  workspaceId: 'ws', panelId, origin: { kind: 'dock-tab', dock, stackId },
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
    expect(placement?.dock).toMatchObject({ canvasId: 'C' })
    const nodeId = (placement!.dock as { nodeId: string }).nodeId
    expect(next.canvases.C.nodes[nodeId].rect).toEqual({ origin: { x: 40, y: 800 }, size: { width: 480, height: 320 } })
  })

  it('canvas-node tab bar and edge: a tab or split pane there', () => {
    const doc = fixture()
    const n1 = { canvasId: 'C', nodeId: 'N1' }
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
    expect(dockPanels(dockOf(run(doc, changes), { canvasId: 'C', nodeId: 'N2' }))).toEqual(['b', 'c'])
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
    const next = run(doc, dropChanges(doc, nodeSource('N1', 'a'), { kind: 'dock-tab', workspaceId: 'ws', dock: { canvasId: 'C', nodeId: 'N2' }, stackId: 'ns2' }, panel(doc, 'a'), ctx))
    expect(next.canvases.C.nodes.N1).toBeUndefined()
    expect(dockPanels(dockOf(next, { canvasId: 'C', nodeId: 'N2' }))).toEqual(['b', 'c', 'a'])
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
