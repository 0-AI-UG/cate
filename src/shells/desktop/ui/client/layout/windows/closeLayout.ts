// Closing a layout removes its panels (`removeLayout`), so the view asks
// first: once for the layout, then each panel's close guard.

import { panelsInLayout, type LayoutId, type WindowId } from '@workspace/document/contract'
import { clientUi } from '@kernel/interaction'
import { documentStoreFor } from '@client/document'
import { confirmClose, removeLayout } from '@client/host'

/** Resolves true once the layout's removal went to the runtime. A window's
 *  last layout cannot be closed. */
export async function closeLayout(workspaceId: string, windowId: WindowId, layoutId: LayoutId): Promise<boolean> {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const window = doc?.windows[windowId]
  if (!doc || !window || window.layouts.length < 2) return false
  const panels = panelsInLayout(doc, windowId, layoutId)
  if (panels.length > 0) {
    const noun = panels.length === 1 ? 'panel' : 'panels'
    if (!(await clientUi().confirm(`Close this layout and its ${panels.length} ${noun}?`))) return false
    if (!(await confirmClose(workspaceId, panels))) return false
  }
  return removeLayout(workspaceId, windowId, layoutId)
}
