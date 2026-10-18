// The drop model of a row of chips or rows laid out along one axis (a window's
// tab strip along x, the sidebar's tree along y), like Chrome's tab dragging.
// The dragged item becomes a ghost that follows the cursor along the axis; the
// items it passes are pushed aside, opening a gap where a drop would land.
//
// Every place the gap can open is a *position* at a coordinate ("ax": where the
// gap's start sits when the row is laid out without the dragged item and
// without the gap). The position is the one nearest the ghost's start edge, and
// it changes only once another is nearer by `HYSTERESIS`, so a few pixels back
// never push an item straight back. The ghost stops against the walls. Pure;
// geometry comes in as plain numbers.

import type { LayoutId, PanelId, StackId } from '@workspace/document/contract'
import type { StripTarget } from './registry'

/** A canvas row and the panels listed under it (its nodes; none while collapsed). The row or
 *  chip that holds it spans them too: its end is the canvas container's bottom edge. */
export interface AxisCanvas {
  panelId: PanelId
  kids: { panelId: PanelId; start: number; end: number }[]
}

/** A panel's chip or row inside a group. */
export interface AxisChip {
  panelId: PanelId
  stackId: StackId
  start: number
  end: number
  canvas?: AxisCanvas
}

/** A layout as drawn: a plain tab, a group, or an empty layout. */
export interface AxisItem {
  layoutId: LayoutId
  start: number
  end: number
  /** The panel of a plain tab. */
  panelId?: PanelId
  /** The canvas a plain tab is. */
  canvas?: AxisCanvas
  /** A group's panels in tree order; empty for a tab or an empty layout. */
  chips: AxisChip[]
}

export type AxisSource =
  | { kind: 'panel'; panelId: PanelId }
  | { kind: 'layout'; layoutId: LayoutId }
  /** A drag from outside the row (a canvas node, a pane of another window). */
  | { kind: 'none' }

export type AxisTarget =
  | StripTarget
  /** Between two panels of one stack (they are tabs of it): after `after`. */
  | { kind: 'stack-slot'; layoutId: LayoutId; stackId: StackId; after: PanelId }
  /** Among the panels of a canvas (a new node): after `after`, first when null. */
  | { kind: 'canvas-slot'; canvasPanelId: PanelId; after: PanelId | null }

/** Where the row makes room: the element that gets the margin. */
export type GapSpot =
  /** Before a layout's tab or group. */
  | { at: 'item'; layoutId: LayoutId }
  /** Before a group member. */
  | { at: 'member'; layoutId: LayoutId; panelId: PanelId }
  /** After the last member of a group. */
  | { at: 'group-end'; layoutId: LayoutId; panelId: PanelId }
  /** After the last layout. */
  | { at: 'row-end'; layoutId: LayoutId }
  /** Before a panel of a canvas. */
  | { at: 'canvas-child'; canvasPanelId: PanelId; panelId: PanelId }
  /** After the last panel of a canvas, inside its container. */
  | { at: 'canvas-end'; canvasPanelId: PanelId }

export interface AxisModel {
  /** The ghost's size along the axis (the gap's) and the cursor's offset in it. */
  size: number
  grab: number
  /** Where the ghost's start edge is drawn for a cursor: it follows it, stopped
   *  by the walls. */
  ghostStart(cursor: number): number
  /** The drop under the cursor and where the row opens its gap. `jump` skips
   *  the threshold (a drag entering this row from another). */
  solve(cursor: number, jump?: boolean): { target: AxisTarget; gap: GapSpot | null }
  /** The gap a target opens (the first position with that target). */
  gapOf(target: AxisTarget): GapSpot | null
  /** How far later items move toward the start once the dragged item is out. */
  removed: number
}

/** Pixels the ghost's edge must pass the midpoint between two positions before
 *  the gap moves; a push is not undone by the cursor wobbling back. */
export const HYSTERESIS = 16
const DEFAULT_SIZE = 100

/** The walls a dragged item stops against. */
export interface AxisBounds {
  start: number
  end?: number
}

