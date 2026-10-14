// The workspace tree as a drop zone of the shared drag system: a drag that
// starts anywhere (a strip chip, a pane's grip, a row of the tree) resolves to
// tree targets. Like the window's tab strip, the tree keeps the state of a drag
// over it (the axis model of each window, built once per drag) and picks the
// drop itself from the cursor's y.

import { useEffect, useRef, type MutableRefObject } from 'react'
import { documentStoreFor } from '@client/document'
import { canLiveOnCanvas } from '@client/host'
import type { PanelId, WindowId } from '@workspace/document/contract'
import {
  buildAxisModel,
  registerDropZone,
  useDragStore,
  type AxisCanvas,
  type AxisItem,
  type AxisModel,
  type AxisSource,
  type AxisTarget,
  type DragSource,
  type DragState,
  type DropTarget,
  type GapSpot,
  type TreeTarget,
} from '../../client/layout/drag'
import { type WindowTree } from './panelTree'
import { CANVAS_EDGE, GROUP_EDGE, ROW_GAP, canvasOrderAt, itemKey, layoutRows, windowItems, type RectOf } from './sidebarDrag'

export interface Float { left: number; top: number; width: number; height: number }

/** A drag over the tree, for the rows' render: what it drops on, where the rows open their
 *  gap and how much room it makes, and where the lifted row floats. */
export interface TreeView {
  target: DropTarget
  gap: GapSpot | null
  size: number
  float: Float
}

const OPTIONS = { separator: 0, rowGap: ROW_GAP, stackTabs: true, groupLead: GROUP_EDGE, groupTail: GROUP_EDGE, canvasTail: CANVAS_EDGE }

/** A panel row's room: 28px and its 2px margins. A drag from outside the tree opens this much. */
const ROW_SIZE = 32

interface Scope {
  windowId: WindowId
  model: AxisModel
  /** The windows's layouts span `start` to `end` without the lifted row. */
  start: number
  end: number
}

/** The tree's state for one drag. */
interface Lifted {
  source: DragSource
  scopes: Scope[]
  /** The scope of the last solve; -1 before the first. */
  active: number
  /** The walls the ghost stops against, and its size and grab. */
  wall: { start: number; end: number }
  size: number
  grab: number
  /** The lifted row's horizontal extent (the tree's for a drag from outside). */
  left: number
  width: number
  /** The last solve's gap, and the ghost's top edge then. */
  gap: GapSpot | null
  ghostTop: number
}

/** The margin above a workspace's header (`my-0.5` in `WorkspaceRow`): the room between two workspaces' trees. */
const WORKSPACE_MARGIN = 2

