import { beforeAll, describe, expect, it } from 'vitest'
import { registerPanelDefinitions } from '@client/host'
import { MAIN_WINDOW } from '@workspace/document/contract'
import { add, buildDocument, testPanelDefinitions } from '../../../../../test/clientWorkspace'
import { workspacePanelTree } from './panelTree'
import { headingKey, itemKey, layoutKey, layoutSlots, nearestSlot, panelDropChange, panelSlots as dropSlots, type CanvasSlot, type PanelSlot } from './sidebarDrag'

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

const L1 = { windowId: MAIN_WINDOW, layoutId: 'main' }
const doc = buildDocument([
  add('a', { to: 'stack', dock: L1, stackId: 's1' }),
  add('b', { to: 'stack', dock: L1, stackId: 's1' }),
  add('c', { to: 'split', dock: L1, beside: 's1', side: 'right', stackId: 's2', splitId: 'sp' }),
  { kind: 'addLayout', windowId: MAIN_WINDOW, layoutId: 'empty' },
])
const tree = workspacePanelTree(doc).primary
// a 0-28, b 30-58, c 66-94 (a split's gap before it), the empty layout's heading 100-120.
const rects: Record<string, { top: number; bottom: number }> = {
  [itemKey('a')]: { top: 0, bottom: 28 }, [itemKey('b')]: { top: 30, bottom: 58 }, [itemKey('c')]: { top: 66, bottom: 94 },
  [headingKey(MAIN_WINDOW, 'empty')]: { top: 100, bottom: 120 },
  [layoutKey(MAIN_WINDOW, 'main')]: { top: 0, bottom: 94 }, [layoutKey(MAIN_WINDOW, 'empty')]: { top: 100, bottom: 120 },
}
const rectOf = (key: string) => rects[key] ?? null
const panelSlots = (...args: Parameters<typeof dropSlots>) => dropSlots(...args) as PanelSlot[]

describe('sidebar drag slots', () => {
  it('groups a layout\'s panels by stack, in dock order', () => {
    expect(tree.layouts[0].stacks.map((s) => [s.stackId, s.items.map((i) => i.record.id)])).toEqual([['s1', ['a', 'b']], ['s2', ['c']]])
  })

  it('a slot sits at each boundary among the other rows; a split has its own end and start', () => {
    const slots = panelSlots([tree], 'a', rectOf).map((s) => [s.layoutId, s.stackId, s.after, s.y])
    expect(slots).toEqual([
      ['main', 's1', null, 30], ['main', 's1', 'b', 58],
      ['main', 's2', null, 66], ['main', 's2', 'c', 94],
      ['empty', null, null, 120],
    ])
  })

  it('the cursor takes the nearest boundary; the gap between splits belongs to whichever side is closer', () => {
    const slots = panelSlots([tree], 'a', rectOf)
    expect(nearestSlot(slots, 59)).toMatchObject({ stackId: 's1', after: 'b' })
    expect(nearestSlot(slots, 64)).toMatchObject({ stackId: 's2', after: null })
    expect(nearestSlot(slots, 400)).toMatchObject({ layoutId: 'empty' })
  })

  it('a lone row keeps its own spot', () => {
    expect(panelSlots([tree], 'c', rectOf).filter((s) => s.stackId === 's2').map((s) => [s.after, s.y])).toEqual([[null, 66]])
  })

  it('layout slots count the other layouts', () => {
    expect(layoutSlots(tree, 'main', rectOf)).toEqual([
      { windowId: MAIN_WINDOW, index: 0, y: 100 },
      { windowId: MAIN_WINDOW, index: 1, y: 120 },
    ])
  })

  it('dropping where a panel already is changes nothing; elsewhere it places after the neighbour', () => {
    const at = (stackId: string | null, after: string | null) => ({ windowId: MAIN_WINDOW, layoutId: 'main', stackId, after, y: 0 })
    const id = () => 'new'
    expect(panelDropChange(doc, 'b', at('s1', 'a'), id)).toBeNull()
    expect(panelDropChange(doc, 'c', at('s2', null), id)).toBeNull()
    expect(panelDropChange(doc, 'a', at('s2', 'c'), id)).toEqual({ kind: 'placePanel', id: 'a', at: { to: 'stack', dock: L1, stackId: 's2', after: 'c' } })
    expect(panelDropChange(doc, 'a', { ...at(null, null), layoutId: 'empty' }, id)).toMatchObject({ at: { stackId: 'new', after: null } })
  })

  describe('canvas treatment', () => {
    const rect = { origin: { x: 0, y: 0 }, size: { width: 100, height: 100 } }
    const withCanvas = buildDocument([
      add('c1', { to: 'stack', dock: L1, stackId: 's1' }, 'canvas', { canvasId: 'cv' }),
      add('t1', { to: 'canvas', canvasId: 'cv', nodeId: 'n1', stackId: 'ns1', rect }),
      add('t2', { to: 'canvas', canvasId: 'cv', nodeId: 'n2', stackId: 'ns2', rect: { ...rect, origin: { x: 200, y: 0 } } }),
      add('x', { to: 'stack', dock: L1, stackId: 's1' }),
    ])
    const canvasTree = workspacePanelTree(withCanvas).primary
    // canvas group (row + children) 0-90, x 94-122.
    const crects: Record<string, { top: number; bottom: number; left?: number }> = {
      [itemKey('c1')]: { top: 0, bottom: 90, left: 0 }, [itemKey('t1')]: { top: 30, bottom: 58 }, [itemKey('t2')]: { top: 60, bottom: 88 },
      [itemKey('x')]: { top: 94, bottom: 122 }, [layoutKey(MAIN_WINDOW, 'main')]: { top: 0, bottom: 122 },
    }
    const slots = (lifted: string, canvasOk = true) => dropSlots([canvasTree], lifted, (k) => crects[k] ?? null, canvasOk)
    const canvasSlots = (lifted: string) => slots(lifted).filter((s): s is CanvasSlot => 'canvasId' in s)

    it('a canvas offers a slot among its children, only to a cursor in their indentation', () => {
      expect(canvasSlots('x').map((s) => [s.afterChild, s.y])).toEqual([[null, 30], ['t1', 60], ['t2', 90]])
      const all = slots('x')
      // At the bottom of the group: right of the children's indent it adds a node, left of it it follows the canvas in its stack.
      expect(nearestSlot(all, 90, 100)).toMatchObject({ canvasId: 'cv' })
      expect(nearestSlot(all, 92, 5)).toMatchObject({ stackId: 's1', after: 'c1' })
    })

    it('no canvas slots for a panel that cannot live on one', () => {
      expect(slots('x', false).some((s) => 'canvasId' in s)).toBe(false)
    })

    it('a drop on a canvas adds a node at its default spot; within its own canvas it changes nothing', () => {
      const into = canvasSlots('x')[0]
      const change = panelDropChange(withCanvas, 'x', into, () => 'id')
      expect(change).toMatchObject({ kind: 'placePanel', id: 'x', at: { to: 'canvas', canvasId: 'cv', nodeId: 'id' } })
      expect(panelDropChange(withCanvas, 't1', into, () => 'id')).toBeNull()
    })

    it('a child dragged out lands in a stack: the placement leaves its node', () => {
      const change = panelDropChange(withCanvas, 't1', { windowId: MAIN_WINDOW, layoutId: 'main', stackId: 's1', after: 'x', y: 0 }, () => 'id')
      expect(change).toEqual({ kind: 'placePanel', id: 't1', at: { to: 'stack', dock: L1, stackId: 's1', after: 'x' } })
    })
  })
})