export interface AxisOptions {
  /** The size of a dragged item the row has no entry for (one dragged in from
   *  outside); a default when unset. */
  sourceSize?: number
  /** Room between two items of a group (a separator), and between layouts. */
  separator: number
  rowGap: number
  /** Two neighbours in one stack are tabs of it: a drop between them is a tab,
   *  not a new pane. */
  stackTabs?: boolean
  /** Room between a group's start and its first member's slot, so the gap before
   *  the group and the gap before its first member are two places (a strip has
   *  the anchor chip there). */
  groupLead?: number
  /** The same at the end: the slot after the last member sits this far inside
   *  the group, apart from the gap after the group (items that touch). */
  groupTail?: number
  /** The same for a canvas's container: its last slot sits this far inside its bottom edge
   *  (more than `groupTail`: the canvas may be the last member of a group). */
  canvasTail?: number
}

interface Position {
  ax: number
  target: AxisTarget
  gap: GapSpot | null
}

const shiftCanvas = (canvas: AxisCanvas | undefined, by: number): { canvas?: AxisCanvas } =>
  canvas ? { canvas: { ...canvas, kids: canvas.kids.map((kid) => ({ ...kid, start: kid.start - by, end: kid.end - by })) } } : {}

const sameTarget = (a: AxisTarget, b: AxisTarget): boolean => JSON.stringify(a) === JSON.stringify(b)

