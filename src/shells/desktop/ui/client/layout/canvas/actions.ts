// Creating panels on a canvas from the canvas UI (toolbar, context menu,
// shortcuts, relation drags). A new panel inherits the selected node's
// checkout; without an explicit spot it goes through the placement picker
// when that setting is on.

import { documentStoreFor } from '@client/document'
import type { Point, Size } from '@workspace/canvas/contract'
import { inheritedCheckout as checkoutOfPanel } from '@client/host'
import type { CanvasId, NodeId, PanelId, PlaceTarget } from '@workspace/document/contract'
import { canvasPanelOf } from '@workspace/document/contract'
import { canvasHost, panelDefinition } from './ports'
import { canvasViewFor } from './registry'
import { canvasSetting } from './settings'
import { activeNodePanelId, type CanvasViewStore } from './store'
import { focusedNodeId } from './selection'
import { clientStateFor } from '@client/document'

/** The checkout of the canvas's focused node's visible panel, for a new panel
 *  to inherit. */
export function inheritedCheckout(workspaceId: string, store: CanvasViewStore): { cwd?: string; worktreeId?: string } {
  const state = store.getState()
  const nodeId = focusedNodeId(state)
  if (!nodeId) return {}
  return checkoutOfPanel(workspaceId, activeNodePanelId(state.nodes[nodeId]?.dock, clientStateFor(workspaceId)?.getSnapshot().activeTabs))
}

export interface CanvasCreateOptions {
  /** Canvas point for the node's top-left; skips the picker. */
  position?: Point
  /** Land exactly at `position` instead of nudging it free. */
  exact?: boolean
  size?: Size
  /** Focus and centre the new node (default true). */
  focus?: boolean
  worktreeId?: string
  cwd?: string
  /** The type's own create options (url, filePath, ...). */
  [key: string]: unknown
}

/** Creates a panel of `type` on the canvas. Returns its id, or null when it
 *  was not created yet (the picker is open) or failed. A type that cannot
 *  live on a canvas goes next to the canvas panel instead. */
export function createPanelOnCanvas(workspaceId: string, canvasId: CanvasId, type: string, options: CanvasCreateOptions = {}): PanelId | null {
  const host = canvasHost()
  const store = canvasViewFor(workspaceId, canvasId)
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const definition = panelDefinition(type)
  const { position, exact, size, focus, ...rest } = options
  if (!store || !doc || !definition) return null
  const checkout = rest.worktreeId || rest.cwd ? {} : inheritedCheckout(workspaceId, store)
  const createOptions = { ...checkout, ...rest }

  if (!definition.canLiveOnCanvas) {
    const near = canvasPanelOf(doc, canvasId)?.id
    return host.createPanel(workspaceId, type, { ...createOptions, ...(near ? { near } : {}) })
  }

  let created: PanelId | null = null
  placeOnCanvas(workspaceId, canvasId, type, (at) => {
    created = host.createPanel(workspaceId, type, { ...createOptions, at })
    return created !== null
  }, { position, exact, size, focus })
  return created
}

/** Where `placeOnCanvas` puts a new node. */
export interface CanvasPlaceOptions {
  position?: Point
  exact?: boolean
  size?: Size
  /** Focus and centre the new node (default true). */
  focus?: boolean
}

/** Picks a spot for a new panel of `type` the way `createPanelOnCanvas` does
 *  (as `planPlacement` plans it: the picker when that setting is on and the
 *  canvas has nodes, else straight to the planned spot)
 *  and hands it to `make`, which creates the panel there and answers whether
 *  it did. `make` may run later, once the person picked. */
export function placeOnCanvas(
  workspaceId: string,
  canvasId: CanvasId,
  type: string,
  make: (at: Extract<PlaceTarget, { to: 'canvas' }>) => boolean,
  options: CanvasPlaceOptions = {},
): void {
  const store = canvasViewFor(workspaceId, canvasId)
  if (!store) return
  const size = options.size ?? panelDefinition(type)?.defaultSize
  if (!size) return
  const place = (point: Point | undefined, nodeSize: Size, exactPoint: boolean): NodeId | null => {
    const at = store.getState().placeTarget(nodeSize, point ? { position: point, exact: exactPoint } : {})
    if (!make(at)) return null
    if (options.focus !== false) store.getState().focusAndCenter(at.nodeId)
    return at.nodeId
  }

  if (options.position) {
    place(options.position, size, !!options.exact)
    return
  }
  const began = store.getState().beginPanelTarget({
    panelType: type,
    availability: 'new',
    existing: [],
    size,
    pick: canvasSetting('placementPicker'),
    // The planned spots are already free and grid aligned.
    place: (point, nodeSize) => place(point, nodeSize, true),
    onCancelled: () => {},
  })
  if (!began) place(undefined, size, false)
}
