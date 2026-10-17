// Hit testing: cursor and source to a typed DropTarget. The DOM and registry
// lookups come in through a DropEnvironment so tests can pass a fake.

import { snapToGrid, CANVAS_GRID_SIZE, type Point, type Size } from '@workspace/canvas/contract'
import { isNodeHost, type HostRef, type LayoutId } from '@workspace/document/contract'
import { canLiveOnCanvas, panelDropSize } from '@client/host'
import { canvasSurfaceAt, getDropZoneEntries, resolveDropEdge, type DropZoneEntry } from './registry'
import { cursorToCanvasOrigin, snappedGhostScreenRect } from './geometry'
import type { DragSource, DropTarget } from './types'

export interface CanvasHit {
  workspaceId: string
  canvasId: string
  rect: { left: number; top: number }
  viewport: { offset: Point; zoom: number }
}

export interface DropEnvironment {
  /** The canvas under the cursor, if any. */
  canvasAtCursor(client: Point): CanvasHit | null
  readonly dropZones: readonly DropZoneEntry[]
  /** A drop outside the window may detach into a new window. */
  canDetach(): boolean
  /** Whether the layout holds a canvas panel (it never goes onto a canvas). */
  layoutHoldsCanvas?(workspaceId: string, host: HostRef, layoutId: LayoutId): boolean
  /** Whether the canvas node holds a group (its layout has 2+ panels): it drags as a layout does. */
  nodeIsGroup?(workspaceId: string, canvasId: string, nodeId: string): boolean
}

interface ResolveOptions {
  env: DropEnvironment
  snap?: boolean
}

function defaultCanvasAtCursor(client: Point): CanvasHit | null {
  const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(client.x, client.y) : null
  const surface = canvasSurfaceAt(hit)
  const element = surface?.getElement()
  if (!surface || !element) return null
  return {
    workspaceId: surface.workspaceId,
    canvasId: surface.canvasId,
    rect: element.getBoundingClientRect(),
    viewport: surface.getViewport(),
  }
}

/** The cursor and source to a target; null where a drop does nothing. With
 *  `snap`, canvas origins land on the grid and the ghost previews the cell. */
export function resolveDrop(
  cursor: { client: Point; screen: Point; insideWindow: boolean },
  source: DragSource,
  grab: Point,
  ghostSize: Size,
  panelType: string,
  { env, snap = false }: ResolveOptions,
): DropTarget | null {
  // A group moves only on its own canvas: no dock, no detach, no other canvas
  // (a canvas-add would move only the anchor and strand the others).
  const grouped = source.origin.kind === 'canvas-node' && !!source.origin.members?.length
  if (grouped) {
    if (!cursor.insideWindow) return null
    const target = resolveCanvasHit(cursor, source, grab, ghostSize, panelType, env, snap)
    return target?.kind === 'canvas-reposition' ? target : null
  }
  // A group node moves like a layout along a tab strip or the tree, or on its
  // own canvas; never into a dock, another window or another canvas.
  if (isGroupNode(source, env)) {
    if (!cursor.insideWindow) return null
    const dock = resolveDockHit(cursor.client, source, panelType, env)
    if (dock) return dock
    const onCanvas = resolveCanvasHit(cursor, source, grab, ghostSize, panelType, env, snap)
    return onCanvas?.kind === 'canvas-reposition' ? onCanvas : null
  }
  // A layout moves along a tab strip or onto a canvas, never into a dock or
  // another window.
  if (source.origin.kind === 'layout') {
    if (!cursor.insideWindow) return null
    return resolveDockHit(cursor.client, source, panelType, env)
      ?? resolveCanvasHit(cursor, source, grab, ghostSize, panelType, env, snap)
  }
  if (!cursor.insideWindow) return env.canDetach() ? { kind: 'detach', screen: cursor.screen } : null
  return resolveDockHit(cursor.client, source, panelType, env)
    ?? resolveCanvasHit(cursor, source, grab, ghostSize, panelType, env, snap)
}

function isGroupNode(source: DragSource, env: DropEnvironment): boolean {
  return source.origin.kind === 'canvas-node' && !!env.nodeIsGroup?.(source.workspaceId, source.origin.canvasId, source.origin.nodeId)
}

