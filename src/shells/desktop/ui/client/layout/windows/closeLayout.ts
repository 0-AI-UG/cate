// Closing a layout removes its panels (`removeLayout`), so the view asks
// first: once for the layout, then each panel's close guard.

import { hostOf, layoutsIn, panelsInLayout, type LayoutId, type PanelId } from '@workspace/document/contract'
import { clientUi } from '@kernel/interaction'
import { documentStoreFor } from '@client/document'
import { confirmClose, removeLayout } from '@client/host'

/** Resolves true once the layout's removal went to the runtime. A host's
 *  last layout cannot be closed. */
export async function closeLayout(workspaceId: string, layoutId: LayoutId): Promise<boolean> {
  const doc = documentStoreFor(workspaceId)?.getSnapshot()
  const host = doc && hostOf(doc, layoutId)
  if (!doc || !host || (layoutsIn(doc, host)?.length ?? 0) < 2) return false
  const panels = panelsInLayout(doc, layoutId)
  let discard: readonly PanelId[] = []
  if (panels.length > 0) {
    const noun = panels.length === 1 ? 'panel' : 'panels'
    if (!(await clientUi().confirm(`Close this layout and its ${panels.length} ${noun}?`))) return false
    const confirmed = await confirmClose(workspaceId, panels)
    if (!confirmed) return false
    discard = confirmed.discard
  }
  return removeLayout(workspaceId, layoutId, discard)
}
