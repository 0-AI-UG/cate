import { describe, expect, it } from 'vitest'
import { buildStripModel, HYSTERESIS, type StripItemGeom, type StripSource } from './stripModel'

// A group G (anchor 0-30, chips a 31-131 and b 132-232), then plain tabs t1 and
// t2, 100 wide each, the row's gap 4px between layouts.
const strip = (): StripItemGeom[] => [
  {
    layoutId: 'G', left: 0, right: 232, top: 8, anchor: { left: 0, right: 30 },
    chips: [{ panelId: 'a', stackId: 'sa', left: 31, right: 131 }, { panelId: 'b', stackId: 'sb', left: 132, right: 232 }],
  },
  { layoutId: 'T1', left: 236, right: 336, top: 8, panelId: 't1', chips: [] },
  { layoutId: 'T2', left: 340, right: 440, top: 8, panelId: 't2', chips: [] },
]
const panel = (panelId: string): StripSource => ({ kind: 'panel', panelId })

/** A drag of `source` grabbed at `grab` px into its chip; `at(edge)` moves the
 *  ghost's left edge to `edge` and returns the target there. */
function drag(source: StripSource, grabbed: number, sourceLeft: number) {
  const model = buildStripModel(strip(), source, sourceLeft + grabbed)
  return { model, at: (edge: number) => model.solve(edge + model.grabX).target }
}

