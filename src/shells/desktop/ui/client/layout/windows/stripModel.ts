// The drop model of a window's tab strip, like Chrome's tab dragging: the
// dragged chip becomes a ghost that follows the cursor along the strip while
// the chips it passes are pushed aside. The solver is the shared axis model
// (`drag/axisModel.ts`); this maps the strip's geometry (x) onto it. A group's
// anchor chip is an ordinary pushable chip: the gap left of it is a tab before
// the group, the gap right of it the group's first member. Pure.

import type { LayoutId, PanelId, StackId } from '@workspace/document/contract'
import { buildAxisModel, HYSTERESIS, type AxisItem, type GapSpot, type AxisSource } from '../drag/axisModel'
import type { StripTarget } from '../drag/registry'

export { HYSTERESIS }
export type { GapSpot }

export interface StripChipGeom {
  panelId: PanelId
  stackId: StackId
  left: number
  right: number
}

/** A layout of the strip as drawn: a plain tab, a group, or an empty layout. */
export interface StripItemGeom {
  layoutId: LayoutId
  left: number
  right: number
  top: number
  /** The panel of a plain tab. */
  panelId?: PanelId
  /** A group's anchor chip. */
  anchor?: { left: number; right: number }
  /** A group's panel chips in tree order; empty for a tab or an empty layout. */
  chips: StripChipGeom[]
}

export type StripSource = AxisSource

export interface StripModel {
  /** The ghost chip: its width (the gap's), the cursor's offset in it, its top. */
  width: number
  grabX: number
  top: number
  /** Where the ghost's left edge is drawn for a cursor: it follows it, stopped
   *  by the strip's walls. */
  ghostLeft(cursorX: number): number
  /** The drop under the cursor and where the strip opens its gap. */
  solve(cursorX: number): { target: StripTarget; gap: GapSpot | null }
  /** The gap a target opens (the first position with that target). */
  gapOf(target: StripTarget): GapSpot | null
}

/** The walls a dragged chip stops against: the strip's left edge and, on the
 *  right, the edge its chips may not pass (the + button's). */
export interface StripBounds {
  left: number
  right?: number
}

const SEPARATOR = 1
const ROW_GAP = 4

export function buildStripModel(items: readonly StripItemGeom[], source: StripSource, cursorX: number, bounds?: StripBounds): StripModel {
  const axisItems: AxisItem[] = items.map((item) => ({
    layoutId: item.layoutId,
    start: item.left,
    end: item.right,
    ...(item.panelId ? { panelId: item.panelId } : {}),
    chips: item.chips.map((chip) => ({ panelId: chip.panelId, stackId: chip.stackId, start: chip.left, end: chip.right })),
  }))
  const axis = (end: number | undefined) => buildAxisModel(axisItems, source, cursorX, bounds && { start: bounds.left, end }, { separator: SEPARATOR, rowGap: ROW_GAP })
  let model = axis(bounds?.right)
  // Nothing of the strip leaves (a drag from elsewhere): the gap it opens past the last chip is room the right wall gives.
  if (model.removed === 0 && bounds?.right !== undefined) model = axis(bounds.right + model.size)
  return {
    width: model.size,
    grabX: model.grab,
    top: items[0]?.top ?? 0,
    ghostLeft: model.ghostStart,
    // The strip's tab bars take same-stack tabs: its targets are the strip's own.
    solve: (x) => model.solve(x) as { target: StripTarget; gap: GapSpot | null },
    gapOf: (target) => model.gapOf(target),
  }
}
