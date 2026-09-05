import type { PanelState, WindowPanelInfo } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useWindowPanelStore } from '../stores/windowPanelStore'
import { confirmClosePanels } from './confirmClosePanels'
import { worktreeForPanel } from './worktreeContext'

const CLOSEABLE_TYPES = new Set(['agent', 'terminal', 'editor', 'document', 'review'])

function localPanelMatches(
  panel: PanelState,
  worktreeId: string,
  worktrees: readonly { id: string; path: string }[],
): boolean {
  return CLOSEABLE_TYPES.has(panel.type)
      && worktreeForPanel(panel, worktrees)?.id === worktreeId
}

function remotePanelMatches(panel: WindowPanelInfo, worktreeId: string): boolean {
  return (panel.type === 'agent' || CLOSEABLE_TYPES.has(panel.type))
    && panel.worktreeId === worktreeId
}

export interface WorktreePanelCloseTargets {
  localPanelIds: string[]
  otherWindowPanelIds: string[]
  hasDirtyEditor: boolean
}

/** Resolve every panel that will be closed with a deleted worktree. The
 * cross-window union includes this window too, so local ids are excluded from
 * the remote half. */
export function worktreePanelCloseTargets(
  workspaceId: string,
  worktreeId: string,
): WorktreePanelCloseTargets {
  const ws = useAppStore.getState().workspaces.find((candidate) => candidate.id === workspaceId)
  const localPanels = Object.values(ws?.panels ?? {}).filter((panel) => (
    localPanelMatches(panel, worktreeId, ws?.worktrees ?? [])
  ))
  const hasDirtyEditor = localPanels.some((panel) => panel.type === 'editor' && !!panel.isDirty)
  if (!useSettingsStore.getState().closeWorktreePanelsOnDelete) {
    return { localPanelIds: [], otherWindowPanelIds: [], hasDirtyEditor }
  }
  const localIds = new Set(localPanels.map((panel) => panel.id))
  const otherWindowPanelIds = useWindowPanelStore.getState().panels
    .filter((panel) => (
      panel.workspaceId === workspaceId
      && !localIds.has(panel.panelId)
      && remotePanelMatches(panel, worktreeId)
    ))
    .map((panel) => panel.panelId)
  return {
    localPanelIds: [...localIds],
    otherWindowPanelIds,
    hasDirtyEditor,
  }
}

/** Run every owner window's normal dirty/running gates before backing data is
 * deleted. Detached owners close their panels as part of the acknowledged IPC;
 * local panels stay open until the disk operation succeeds. */
export async function prepareWorktreePanelsForClose(
  workspaceId: string,
  targets: WorktreePanelCloseTargets,
): Promise<boolean> {
  if (!(await confirmClosePanels(workspaceId, targets.localPanelIds))) return false
  for (const panelId of targets.otherWindowPanelIds) {
    if (!(await window.electronAPI.closeWindowPanel(panelId))) return false
  }
  return true
}

/** Close the already-confirmed local panels after the worktree was removed. */
export function closePreparedWorktreePanels(
  workspaceId: string,
  targets: WorktreePanelCloseTargets,
): void {
  for (const panelId of targets.localPanelIds) {
    useAppStore.getState().closePanel(workspaceId, panelId)
  }
}

/** Remove local metadata immediately and tell every other renderer to clear
 * the same worktree id from panels and chats it owns. */
export function removeWorktreeFromAllWindows(workspaceId: string, worktreeId: string): void {
  const app = useAppStore.getState()
  const path = app.workspaces.find((ws) => ws.id === workspaceId)?.worktrees?.find((wt) => wt.id === worktreeId)?.path
  app.removeWorktree(workspaceId, worktreeId)
  if (path) app.removeAdditionalRoot(workspaceId, path)
  void window.electronAPI.notifyWorktreeRemoved(workspaceId, worktreeId).catch(() => {
    // Local state is already correct; another renderer will reconcile on the
    // next session load if the best-effort broadcast is unavailable.
  })
}
