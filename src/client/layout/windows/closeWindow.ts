// Closing a detached window removes its panels (`closeWindow`), so the view
// asks first: once for the window, then each panel's close guard.

import { MAIN_WINDOW, panelsInWindow, type WindowId } from '@workspace/document/contract'
import { clientUi } from '@kernel/ui'
import { documentStoreFor } from '@client/document'
import { confirmClose } from '@client/host'

/** Resolves true once the window's close went to the runtime. */
export async function closeDetachedWindow(workspaceId: string, windowId: WindowId): Promise<boolean> {
  const store = documentStoreFor(workspaceId)
  const doc = store?.getSnapshot()
  if (!store || !doc?.windows[windowId] || windowId === MAIN_WINDOW) return false
  const panels = panelsInWindow(doc, windowId)
  if (panels.length > 0) {
    const noun = panels.length === 1 ? 'panel' : 'panels'
    if (!(await clientUi().confirm(`Close this window and its ${panels.length} ${noun}?`))) return false
    if (!(await confirmClose(workspaceId, panels))) return false
  }
  if (!store.getSnapshot().windows[windowId]) return false
  return store.propose({ kind: 'closeWindow', windowId }).ok
}