export function useSidebarTree(workspaceId: string, windows: readonly WindowTree[]): { containerRef: MutableRefObject<HTMLDivElement | null>; view: TreeView | null } {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const windowsRef = useRef(windows)
  windowsRef.current = windows
  const liftedRef = useRef<Lifted | null>(null)

  /** The per-window models for `source`, from the rows as they stand now. */
  const lift = (container: HTMLElement, source: DragSource, cursorY: number): Lifted => {
    const rects = new Map<string, DOMRect>()
    for (const el of container.querySelectorAll<HTMLElement>('[data-sb-key]')) rects.set(el.dataset.sbKey!, el.getBoundingClientRect())
    const rectOf: RectOf = (key) => rects.get(key) ?? null
    const all = windowsRef.current
    const origin = source.origin
    const layout = origin.kind === 'layout' ? origin.layoutId : null
    const panel = layout === null ? source.panelId : null
    const inLayouts = (w: WindowTree, id: PanelId) => w.layouts.some((l) => layoutRows(l).some((r) => r.record.id === id))
    // The row (or layout) of the dragged panel is lifted, wherever the drag began: it floats as the ghost.
    const pressed = source.from === 'sidebar'
    const own = pressed || (layout !== null ? all.some((w) => w.layouts.some((l) => l.layoutId === layout)) : all.some((w) => inLayouts(w, source.panelId)) || rectOf(itemKey(source.panelId)) !== null)
    const box = own
      ? (layout !== null ? container.querySelector(`[data-layout-group="${layout}"]`) : container.querySelector(`[data-panel-id="${source.panelId}"]`))?.getBoundingClientRect()
      : undefined
    // A row of the tree is held where it was pressed (the store's grab is measured on it), not where the first move is.
    const grabY = useDragStore.getState().grab?.y
    const pressY = pressed && box && grabY !== undefined ? box.top + grabY : cursorY
    // A lifted canvas child is no chip of the model: the rows below it move up over its room itself.
    const childRect = own && panel !== null && !all.some((w) => inLayouts(w, panel)) ? rectOf(itemKey(panel)) : null
    const childGone = childRect ? { at: childRect.bottom, by: childRect.bottom - childRect.top } : null
    const type = documentStoreFor(workspaceId)?.getSnapshot().panels[source.panelId]?.type
    const canvases = takesCanvasDrop(source, type) ? { lifted: own ? panel : null } : undefined
    // A layout drag takes tab slots only; where its layout stands (or in another window) nothing is lifted ('' is no layout).
    const standing: AxisSource = layout !== null ? { kind: 'layout', layoutId: '' } : { kind: 'none' }
    let removed = 0
    let size = childRect ? childRect.bottom - childRect.top : ROW_SIZE
    let grab = childRect ? pressY - childRect.top : size / 2
    const wall = { start: 0, end: 0 }
    const scopes = all.map((w, k): Scope => {
      const has = own && (layout !== null
        ? origin.kind === 'layout' && 'windowId' in origin.host && origin.host.windowId === w.windowId && w.layouts.some((l) => l.layoutId === layout)
        : inLayouts(w, source.panelId))
      const rows = windowItems(w, rectOf, canvases)
      // The walls are the first and last rows as the tree stands, the lifted row included.
      if (k === 0) wall.start = rows[0]?.start ?? 0
      wall.end = rows[rows.length - 1]?.end ?? wall.end
      const items = rows.map((item) => moveItem(shiftPast(item, childGone), (v) => v - removed))
      const model = buildAxisModel(items, has ? (layout !== null ? { kind: 'layout', layoutId: layout } : { kind: 'panel', panelId: source.panelId }) : standing, pressY, undefined, OPTIONS)
      if (has) { removed += model.removed; size = model.size; grab = model.grab }
      return { windowId: w.windowId, model, start: items[0]?.start ?? 0, end: (items[items.length - 1]?.end ?? 0) - (has ? model.removed : 0) }
    })
    // The walls give half a row more room, less the margin before the next workspace: the ghost may go a little
    // past the last row to reach its end slot, never over the workspace below.
    wall.end += size / 2 - WORKSPACE_MARGIN
    const bounds = box ?? container.getBoundingClientRect()
    return { source, scopes, active: -1, wall, size, grab, left: bounds.left, width: bounds.width, gap: null, ghostTop: 0 }
  }

  const resolveRef = useRef<(cursorY: number, source: DragSource) => TreeTarget | null>(() => null)
  resolveRef.current = (cursorY, source) => {
    const container = containerRef.current
    if (!container || !takesDrag(source)) return null
    if (liftedRef.current?.source !== source) liftedRef.current = lift(container, source, cursorY)
    const lifted = liftedRef.current
    const { scopes, wall, size, grab } = lifted
    if (scopes.length === 0) return null
    // The ghost follows the cursor along y and stops at the first and last rows.
    const ghostTop = Math.max(wall.start, Math.min(cursorY - grab, wall.end - size))
    lifted.ghostTop = ghostTop
    // The window whose layouts the cursor is over (or nearest to).
    const distance = (s: Scope) => (cursorY < s.start ? s.start - cursorY : cursorY > s.end ? cursorY - s.end : 0)
    const k = scopes.reduce((best, s, i) => (distance(s) < distance(scopes[best]) ? i : best), 0)
    const jump = k !== lifted.active
    lifted.active = k
    const solved = scopes[k].model.solve(ghostTop + scopes[k].model.grab, jump)
    lifted.gap = solved.gap
    return treeTarget(solved.target, scopes[k].windowId, source, windowsRef.current)
  }

  const windowId = windows[0]?.windowId
  useEffect(() => {
    if (!windowId) return
    return registerDropZone({
      id: `tree-${workspaceId}`,
      workspaceId,
      dock: { layoutId: '' },
      host: { windowId },
      // The whole sidebar takes the drag: past the tree's last row the ghost holds at the wall, and only the
      // main view (off the sidebar) lets it go.
      getRect: () => (containerRef.current?.closest('[data-app-sidebar]') ?? containerRef.current)?.getBoundingClientRect() ?? null,
      getElement: () => containerRef.current,
      tree: { resolve: (cursorY, source) => resolveRef.current(cursorY, source) },
    })
  }, [workspaceId, windowId])

  // Only a drag this tree resolves reaches it: any other drag (a canvas node, a split's stack)
  // selects null, and the rows do not re-render as its cursor moves.
  const mine = (s: DragState): DropTarget | null =>
    (s.isDragging && s.target && 'workspaceId' in s.target && s.target.workspaceId === workspaceId && isTreeTarget(s.target)
      && liftedRef.current?.source === s.source ? s.target : null)
  const target = useDragStore(mine)
  // The cursor, to follow it with the float.
  useDragStore((s) => (mine(s) ? s.cursor?.client.y ?? null : null))
  const lifted = liftedRef.current
  const view: TreeView | null = target && lifted
    ? {
      target,
      gap: lifted.gap,
      size: lifted.size,
      // A layout, collapsed to one block the size of its group, keeps clear of the group's margins.
      float: (() => {
        const margin = lifted.source.origin.kind === 'layout' ? 6 : 0
        return { left: lifted.left + margin, top: lifted.ghostTop + 2, width: lifted.width - margin * 2, height: lifted.size - 4 }
      })(),
    }
    : null
  return { containerRef, view }
}

