// A panel chip's context menu, shared by the window strip and the sidebar's rows: rename, move out, close.

import type { PanelId } from '@workspace/document/contract'
import type { ContextMenuItem } from '@kernel/interaction/contract'
import { clientUi } from '@kernel/interaction'
import { documentStoreFor } from '@client/document'
import { clientHas } from '@client/connections'
import { closePanels, newId, panelDefaultSize } from '@client/host'
import { openWindowAt } from './windowSync'

/** Moves a panel into a new window (a placement op every client sees). */
export function moveToNewWindow(workspaceId: string, panelId: PanelId): void {
  const store = documentStoreFor(workspaceId)
  const record = store?.getSnapshot().panels[panelId]
  if (!store || !record) return
  const windowId = newId()
  openWindowAt(workspaceId, windowId, { origin: { x: window.screenX + 60, y: window.screenY + 60 }, size: panelDefaultSize(record.type) })
  store.propose({ kind: 'placePanel', id: panelId, at: { to: 'window', windowId, layoutId: newId(), stackId: newId() } })
}

export async function showPanelMenu(
  e: { preventDefault(): void; stopPropagation(): void },
  workspaceId: string,
  panelId: PanelId,
  { onRename }: { onRename: () => void },
): Promise<void> {
  e.preventDefault()
  e.stopPropagation()
  const ui = clientUi()
  if (!ui.showContextMenu) return
  const items: ContextMenuItem[] = [
    { id: 'rename', label: 'Rename' },
    ...(clientHas('windows') ? [{ id: 'move-window', label: 'Move into New Window' }] : []),
    { type: 'separator' },
    { id: 'close', label: 'Close' },
  ]
  const id = await ui.showContextMenu(items)
  if (id === 'rename') onRename()
  else if (id === 'move-window') moveToNewWindow(workspaceId, panelId)
  else if (id === 'close') await closePanels(workspaceId, [panelId])
}