describe('stripModel', () => {
  it('the ghost keeps its own size and grab, and starts at home', () => {
    const { model, at } = drag(panel('t2'), 50, 340)
    expect(model).toMatchObject({ width: 100, grabX: 50, top: 8 })
    expect(at(340)).toEqual({ kind: 'tab-slot', index: 2 })
  })

  it('a chip dragged from far away (a pane\'s grip) is held by its middle, not by the distance', () => {
    // t1 sits at 236-336; the cursor starts on a grip at x = 900.
    const model = buildStripModel(strip(), panel('t1'), 900)
    expect(model.grabX).toBe(50)
    expect(model.solve(900).target).toEqual({ kind: 'tab-slot', index: 3 })
    expect(model.solve(300).target).toEqual({ kind: 'tab-slot', index: 1 })
  })

  it('a chip is pushed once the ghost passes the midpoint by the threshold, not before or after wobbling back', () => {
    const { at } = drag(panel('t2'), 50, 340)
    // Positions 236 (before t1) and 340 (home): midpoint 288, threshold 8 each way.
    expect(at(285)).toEqual({ kind: 'tab-slot', index: 2 })
    expect(at(279)).toEqual({ kind: 'tab-slot', index: 1 })
    expect(at(285)).toEqual({ kind: 'tab-slot', index: 1 })
    expect(at(288 + HYSTERESIS / 2 - 1)).toEqual({ kind: 'tab-slot', index: 1 })
    expect(at(288 + HYSTERESIS / 2 + 1)).toEqual({ kind: 'tab-slot', index: 2 })
  })

  it('a fast move skips several positions at once', () => {
    const { at } = drag(panel('t2'), 50, 340)
    expect(at(-40)).toEqual({ kind: 'tab-slot', index: 0 })
    // t2 is the dragged one: the places before and after it are the same.
    expect(at(600)).toEqual({ kind: 'tab-slot', index: 2 })
  })

  it('a tab dragged left through a group joins it between the chips it passes', () => {
    const { at } = drag(panel('t1'), 20, 236)
    expect(at(131)).toEqual({ kind: 'group-slot', layoutId: 'G', beside: 'sa', side: 'right', slot: 1 })
    expect(at(232)).toEqual({ kind: 'group-slot', layoutId: 'G', beside: 'sb', side: 'right', slot: 2 })
    expect(at(30)).toEqual({ kind: 'group-slot', layoutId: 'G', beside: 'sa', side: 'left', slot: 0 })
  })

  it('the anchor chip is pushable: left of it is a tab before the group, right of it the first member', () => {
    const { at } = drag(panel('t1'), 20, 236)
    expect(at(30)).toMatchObject({ kind: 'group-slot', slot: 0 })
    expect(at(0)).toEqual({ kind: 'tab-slot', index: 0 })
    // Crossing the anchor's midpoint (15) by the threshold, either way.
    expect(at(15 + HYSTERESIS / 2 - 1)).toEqual({ kind: 'tab-slot', index: 0 })
    expect(at(15 + HYSTERESIS / 2 + 1)).toMatchObject({ kind: 'group-slot', slot: 0 })
  })

  it('the group ends at its last chip: past that edge the gap is outside it, in the row', () => {
    const { at } = drag(panel('t2'), 20, 340)
    expect(at(232)).toMatchObject({ kind: 'group-slot', slot: 2 })
    expect(at(236 + 2 + HYSTERESIS)).toEqual({ kind: 'tab-slot', index: 1 })
  })

  it('a pane reorders within its own group; its original spot drops nothing', () => {
    const { at } = drag(panel('b'), 20, 132)
    expect(at(132)).toEqual({ kind: 'group-home', layoutId: 'G', slot: 1 })
    expect(at(100)).toEqual({ kind: 'group-home', layoutId: 'G', slot: 1 })
    // Before a (the other chip of the group), as a pane beside it.
    expect(at(40)).toEqual({ kind: 'group-slot', layoutId: 'G', beside: 'sa', side: 'left', slot: 0 })
    // Out of the group, left of its anchor or right of its (shrunken) end, it becomes a tab.
    expect(at(-30)).toEqual({ kind: 'tab-slot', index: 0 })
    expect(at(300)).toEqual({ kind: 'tab-slot', index: 3 })
  })

  it('a dragged layout only takes tab slots and treats other groups as one chip', () => {
    const { at } = drag({ kind: 'layout', layoutId: 'G' }, 10, 0)
    expect(at(0)).toEqual({ kind: 'tab-slot', index: 0 })
    expect(at(104)).toEqual({ kind: 'tab-slot', index: 2 })
    expect(at(300)).toEqual({ kind: 'tab-slot', index: 3 })
    const second = drag({ kind: 'layout', layoutId: 'T1' }, 10, 236)
    expect(second.at(0)).toEqual({ kind: 'tab-slot', index: 0 })
    expect(second.at(236)).toEqual({ kind: 'tab-slot', index: 1 })
  })

  it('a drag from outside the strip has no home: it takes the nearest gap', () => {
    const model = buildStripModel(strip(), { kind: 'none' }, 140)
    expect(model.width).toBe(100)
    expect(model.solve(140).target).toMatchObject({ kind: 'group-slot', layoutId: 'G' })
    expect(model.solve(140 + 400).target).toEqual({ kind: 'tab-slot', index: 3 })
  })

  it('the ghost stops against the walls: the strip\'s left edge and the + button', () => {
    const model = buildStripModel(strip(), panel('t2'), 390, { left: 0, right: 520 })
    expect(model.ghostLeft(390)).toBe(340)
    expect(model.ghostLeft(-200)).toBe(0)
    // Right edge of the ghost (100 wide) against the 520 wall.
    expect(model.ghostLeft(2000)).toBe(420)
    expect(model.solve(2000).target).toEqual({ kind: 'tab-slot', index: 2 })
    expect(model.solve(-200).target).toEqual({ kind: 'tab-slot', index: 0 })
    // Without a right wall the ghost goes wherever the cursor does.
    expect(buildStripModel(strip(), panel('t2'), 390, { left: 0 }).ghostLeft(2000)).toBe(1950)
  })

  it('a drag that lifts nothing of the strip gets room past the right wall to reach the last slot', () => {
    // The + button at 450: the last slot (444) is past where a 100-wide ghost could start (350).
    const model = buildStripModel(strip(), { kind: 'none' }, 140, { left: 0, right: 450 })
    expect(model.ghostLeft(2000)).toBe(450)
    expect(model.solve(2000).target).toEqual({ kind: 'tab-slot', index: 3 })
  })

  it('names where the strip opens its gap', () => {
    const { model } = drag(panel('t2'), 50, 340)
    expect(model.gapOf({ kind: 'tab-slot', index: 2 })).toEqual({ at: 'row-end', layoutId: 'T1' })
    expect(model.gapOf({ kind: 'tab-slot', index: 0 })).toEqual({ at: 'item', layoutId: 'G' })
    expect(model.gapOf({ kind: 'group-slot', layoutId: 'G', beside: 'sa', side: 'left', slot: 0 })).toEqual({ at: 'member', layoutId: 'G', panelId: 'a' })
    expect(model.gapOf({ kind: 'group-slot', layoutId: 'G', beside: 'sb', side: 'right', slot: 2 })).toEqual({ at: 'group-end', layoutId: 'G', panelId: 'b' })
    const own = drag(panel('a'), 10, 31).model
    expect(own.gapOf({ kind: 'group-home', layoutId: 'G', slot: 0 })).toEqual({ at: 'member', layoutId: 'G', panelId: 'b' })
  })
})
