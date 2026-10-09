// Where a row dragged in the sidebar can land, from the tree and the rows'
// rects at the moment it was lifted. Panels move between the stacks of
// layouts (a stack is a split section: the groups the sidebar spaces apart);
// layouts only reorder among the layouts of their window. Slots are indexed
// among the others, as in the window header: the lifted row is out of the
// count, and the slot's y is a boundary of the rows as they stood, so the
// ghost opening a gap cannot move the targets.

import { findFreePosition } from '@workspace/canvas/contract'
import { canLiveOnCanvas, panelDropSize } from '@client/host'
import {
  findStack,
  isCanvasDock,
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

export interface RowRect { top: number; bottom: number; left?: number }
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

/** Extra left padding of the rows under a layout heading (one icon in). */
export const LAYOUT_INSET = 16

/** A new node on a canvas, after the child row `afterChild` (cosmetic: the
 *  node goes to the canvas's default spot). Only offered to a cursor at or
 *  right of `minX`, the children's indentation: left of it the same height
 *  means the stack the canvas sits in. */
export interface CanvasSlot {
  windowId: WindowId
  layoutId: LayoutId
  canvasId: string
  canvasPanelId: PanelId
  afterChild: PanelId | null
  y: number
  minX: number
}

export type DropSlot = PanelSlot | CanvasSlot

/** The position `index` among a window's other layouts. */
export interface LayoutSlot {
  windowId: WindowId
  index: number
  y: number
}

export function panelSlots(windows: readonly WindowTree[], lifted: PanelId, rectOf: RectOf, canvasOk = true): DropSlot[] {
  const slots: DropSlot[] = []
  for (const window of windows) {
    for (const layout of window.layouts) {
      const base = { windowId: window.windowId, layoutId: layout.layoutId }
      if (layout.stacks.length === 0) {
        const heading = rectOf(headingKey(window.windowId, layout.layoutId))
        if (heading) slots.push({ ...base, stackId: null, after: null, y: heading.bottom })
        continue
      }
      const inset = window.layouts.length > 1 ? LAYOUT_INSET : 0
      // Canvas slots first: at the same height they win over the stack slot below the canvas.
      if (canvasOk) {
        for (const stack of layout.stacks) {
          for (const { record, children } of stack.items) {
            const wrapper = record.canvasId && record.id !== lifted ? rectOf(itemKey(record.id)) : null
            if (!record.canvasId || !wrapper) continue
            const minX = (wrapper.left ?? 0) + 6 + inset + 28
            const base2 = { ...base, canvasId: record.canvasId, canvasPanelId: record.id, minX }
            const kids = children.filter((c) => c.id !== lifted).map((c) => c.id)
            const rects = kids.map((id) => rectOf(itemKey(id)))
            if (kids.length === 0 || rects.some((r) => !r)) {
              slots.push({ ...base2, afterChild: null, y: wrapper.bottom })
              continue
            }
            for (let i = 0; i <= kids.length; i++) {
              slots.push({ ...base2, afterChild: i === 0 ? null : kids[i - 1], y: i < kids.length ? rects[i]!.top : wrapper.bottom })
            }
          }
        }
      }
      for (const stack of layout.stacks) {
        const others = stack.items.filter((item) => item.record.id !== lifted).map((item) => item.record.id)
        if (others.length === 0) {
          // Only the lifted row: its own spot, so it can be put back.
          const own = stack.items.some((item) => item.record.id === lifted) ? rectOf(itemKey(lifted)) : null
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

/** A canvas's listing order with `lifted` placed at `slot`. */
export function canvasOrderAt(windows: readonly WindowTree[], slot: CanvasSlot, lifted: PanelId): PanelId[] {
  const children = windows
    .flatMap((w) => w.layouts.flatMap((l) => l.stacks.flatMap((s) => s.items)))
    .find((item) => item.record.id === slot.canvasPanelId)?.children.map((c) => c.id).filter((id) => id !== lifted) ?? []
  const at = slot.afterChild === null ? 0 : children.indexOf(slot.afterChild) + 1 || children.length
  return [...children.slice(0, at), lifted, ...children.slice(at)]
}

/** The slot whose boundary is closest to `y` (the first on a tie). */
export function nearestSlot<S extends { y: number; minX?: number }>(slots: readonly S[], y: number, x = Infinity): S | null {
  let best: S | null = null
  for (const slot of slots) {
    if (slot.minX !== undefined && x < slot.minX) continue
    if (!best || Math.abs(slot.y - y) < Math.abs(best.y - y)) best = slot
  }
  return best
}

/** The op for dropping `panelId` on `slot`; null when it would not move. */
export function panelDropChange(
  doc: WorkspaceDocument,
  panelId: PanelId,
  slot: DropSlot,
  newId: () => string,
): DocChange | null {
  const placement = placementOf(doc, panelId)
  if (!placement) return null
  if ('canvasId' in slot) {
    // Within its own canvas the order of nodes is nothing the canvas keeps: no change.
    if (isCanvasDock(placement.dock) && placement.dock.canvasId === slot.canvasId) return null
    const canvas = doc.canvases[slot.canvasId]
    const type = doc.panels[panelId]?.type
    if (!canvas || !canLiveOnCanvas(type)) return null
    const size = panelDropSize(type)
    const origin = findFreePosition(canvas.nodes, null, size)
    return { kind: 'placePanel', id: panelId, at: { to: 'canvas', canvasId: slot.canvasId, nodeId: newId(), stackId: newId(), rect: { origin, size } } }
  }
  const dock = { windowId: slot.windowId, layoutId: slot.layoutId }
  if (slot.stackId !== null && placement.stackId === slot.stackId && sameDockRef(placement.dock, dock)) {
    const panels = findStack(dockOf(doc, dock), slot.stackId)?.panels ?? []
    if ((panels[panels.indexOf(panelId) - 1] ?? null) === slot.after) return null
  }
  return { kind: 'placePanel', id: panelId, at: { to: 'stack', dock, stackId: slot.stackId ?? newId(), after: slot.after } }
}