/** The tree takes tab and layout drags only: a canvas node's or another window's drag passes it by. */
function takesDrag(source: DragSource): boolean {
  return source.origin.kind === 'dock-tab' || source.origin.kind === 'layout'
}

/** A dragged tab that can live on a canvas: every canvas of the tree shows its container and takes
 *  it among its panels. The tree's slots and the rows' containers both ask this. */
export function takesCanvasDrop(source: DragSource, type: string | undefined): boolean {
  return source.origin.kind === 'dock-tab' && type !== 'canvas' && canLiveOnCanvas(type)
}

/** A target only the tree resolves. */
function isTreeTarget(target: DropTarget): boolean {
  return target.kind === 'stack-slot' || target.kind === 'canvas-slot' || ('via' in target && target.via === 'tree')
}

/** The model's target as a drop of the tree. */
function treeTarget(target: AxisTarget, windowId: WindowId, source: DragSource, windows: readonly WindowTree[]): TreeTarget {
  switch (target.kind) {
    case 'tab-slot': return { kind: 'tab-slot', host: { windowId }, index: target.index, via: 'tree' }
    case 'group-slot': return { ...target, via: 'tree' }
    case 'group-home': return { ...target, via: 'tree' }
    case 'stack-slot': return target
    case 'canvas-slot': return { ...target, order: canvasOrderAt(windows, target.canvasPanelId, target.after, source.panelId) }
  }
}

/** An item with every coordinate moved by `move`. */
function moveItem(item: AxisItem, move: (v: number) => number): AxisItem {
  const canvas = (c: AxisCanvas | undefined) => (c ? { canvas: { ...c, kids: c.kids.map((kid) => ({ ...kid, start: move(kid.start), end: move(kid.end) })) } } : {})
  return { ...item, ...canvas(item.canvas), start: move(item.start), end: move(item.end), chips: item.chips.map((chip) => ({ ...chip, ...canvas(chip.canvas), start: move(chip.start), end: move(chip.end) })) }
}

/** An item with every coordinate at or past `gone.at` moved up by `gone.by`. */
function shiftPast(item: AxisItem, gone: { at: number; by: number } | null): AxisItem {
  return gone ? moveItem(item, (v) => (v >= gone.at ? v - gone.by : v)) : item
}