function resolveDockHit(client: Point, source: DragSource, panelType: string, env: DropEnvironment): DropTarget | null {
  type Hit = { entry: DropZoneEntry; rect: DOMRect; area: number }
  const hits: Hit[] = []
  const ownNode = source.origin.kind === 'canvas-node' ? source.origin.nodeId : null
  const onCanvas = canLiveOnCanvas(panelType)
  const layoutLike = source.origin.kind === 'layout' || isGroupNode(source, env)
  for (const entry of env.dropZones) {
    if (entry.workspaceId !== source.workspaceId) continue
    if (entry.acceptsPanel && !entry.acceptsPanel(panelType)) continue
    if (layoutLike && !entry.strip && !entry.tree) continue
    if (isNodeHost(entry.host)) {
      // A canvas panel never goes onto a canvas; a dragged node never drops
      // into its own mini dock (the drop would remove the node under it).
      if (!onCanvas || entry.host.nodeId === ownNode) continue
    }
    const rect = entry.getRect()
    if (!rect) continue
    if (client.x >= rect.left && client.x <= rect.right && client.y >= rect.top && client.y <= rect.bottom) {
      hits.push({ entry, rect, area: rect.width * rect.height })
    }
  }
  if (hits.length === 0) return null

  // Stacks and tab strips before whole docks and edges (a window's left edge
  // zone reaches under its strip); the tightest fit first.
  hits.sort((a, b) => {
    const specA = a.entry.stackId || a.entry.strip || a.entry.tree ? 0 : 1
    const specB = b.entry.stackId || b.entry.strip || b.entry.tree ? 0 : 1
    if (specA !== specB) return specA - specB
    return a.area - b.area
  })
  const { entry, rect } = hits[0]
  const workspaceId = entry.workspaceId
  if (entry.strip) {
    const target = entry.strip.resolve(client.x, source)
    if (!target) return null
    return target.kind === 'tab-slot' ? { ...target, workspaceId, host: entry.host } : { ...target, workspaceId }
  }

  if (entry.tree) {
    const target = entry.tree.resolve(client.y, source)
    return target && { ...target, workspaceId }
  }

  if (entry.stackId) {
    const tabBar = entry.hasTabBar?.() ?? true
    const edge = resolveDropEdge(client.x, client.y, rect, tabBar, !entry.showsCanvas?.())
    if (edge === null) return null
    const selfStack = source.origin.kind === 'dock-tab' && source.origin.stackId === entry.stackId
    // A lone tab cannot split against its own stack (the other half would be
    // empty). Dropping it back on its own tab bar still previews and commits
    // as a no-op; a pane without a tab bar has nothing to preview.
    if (selfStack && (entry.tabCount?.() ?? 1) <= 1 && (edge !== 'center' || !tabBar)) return null
    if (edge === 'center') return { kind: 'dock-tab', workspaceId, dock: entry.dock, stackId: entry.stackId }
    return { kind: 'dock-split', workspaceId, dock: entry.dock, stackId: entry.stackId, edge }
  }
  return { kind: 'dock-zone', workspaceId, dock: entry.dock, edge: entry.edge }
}

function resolveCanvasHit(
  cursor: { client: Point },
  source: DragSource,
  grab: Point,
  ghostSize: Size,
  panelType: string,
  env: DropEnvironment,
  snap: boolean,
): DropTarget | null {
  const hit = env.canvasAtCursor(cursor.client)
  if (!hit || hit.workspaceId !== source.workspaceId) return null
  const { offset, zoom } = hit.viewport
  const raw = cursorToCanvasOrigin(cursor, hit.rect, zoom, offset, grab)
  const origin = snap ? snapToGrid(raw, CANVAS_GRID_SIZE) : raw
  // A layout lands as a node of the usual footprint, whichever strip or tree
  // row it was dragged by (its ghost size there is the chip's).
  const landing = source.origin.kind === 'layout' ? { ...panelDropSize(panelType) } : ghostSize
  const ghostRect = snap ? snappedGhostScreenRect(origin, hit.rect, zoom, offset, landing) : undefined
  const { workspaceId, canvasId } = hit

  // A node already on this canvas moves.
  if (source.origin.kind === 'canvas-node' && source.origin.canvasId === canvasId) {
    return { kind: 'canvas-reposition', workspaceId, canvasId, nodeId: source.origin.nodeId, origin, zoom, ghostRect }
  }
  // Anything else becomes a new node, including a tab dragged out of a node
  // of this canvas. A canvas panel cannot sit on a canvas.
  if (!canLiveOnCanvas(panelType)) return null
  if (source.origin.kind === 'layout' && env.layoutHoldsCanvas?.(source.workspaceId, source.origin.host, source.origin.layoutId)) return null
  return { kind: 'canvas-add', workspaceId, canvasId, origin, size: landing, zoom, ghostRect }
}

/** The environment of the real DOM and registries. */
export function domDropEnvironment(
  canDetach: () => boolean,
  layoutHoldsCanvas?: DropEnvironment['layoutHoldsCanvas'],
  nodeIsGroup?: DropEnvironment['nodeIsGroup'],
): DropEnvironment {
  return {
    layoutHoldsCanvas,
    nodeIsGroup,
    canvasAtCursor: defaultCanvasAtCursor,
    get dropZones() { return getDropZoneEntries() },
    canDetach,
  }
}
