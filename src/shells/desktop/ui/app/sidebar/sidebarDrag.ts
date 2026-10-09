// Where a row dragged in the sidebar can land, from the tree and the rows'
// rects at the moment it was lifted. Panels move between the stacks of
// layouts (a stack is a split section: the groups the sidebar spaces apart);
// layouts only reorder among the layouts of their window. Slots are indexed
// among the others, as in the window header: the lifted row is out of the
// count, and the slot's y is a boundary of the rows as they stood, so the
// ghost opening a gap cannot move the targets.

import {
  findStack,
  dockOf,
  placementOf,
  sameDockRef,
  type LayoutId,
  type PanelId,
  type StackId,
  type WindowId,
  type WorkspaceDocument,
} from '@workspace/document/contract'
import type { DocChange } from '@workspace/document/contract'
import type { WindowTree } from './panelTree'

export interface RowRect { top: number; bottom: number }
/** The measured rect of the anchor a key names (`itemKey`, `headingKey`, `layoutKey`). */
export type RectOf = (key: string) => RowRect | null

export const itemKey = (panelId: PanelId) => panelId
export const headingKey = (windowId: WindowId, layoutId: LayoutId) => `h:${windowId}/${layoutId}`
export const layoutKey = (windowId: WindowId, layoutId: LayoutId) => `l:${windowId}/${layoutId}`

/** A tab position: after panel `after` (first when null) of stack `stackId`
 *  (a new stack when null: the layout is empty). */
export interface PanelSlot {
  windowId: WindowId
  layoutId: LayoutId
  stackId: StackId | null
  after: PanelId | null
  y: number
}

/** The position `index` among a window's other layouts. */
export interface LayoutSlot {
  windowId: WindowId
  index: number
  y: number
}

export function panelSlots(windows: readonly WindowTree[], lifted: PanelId, rectOf: RectOf): PanelSlot[] {
  const slots: PanelSlot[] = []
  for (const window of windows) {
    for (const layout of window.layouts) {
      const base = { windowId: window.windowId, layoutId: layout.layoutId }
      if (layout.stacks.length === 0) {
        const heading = rectOf(headingKey(window.windowId, layout.layoutId))
        if (heading) slots.push({ ...base, stackId: null, after: null, y: heading.bottom })
        continue
      }
      for (const stack of layout.stacks) {
        const others = stack.items.filter((item) => item.record.id !== lifted).map((item) => item.record.id)
        if (others.length === 0) {
          // Only the lifted row: its own spot, so it can be put back.
          const own = rectOf(itemKey(lifted))
          if (own) slots.push({ ...base, stackId: stack.stackId, after: null, y: own.top })
          continue
        }
        for (let i = 0; i <= others.length; i++) {
          const y = i < others.length ? rectOf(itemKey(others[i]))?.top : rectOf(itemKey(others[i - 1]))?.bottom
          if (y !== undefined) slots.push({ ...base, stackId: stack.stackId, after: i === 0 ? null : others[i - 1], y })
        }
      }
    }
  }
  return slots
}

export function layoutSlots(window: WindowTree, lifted: LayoutId, rectOf: RectOf): LayoutSlot[] {
  const others = window.layouts.filter((l) => l.layoutId !== lifted).map((l) => l.layoutId)
  const slots: LayoutSlot[] = []
  for (let i = 0; i <= others.length; i++) {
    const y = i < others.length
      ? rectOf(layoutKey(window.windowId, others[i]))?.top
      : rectOf(layoutKey(window.windowId, others[i - 1]))?.bottom
    if (y !== undefined) slots.push({ windowId: window.windowId, index: i, y })
  }
  return slots
}

/** The slot whose boundary is closest to `y` (the first on a tie). */
export function nearestSlot<S extends { y: number }>(slots: readonly S[], y: number): S | null {
  let best: S | null = null
  for (const slot of slots) if (!best || Math.abs(slot.y - y) < Math.abs(best.y - y)) best = slot
  return best
}

/** The op for dropping `panelId` on `slot`; null when it would not move. */
export function panelDropChange(
  doc: WorkspaceDocument,
  panelId: PanelId,
  slot: PanelSlot,
  newId: () => string,
): DocChange | null {
  const placement = placementOf(doc, panelId)
  if (!placement) return null
  const dock = { windowId: slot.windowId, layoutId: slot.layoutId }
  if (slot.stackId !== null && placement.stackId === slot.stackId && sameDockRef(placement.dock, dock)) {
    const panels = findStack(dockOf(doc, dock), slot.stackId)?.panels ?? []
    if ((panels[panels.indexOf(panelId) - 1] ?? null) === slot.after) return null
  }
  return { kind: 'placePanel', id: panelId, at: { to: 'stack', dock, stackId: slot.stackId ?? newId(), after: slot.after } }
}
