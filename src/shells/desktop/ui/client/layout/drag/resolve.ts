// Hit testing: cursor and source to a typed DropTarget. The DOM and registry
// lookups come in through a DropEnvironment so tests can pass a fake.

import { snapToGrid, CANVAS_GRID_SIZE, type Point, type Size } from '@workspace/canvas/contract'
import { isCanvasDock } from '@workspace/document/contract'
import { canLiveOnCanvas } from '@client/host'
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
  if (!cursor.insideWindow) return env.canDetach() ? { kind: 'detach', screen: cursor.screen } : null
  return resolveDockHit(cursor.client, source, panelType, env)
    ?? resolveCanvasHit(cursor, source, grab, ghostSize, panelType, env, snap)
}

function resolveDockHit(client: Point, source: DragSource, panelType: string, env: DropEnvironment): DropTarget | null {
  type Hit = { entry: DropZoneEntry; rect: DOMRect; area: number }
  const hits: Hit[] = []
  const ownNode = source.origin.kind === 'canvas-node' ? source.origin.nodeId : null
  const onCanvas = canLiveOnCanvas(panelType)
  for (const entry of env.dropZones) {
    if (entry.workspaceId !== source.workspaceId) continue
    if (entry.acceptsPanel && !entry.acceptsPanel(panelType)) continue
    if (isCanvasDock(entry.dock)) {
      // A canvas panel never goes onto a canvas; a dragged node never drops
      // into its own mini dock (the drop would remove the node under it).
      if (!onCanvas || entry.dock.nodeId === ownNode) continue
    }
    const rect = entry.getRect()
    if (!rect) continue
    if (client.x >= rect.left && client.x <= rect.right && client.y >= rect.top && client.y <= rect.bottom) {
      hits.push({ entry, rect, area: rect.width * rect.height })
    }
  }
  if (hits.length === 0) return null

  // Stacks before whole docks and edges; the tightest fit first.
  hits.sort((a, b) => {
    const specA = a.entry.stackId ? 0 : 1
    const specB = b.entry.stackId ? 0 : 1
    if (specA !== specB) return specA - specB
    return a.area - b.area
  })
  const { entry, rect } = hits[0]
  const workspaceId = entry.workspaceId
  if (entry.noopFor?.(source)) return null
  if (entry.newLayout && !isCanvasDock(entry.dock)) return { kind: 'layout-new', workspaceId, windowId: entry.dock.windowId }

  if (entry.stackId) {
    const edge = resolveDropEdge(client.x, client.y, rect)
    if (edge === null) return null
    const selfStack = source.origin.kind === 'dock-tab' && source.origin.stackId === entry.stackId
    // A lone tab cannot split against its own stack (the other half would be
    // empty). Dropping it back on its own tab bar still previews and commits
    // as a no-op.
    if (selfStack && (entry.tabCount?.() ?? 1) <= 1 && edge !== 'center') return null
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
  const ghostRect = snap ? snappedGhostScreenRect(origin, hit.rect, zoom, offset, ghostSize) : undefined
  const { workspaceId, canvasId } = hit

  // A node already on this canvas moves.
  if (source.origin.kind === 'canvas-node' && source.origin.canvasId === canvasId) {
    return { kind: 'canvas-reposition', workspaceId, canvasId, nodeId: source.origin.nodeId, origin, zoom, ghostRect }
  }
  // Anything else becomes a new node, including a tab dragged out of a node
  // of this canvas. A canvas panel cannot sit on a canvas.
  if (!canLiveOnCanvas(panelType)) return null
  return { kind: 'canvas-add', workspaceId, canvasId, origin, size: ghostSize, zoom, ghostRect }
}

/** The environment of the real DOM and registries. */
export function domDropEnvironment(canDetach: () => boolean): DropEnvironment {
  return {
    canvasAtCursor: defaultCanvasAtCursor,
    get dropZones() { return getDropZoneEntries() },
    canDetach,
  }
}
