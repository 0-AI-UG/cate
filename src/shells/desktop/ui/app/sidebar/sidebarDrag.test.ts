import { describe, expect, it } from 'vitest'
import { MAIN_WINDOW } from '@workspace/document/contract'
import { add, buildDocument } from '../../../../../test/clientWorkspace'
import { workspacePanelTree } from './panelTree'
import { headingKey, itemKey, layoutKey, layoutSlots, nearestSlot, panelDropChange, panelSlots } from './sidebarDrag'

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
})
