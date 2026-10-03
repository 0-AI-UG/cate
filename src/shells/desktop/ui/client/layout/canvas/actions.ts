// Creating panels on a canvas from the canvas UI (toolbar, context menu,
// shortcuts, relation drags). A new panel inherits the selected node's
// checkout; without an explicit spot it goes through the placement picker
// when that setting is on.

import { documentStoreFor } from '@client/document'
import type { Point, Size } from '@workspace/canvas/contract'
import { inheritWorktree, type PanelCheckoutHooks } from '@workspace/repository/contract'
import type { CanvasId, NodeId, PanelId, PanelRecord } from '@workspace/document/contract'
import { canvasPanelOf } from '@workspace/document/contract'
import { canvasHost, panelDefinition } from './ports'
import { canvasViewFor } from './registry'
import { canvasSetting } from './settings'
import { activeNodePanelId, type CanvasViewStore } from './store'
import { focusedNodeId } from './selection'
import { clientStateFor } from '@client/document'

/** Checkout hooks from the panel definitions, so no code branches on type. */
export const checkoutHooks: PanelCheckoutHooks = {
  checkoutPath: (record) => panelDefinition(record.type)?.checkoutPath?.(record),
  bound: (type) => !!panelDefinition(type)?.switchesWorktree,
  workingDir: (record) => panelDefinition(record.type)?.checkoutPath?.(record),
}

/** The checkout of the canvas's focused node's visible panel, for a new panel
 *  to inherit. */
export function inheritedCheckout(workspaceId: string, store: CanvasViewStore): { cwd?: string; worktreeId?: string } {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const state = store.getState()
  const nodeId = focusedNodeId(state)
  if (!doc || !nodeId) return {}
  const panelId = activeNodePanelId(state.nodes[nodeId]?.dock, clientStateFor(workspaceId)?.getSnapshot().activeTabs)
  const record: PanelRecord | undefined = panelId ? doc.panels[panelId] : undefined
  return inheritWorktree(record, Object.values(doc.worktrees), checkoutHooks)
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
  const { position, exact, size: sizeOption, focus, ...rest } = options
  if (!store || !doc || !definition) return null
  const checkout = rest.worktreeId || rest.cwd ? {} : inheritedCheckout(workspaceId, store)
  const createOptions = { ...checkout, ...rest }

  if (!definition.canLiveOnCanvas) {
    const near = canvasPanelOf(doc, canvasId)?.id
    return host.createPanel(workspaceId, type, { ...createOptions, ...(near ? { near } : {}) })
  }

  const size = sizeOption ?? definition.defaultSize
  const create = (point: Point | undefined, nodeSize: Size, exactPoint: boolean): { id: PanelId; nodeId: NodeId } | null => {
    const at = store.getState().placeTarget(nodeSize, point ? { position: point, exact: exactPoint } : {})
    const id = host.createPanel(workspaceId, type, { ...createOptions, at })
    if (!id) return null
    if (focus !== false) store.getState().focusAndCenter(at.nodeId)
    return { id, nodeId: at.nodeId }
  }

  if (position || !canvasSetting('placementPicker')) return create(position, size, !!exact)?.id ?? null

  let created: PanelId | null = null
  const began = store.getState().beginPanelTarget({
    panelType: type,
    availability: 'new',
    existing: [],
    size,
    // The picker's spots are already free and grid aligned.
    place: (point, nodeSize) => {
      const made = create(point, nodeSize, true)
      created = made?.id ?? null
      return made?.nodeId ?? null
    },
    onCancelled: () => {},
  })
  if (!began) return create(undefined, size, false)?.id ?? null
  return created
}
