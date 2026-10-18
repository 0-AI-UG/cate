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
import { clientUi } from '@kernel/interaction'
import { documentStoreFor } from '@client/document'
import { clientHas } from '@client/connections'
import { moveLayout, newId } from '@client/host'
import { closeLayout } from './closeLayout'
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
    ...(clientHas('windows') && canMoveOut ? [{ id: 'move-window', label: 'Move into New Window' }] : []),
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

/** A layout's context menu (rename where `onRename` is given, its moves, close) and what the pick does. */
export async function showLayoutMenu(
  e: { preventDefault(): void; stopPropagation(): void },
  workspaceId: string,
  layoutId: LayoutId,
  { onRename, closable }: { onRename?: () => void; closable: boolean },
): Promise<void> {
  e.preventDefault()
  e.stopPropagation()
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const groups: ContextMenuItem[][] = [
    [...(onRename ? [{ id: 'rename', label: 'Rename' }] : []), ...(doc ? layoutMoveItems(doc, layoutId) : [])],
    [{ id: 'close', label: 'Close Layout', enabled: closable }],
  ].filter((group) => group.length > 0)
  const ui = clientUi()
  const id = ui.showContextMenu ? await ui.showContextMenu(groups.flatMap((group, i) => (i ? [{ type: 'separator' as const }, ...group] : group))) : null
  if (id === 'rename') onRename?.()
  else if (id === 'close') await closeLayout(workspaceId, layoutId)
  else if (id) runLayoutMove(workspaceId, layoutId, id)
}
