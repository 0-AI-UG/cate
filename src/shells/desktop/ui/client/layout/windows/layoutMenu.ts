// Where a layout can go from its chip or node strip: the main window or a new
// window. A layout moves whole (its tree, its panels, its name), so moving one
// out and back is one op each way.

import type { Size } from '@workspace/canvas/contract'
import {
  hostOf,
  isNodeHost,
  layoutById,
  layoutsIn,
  MAIN_WINDOW,
  type LayoutId,
  type WorkspaceDocument,
} from '@workspace/document/contract'
import type { ContextMenuItem } from '@kernel/interaction/contract'
import { clientHas } from '@client/connections'
import { moveLayout, newId } from '@client/host'
import { openWindowAt } from './windowSync'

const WINDOW_SIZE: Size = { width: 900, height: 640 }

/** The moves a layout offers, as menu items; empty when it cannot move (the
 *  main window's last layout). Run the chosen id with `runLayoutMove`. */
export function layoutMoveItems(doc: WorkspaceDocument, layoutId: LayoutId): ContextMenuItem[] {
  const host = hostOf(doc, layoutId)
  const layout = layoutById(doc, layoutId)
  if (!host || !layout) return []
  const inMain = !isNodeHost(host) && host.windowId === MAIN_WINDOW
  if (inMain && (layoutsIn(doc, host)?.length ?? 0) < 2) return []
  const canMoveOut = layout.dock !== null
  return [
    ...(inMain ? [] : [{ id: 'move-main', label: 'Move to Main Window' }]),
    ...(clientHas('windows') && canMoveOut ? [{ id: 'move-window', label: 'Move to New Window' }] : []),
  ]
}

/** Runs a move chosen from `layoutMoveItems`; false when the id is not one. */
export function runLayoutMove(workspaceId: string, layoutId: LayoutId, id: string): boolean {
  if (id === 'move-main') return moveLayout(workspaceId, layoutId, { to: 'host', host: { windowId: MAIN_WINDOW } })
  if (id === 'move-window') {
    const windowId = newId()
    openWindowAt(workspaceId, windowId, { origin: { x: window.screenX + 60, y: window.screenY + 60 }, size: WINDOW_SIZE })
    return moveLayout(workspaceId, layoutId, { to: 'window', windowId })
  }
  return false
}
