import { beforeAll, describe, expect, it } from 'vitest'
import { registerPanelDefinitions } from '@client/host'
import { MAIN_WINDOW } from '@workspace/document/contract'
import { add, buildDocument, testPanelDefinitions } from '../../../../../test/clientWorkspace'
import { workspacePanelTree } from './panelTree'
import { buildAxisModel } from '../../client/layout/drag'
import { CANVAS_EDGE, canvasOrderAt, itemKey, layoutKey, layoutRows, windowItems } from './sidebarDrag'

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

const L1 = { layoutId: 'main' }
const doc = buildDocument([
  add('a', { to: 'stack', dock: L1, stackId: 's1' }),
  add('b', { to: 'stack', dock: L1, stackId: 's1' }),
  add('c', { to: 'split', dock: L1, beside: 's1', side: 'right', stackId: 's2', splitId: 'sp' }),
  { kind: 'addLayout', host: { windowId: MAIN_WINDOW }, layoutId: 'two', name: 'Two' },
  add('d', { to: 'stack', dock: { layoutId: 'two' }, stackId: 's3' }),
  { kind: 'addLayout', host: { windowId: MAIN_WINDOW }, layoutId: 'empty' },
])
const tree = workspacePanelTree(doc).primary
// a 0-28, b 28-56, c 56-84 (a group), d 88-116 (a plain row); the empty layout draws nothing.
const rects: Record<string, { top: number; bottom: number }> = {
  [itemKey('a')]: { top: 0, bottom: 28 }, [itemKey('b')]: { top: 28, bottom: 56 }, [itemKey('c')]: { top: 56, bottom: 84 }, [itemKey('d')]: { top: 88, bottom: 116 },
  [layoutKey(MAIN_WINDOW, 'main')]: { top: 0, bottom: 84 }, [layoutKey(MAIN_WINDOW, 'two')]: { top: 88, bottom: 116 },
}
const rectOf = (key: string) => rects[key] ?? null

describe('the tree as the drag model sees it', () => {
  it('several panels make a group, one a plain row, none draws nothing', () => {
    expect(tree.layouts.map((l) => [l.layoutId, l.group])).toEqual([['main', true], ['two', false], ['empty', false]])
    expect(layoutRows(tree.layouts[0]).map((r) => [r.record.id, r.stackId])).toEqual([['a', 's1'], ['b', 's1'], ['c', 's2']])
  })

  it('a group\'s rows are its chips; an empty layout takes no room', () => {
    expect(windowItems(tree, rectOf)).toEqual([
      { layoutId: 'main', start: 0, end: 84, chips: [{ panelId: 'a', stackId: 's1', start: 0, end: 28 }, { panelId: 'b', stackId: 's1', start: 28, end: 56 }, { panelId: 'c', stackId: 's2', start: 56, end: 84 }] },
      { layoutId: 'two', start: 88, end: 116, panelId: 'd', chips: [] },
      { layoutId: 'empty', start: 116, end: 116, chips: [] },
    ])
  })
})

describe('canvas treatment', () => {
  const rect = { origin: { x: 0, y: 0 }, size: { width: 100, height: 100 } }
  const withCanvas = buildDocument([
    add('c1', { to: 'stack', dock: L1, stackId: 's1' }, 'canvas', { canvasId: 'cv' }),
    add('t1', { to: 'canvas', canvasId: 'cv', nodeId: 'n1', layoutId: 'L-n1', stackId: 'ns1', rect }),
    add('t2', { to: 'canvas', canvasId: 'cv', nodeId: 'n2', layoutId: 'L-n2', stackId: 'ns2', rect: { ...rect, origin: { x: 200, y: 0 } } }),
    add('x', { to: 'stack', dock: L1, stackId: 's1' }),
  ])
  const canvasTree = workspacePanelTree(withCanvas).primary
  // canvas group (row + children) 0-90, x 94-122.
  const crects: Record<string, { top: number; bottom: number; left?: number }> = {
    [itemKey('c1')]: { top: 0, bottom: 90, left: 0 }, [itemKey('t1')]: { top: 30, bottom: 58 }, [itemKey('t2')]: { top: 60, bottom: 88 },
    [itemKey('x')]: { top: 94, bottom: 122 }, [layoutKey(MAIN_WINDOW, 'main')]: { top: 0, bottom: 122 },
  }
  const items = (lifted: string) => windowItems(canvasTree, (k) => crects[k] ?? null, { lifted })

  it('a canvas is a container of its children: their rows and the room under them are its slots', () => {
    expect(items('x')[0]).toMatchObject({ layoutId: 'main', chips: [{ panelId: 'c1', canvas: { panelId: 'c1', kids: [{ panelId: 't1', start: 30, end: 58 }, { panelId: 't2', start: 60, end: 88 }] } }, { panelId: 'x' }] })
    // A panel that cannot live on a canvas gets no slots; the canvas itself is not a drop target of its own children.
    expect(windowItems(canvasTree, (k) => crects[k] ?? null)[0].chips[0].canvas).toBeUndefined()
    expect(items('t1')[0].chips[0].canvas?.kids.map((k) => k.panelId)).toEqual(['t2'])
  })

  it('pushing past the bottom edge from below goes into the canvas, past its row it goes before it', () => {
    const model = buildAxisModel(items('x'), { kind: 'panel', panelId: 'x' }, 108, undefined, { separator: 0, rowGap: 0, stackTabs: true, groupLead: 4, groupTail: 4, canvasTail: CANVAS_EDGE })
    const at = (edge: number) => model.solve(edge + model.grab).target
    // Its own spot (after the canvas) first, then up through the container's foot, its children, its row.
    expect(at(86)).toMatchObject({ kind: 'group-home' })
    expect(at(82)).toEqual({ kind: 'canvas-slot', canvasPanelId: 'c1', after: 't2' })
    expect(at(60)).toEqual({ kind: 'canvas-slot', canvasPanelId: 'c1', after: 't1' })
    expect(at(30)).toEqual({ kind: 'canvas-slot', canvasPanelId: 'c1', after: null })
    expect(at(4)).toMatchObject({ kind: 'group-slot', slot: 0 })
    expect(model.solve(82 + model.grab).gap).toEqual({ at: 'canvas-end', canvasPanelId: 'c1' })
  })

  it('the list order puts the dropped panel after its neighbour', () => {
    expect(canvasOrderAt([canvasTree], 'c1', 't1', 'x')).toEqual(['t1', 'x', 't2'])
    expect(canvasOrderAt([canvasTree], 'c1', null, 't2')).toEqual(['t2', 't1'])
  })
})
