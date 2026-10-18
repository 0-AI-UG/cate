// Where a row dragged in the sidebar can land. The tree is laid out along y and
// dragged like the window's tab strip (the shared axis model): a lifted row
// becomes a ghost that follows the cursor and pushes the rows it passes aside.
// This module holds what is specific to the tree: the geometry it hands the
// model and the canvas slots (a panel dropped among a canvas's children adds a
// node). The drop itself is the shared drag system's (`dropChanges`).

import type { LayoutId, PanelId, PanelRecord, WindowId } from '@workspace/document/contract'
import type { AxisCanvas, AxisItem } from '../../client/layout/drag'
import type { LayoutTree, WindowTree } from './panelTree'

export interface RowRect { top: number; bottom: number }
/** The measured rect of the anchor a key names (`itemKey`, `layoutKey`). */
export type RectOf = (key: string) => RowRect | null

export const itemKey = (panelId: PanelId) => panelId
/** The key of the "Other windows" label: the top of the first other window, even when its layouts are gone. */
export const OTHER_WINDOWS_KEY = 'other-windows'
export const layoutKey = (windowId: WindowId, layoutId: LayoutId) => `l:${windowId}/${layoutId}`

/** Room between two layouts of the tree: none, a layout's rows carry their own margins. */
export const ROW_GAP = 0

/** How far inside a group its first and last slots sit, apart from the gaps before and after it. */
export const GROUP_EDGE = 4

/** How far inside a canvas's container its last slot sits: more than a group's edge, so the
 *  canvas ending a group keeps its own slot. */
export const CANVAS_EDGE = 8

/** The rows of a layout in dock order, each with the stack it sits in. */
export function layoutRows(layout: LayoutTree) {
  return layout.stacks.flatMap((stack) => stack.items.map((item) => ({ ...item, stackId: stack.stackId })))
}

/** The canvas a row is, with its panels as the tree lists them under it (`lifted` is not among
 *  them); none for another panel. A collapsed canvas draws no panels. */
function canvasRowOf(record: PanelRecord, children: readonly PanelRecord[], lifted: PanelId | null, rectOf: RectOf): AxisCanvas | undefined {
  if (!record.canvasId) return undefined
  const kids = children.filter((c) => c.id !== lifted).map((c) => ({ panelId: c.id, rect: rectOf(itemKey(c.id)) }))
  return { panelId: record.id, kids: kids.flatMap((k) => (k.rect ? [{ panelId: k.panelId, start: k.rect.top, end: k.rect.bottom }] : [])) }
}

/** A window's layouts as the axis model sees them, from the measured rects. A
 *  layout with no rect (an empty one: nothing is drawn) takes no room. With `canvases`, the
 *  canvases among them take drops: `lifted` is the panel being dragged (null: none leaves its place). `top` is where
 *  the window's first layout starts: a first layout with no rect (the lifted one, gone from the tree) stands there. */
export function windowItems(window: WindowTree, rectOf: RectOf, canvases?: { lifted: PanelId | null }, top = 0): AxisItem[] {
  let edge = top
  const canvasOfRow = (row: ReturnType<typeof layoutRows>[number]) => (canvases && row.record.id !== canvases.lifted ? canvasRowOf(row.record, row.children, canvases.lifted, rectOf) : undefined)
  return window.layouts.map((layout) => {
    const rows = layoutRows(layout)
    const box = rectOf(layoutKey(window.windowId, layout.layoutId))
    if (!box) return { layoutId: layout.layoutId, start: edge, end: edge, chips: [] }
    edge = box.bottom
    const chips = layout.group
      ? rows.flatMap((row) => {
        const rect = rectOf(itemKey(row.record.id))
        const canvas = canvasOfRow(row)
        return rect ? [{ panelId: row.record.id, stackId: row.stackId, start: rect.top, end: rect.bottom, ...(canvas ? { canvas } : {}) }] : []
      })
      : []
    const canvas = rows.length === 1 && !layout.group ? canvasOfRow(rows[0]) : undefined
    return { layoutId: layout.layoutId, start: box.top, end: box.bottom, ...(rows.length === 1 ? { panelId: rows[0].record.id } : {}), ...(canvas ? { canvas } : {}), chips }
  })
}

/** A canvas's listing order with `lifted` placed after `after` (first when null). */
export function canvasOrderAt(windows: readonly WindowTree[], canvasPanelId: PanelId, after: PanelId | null, lifted: PanelId): PanelId[] {
  const children = windows
    .flatMap((w) => w.layouts.flatMap(layoutRows))
    .find((item) => item.record.id === canvasPanelId)?.children.map((c) => c.id).filter((id) => id !== lifted) ?? []
  const at = after === null ? 0 : children.indexOf(after) + 1 || children.length
  return [...children.slice(0, at), lifted, ...children.slice(at)]
}
