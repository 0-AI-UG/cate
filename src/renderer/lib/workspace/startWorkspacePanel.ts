import { useAppStore } from '../../stores/appStore'
import { ensureWorkspaceFolder } from '../runAction'
import { createInteractivePanel } from '../panels/createInteractivePanel'

/** Finish a chooser action after folder selection, trust, and saved-layout restore. */
export async function startWorkspacePanel(workspaceId: string, type: 'terminal' | 'agent' | 'editor' | 'browser'): Promise<string | null> {
  const targetId = await ensureWorkspaceFolder(workspaceId)
  if (!targetId) return null
  const workspace = useAppStore.getState().getWorkspace(targetId)
  if (!workspace?.rootPath) return null
  const canvasId = Object.values(workspace.panels).find((panel) => panel.type === 'canvas')?.id
    ?? createInteractivePanel('canvas', { workspaceId: targetId, placement: { target: 'dock', zone: 'center' } })
  if (!canvasId) return null
  // Pin both ownership and position: the chooser may have unmounted, and the
  // new canvas need not have painted yet. This action needs no placement click.
  return createInteractivePanel(type, {
    workspaceId: targetId,
    placement: { target: 'canvas', canvasPanelId: canvasId, position: { x: 80, y: 80 } },
  })
}