export function buildAxisModel(
  items: readonly AxisItem[],
  source: AxisSource,
  cursor: number,
  bounds?: AxisBounds,
  options: AxisOptions = { separator: 0, rowGap: 0 },
): AxisModel {
  const { separator, rowGap, sourceSize, stackTabs = false, groupLead = 0, groupTail = 0, canvasTail = 0 } = options
  // --- The dragged item ----------------------------------------------------------------
  let srcItem = -1
  let srcChip = -1
  items.forEach((item, i) => {
    if (source.kind === 'layout' && item.layoutId === source.layoutId) srcItem = i
    if (source.kind !== 'panel') return
    if (item.chips.length === 0 && item.panelId === source.panelId) srcItem = i
    const j = item.chips.findIndex((chip) => chip.panelId === source.panelId)
    if (j >= 0) { srcItem = i; srcChip = j }
  })
  const dragged = srcChip >= 0 ? items[srcItem].chips[srcChip] : srcItem >= 0 ? items[srcItem] : null
  const size = dragged ? dragged.end - dragged.start : sourceSize ?? DEFAULT_SIZE
  // Grabbed on the item itself, the ghost keeps the grab; dragged from elsewhere
  // (a pane's grip, far from the chip) it is held by its middle.
  const onItem = !!dragged && cursor >= dragged.start && cursor <= dragged.end
  const grab = dragged && onItem ? cursor - dragged.start : size / 2

  // --- The row without it ---------------------------------------------------------------
  // Natural coordinates: later items move toward the start over the room it took.
  let shift = 0
  const nat: (AxisItem | null)[] = items.map((item, i) => {
    if (i === srcItem && srcChip < 0) {
      shift += item.end - item.start + (items[i + 1] ? items[i + 1].start - item.end : rowGap)
      return null
    }
    const removed = i === srcItem ? items[i].chips[srcChip].end - items[i].chips[srcChip].start + separator : 0
    const chips = item.chips.flatMap((chip, j) => {
      if (i === srcItem && j === srcChip) return []
      const by = shift + (i === srcItem && j > srcChip ? removed : 0)
      return [{ ...chip, start: chip.start - by, end: chip.end - by, ...shiftCanvas(chip.canvas, by) }]
    })
    const out: AxisItem = { ...item, start: item.start - shift, end: item.end - shift - removed, chips, ...shiftCanvas(item.canvas, shift) }
    shift += removed
    return out
  })
  const present = nat.filter((item): item is AxisItem => item !== null)
  const lastPresent = present[present.length - 1]
  const nextPresent = (i: number): AxisItem | undefined => nat.slice(i).find((item) => item !== null) ?? undefined

  // --- Positions, in order ----------------------------------------------------------------
  const positions: Position[] = []
  const tabAt = (i: number): Position => {
    const next = nextPresent(i)
    return {
      ax: next ? next.start : lastPresent ? lastPresent.end + rowGap : items[srcItem]?.start ?? items[items.length - 1]?.end ?? 0,
      target: { kind: 'tab-slot', index: i },
      gap: next ? { at: 'item', layoutId: next.layoutId } : lastPresent ? { at: 'row-end', layoutId: lastPresent.layoutId } : null,
    }
  }
  /** The slots among a canvas's panels, and the one at the foot of its container. */
  const canvasPositions = (canvas: AxisCanvas | undefined, end: number) => {
    if (!canvas) return
    const { panelId, kids } = canvas
    for (let k = 0; k <= kids.length; k++) {
      positions.push({
        ax: k < kids.length ? kids[k].start : end - canvasTail,
        target: { kind: 'canvas-slot', canvasPanelId: panelId, after: k === 0 ? null : kids[k - 1].panelId },
        gap: k < kids.length ? { at: 'canvas-child', canvasPanelId: panelId, panelId: kids[k].panelId } : { at: 'canvas-end', canvasPanelId: panelId },
      })
    }
  }
  let homeIndex = -1
  for (let i = 0; i <= items.length; i++) {
    // Either side of a removed layout is the same place.
    if (!(i > 0 && nat[i - 1] === null)) {
      if (i === srcItem && srcChip < 0) homeIndex = positions.length
      positions.push(tabAt(i))
    }
    const item = nat[i]
    if (item && source.kind !== 'layout') canvasPositions(item.canvas, item.end)
    if (!item || items[i].chips.length === 0 || source.kind === 'layout') continue
    const chips = item.chips
    const own = i === srcItem
    for (let s = 0; s <= chips.length; s++) {
      const ax = s < chips.length ? chips[s].start - separator + (s === 0 ? groupLead : 0) : chips[chips.length - 1].end - groupTail
      const memberGap = (slot: number): GapSpot => (slot < chips.length
        ? { at: 'member', layoutId: item.layoutId, panelId: chips[slot].panelId }
        : { at: 'group-end', layoutId: item.layoutId, panelId: chips[chips.length - 1].panelId })
      if (own && s === srcChip) {
        // Where the pane already is: releasing there leaves the layout untouched.
        homeIndex = positions.length
        positions.push({ ax, target: { kind: 'group-home', layoutId: item.layoutId, slot: srcChip }, gap: memberGap(s) })
      } else if (stackTabs && s > 0 && s < chips.length && chips[s - 1].stackId === chips[s].stackId) {
        positions.push({ ax, target: { kind: 'stack-slot', layoutId: item.layoutId, stackId: chips[s].stackId, after: chips[s - 1].panelId }, gap: memberGap(s) })
      } else {
        positions.push({
          ax,
          target: { kind: 'group-slot', layoutId: item.layoutId, beside: chips[Math.max(s - 1, 0)].stackId, side: s === 0 ? 'left' : 'right', slot: s },
          gap: memberGap(s),
        })
      }
      if (s < chips.length) canvasPositions(chips[s].canvas, chips[s].end)
    }
  }

  // --- Choosing --------------------------------------------------------------------------
  const ghostStart = (x: number): number => {
    const start = x - grab
    return Math.max(bounds?.start ?? -Infinity, bounds?.end === undefined ? start : Math.min(start, bounds.end - size))
  }
  const nearest = (edge: number): number => positions.reduce((best, p, k) => (Math.abs(edge - p.ax) < Math.abs(edge - positions[best].ax) ? k : best), 0)
  let current = homeIndex >= 0 ? homeIndex : nearest(ghostStart(cursor))

  return {
    size,
    grab,
    ghostStart,
    removed: shift,
    solve(x, jump = false) {
      const edge = ghostStart(x)
      const best = nearest(edge)
      if (jump) current = best
      else if (best !== current) {
        // Positions closer together than the threshold (a group's last chip and
        // the tab after it) still switch, with less to spare.
        const margin = Math.min(HYSTERESIS, Math.abs(positions[best].ax - positions[current].ax) / 2)
        if (Math.abs(edge - positions[best].ax) + margin < Math.abs(edge - positions[current].ax)) current = best
      }
      return { target: positions[current].target, gap: positions[current].gap }
    },
    gapOf(target) {
      return positions.find((p) => sameTarget(p.target, target))?.gap ?? null
    },
  }
}
