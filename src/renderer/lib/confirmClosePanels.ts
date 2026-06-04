// =============================================================================
// confirmClosePanels — convenience wrapper that runs both close-confirmation
// gates (dirty editors, then running terminals) for a set of panel ids in a
// workspace. Returns true when the caller should proceed to close them.
// =============================================================================

import { useAppStore } from '../stores/appStore'
import { confirmCloseDirtyPanels } from './confirmCloseDirty'
import { confirmCloseRunningTerminals } from './confirmCloseTerminal'

export async function confirmClosePanels(
  workspaceId: string,
  panelIds: string[],
): Promise<boolean> {
  const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
  if (!ws) return true
  const panels = panelIds.map((id) => ws.panels[id])
  if (!(await confirmCloseDirtyPanels(panels))) return false
  if (!(await confirmCloseRunningTerminals(panels))) return false
  return true
}
