import { describe, expect, it } from 'vitest'
import { buildAxisModel, HYSTERESIS, type AxisItem } from './axisModel'

// The sidebar's numbers (y): a group G of rows a, b (one stack s1) and c (s2),
// then plain rows t1, t2. A row is 32 high (its 4px of margin is inside it), so
// rows and layouts touch; a group's first and last slots sit 4px inside it.
const items = (): AxisItem[] => [
  {
    layoutId: 'G', start: 0, end: 96,
    chips: [{ panelId: 'a', stackId: 's1', start: 0, end: 32 }, { panelId: 'b', stackId: 's1', start: 32, end: 64 }, { panelId: 'c', stackId: 's2', start: 64, end: 96 }],
  },
  { layoutId: 'T1', start: 96, end: 128, panelId: 't1', chips: [] },
  { layoutId: 'T2', start: 128, end: 160, panelId: 't2', chips: [] },
]
const options = { separator: 0, rowGap: 0, stackTabs: true, groupLead: 4, groupTail: 4 }
const drag = (panelId: string, cursor: number) => {
  const model = buildAxisModel(items(), { kind: 'panel', panelId }, cursor, undefined, options)
  return { model, at: (edge: number) => model.solve(edge + model.grab).target }
}

describe('axisModel (rows)', () => {
  it('rows of one stack are tabs of it: a drop between them is a tab, between two stacks a new pane', () => {
    const { at } = drag('t1', 100)
    expect(at(32)).toEqual({ kind: 'stack-slot', layoutId: 'G', stackId: 's1', after: 'a' })
    expect(at(64)).toEqual({ kind: 'group-slot', layoutId: 'G', beside: 's1', side: 'right', slot: 2 })
    expect(at(92)).toEqual({ kind: 'group-slot', layoutId: 'G', beside: 's2', side: 'right', slot: 3 })
  })

  it('a group\'s edges have two places each: the gap outside it, and its first or last row', () => {
    const { at } = drag('t1', 100)
    expect(at(0)).toEqual({ kind: 'tab-slot', index: 0 })
    expect(at(1)).toEqual({ kind: 'tab-slot', index: 0 })
    expect(at(4)).toEqual({ kind: 'group-slot', layoutId: 'G', beside: 's1', side: 'left', slot: 0 })
    expect(at(92)).toMatchObject({ kind: 'group-slot', slot: 3 })
    expect(at(96)).toEqual({ kind: 'tab-slot', index: 1 })
  })

  it('a row reorders within its own group; its own spot drops nothing', () => {
    const { at } = drag('b', 40)
    // Without b: a 0-32, c 32-64. Its own spot is after a.
    expect(at(32)).toEqual({ kind: 'group-home', layoutId: 'G', slot: 1 })
    expect(at(4)).toEqual({ kind: 'group-slot', layoutId: 'G', beside: 's1', side: 'left', slot: 0 })
    expect(at(60)).toEqual({ kind: 'group-slot', layoutId: 'G', beside: 's2', side: 'right', slot: 2 })
  })

  it('a layout dragged as a whole takes tab slots, other groups counted as one row', () => {
    const model = buildAxisModel(items(), { kind: 'layout', layoutId: 'G' }, 40, undefined, options)
    expect(model.size).toBe(96)
    expect(model.solve(0 + model.grab).target).toEqual({ kind: 'tab-slot', index: 0 })
    // Without G: t1 0-32, t2 32-64.
    expect(model.solve(64 + model.grab).target).toEqual({ kind: 'tab-slot', index: 3 })
    expect(model.removed).toBe(96)
  })

  it('names where the tree opens its gap', () => {
    const { model } = drag('t1', 100)
    expect(model.gapOf({ kind: 'tab-slot', index: 0 })).toEqual({ at: 'item', layoutId: 'G' })
    expect(model.gapOf({ kind: 'stack-slot', layoutId: 'G', stackId: 's1', after: 'a' })).toEqual({ at: 'member', layoutId: 'G', panelId: 'b' })
    expect(model.gapOf({ kind: 'group-slot', layoutId: 'G', beside: 's2', side: 'right', slot: 3 })).toEqual({ at: 'group-end', layoutId: 'G', panelId: 'c' })
    expect(model.gapOf({ kind: 'tab-slot', index: 3 })).toEqual({ at: 'row-end', layoutId: 'T2' })
  })
})
