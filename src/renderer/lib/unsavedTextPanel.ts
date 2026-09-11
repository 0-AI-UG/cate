import { requestPanelTarget } from './panelTargetPicker'
import { createInteractivePanel } from './panels/createInteractivePanel'
import { useAppStore } from '../stores/appStore'

export interface UnsavedTextPanelRequest {
  workspaceId: string
  sourcePanelId?: string
  title: string
  content: string
}

/** Open generated text as an untitled editor buffer through the normal panel
 * placement flow. The user can explicitly save it from the editor if needed. */
export async function openUnsavedTextPanel(
  request: UnsavedTextPanelRequest,
): Promise<string | null> {
  const workspace = useAppStore.getState().workspaces.find(
    (candidate) => candidate.id === request.workspaceId,
  )
  if (!workspace) return null

  const target = await requestPanelTarget({
    workspaceId: request.workspaceId,
    sourcePanelId: request.sourcePanelId,
    panelType: 'editor',
    availability: 'new',
  })
  if (!target || target.kind !== 'new') return null

  const panelId = createInteractivePanel(
    'editor',
    { workspaceId: request.workspaceId, placement: target.placement },
    request.sourcePanelId ? workspace.panels[request.sourcePanelId] : undefined,
  )
  if (!panelId) return null

  const app = useAppStore.getState()
  app.updatePanelTitle(request.workspaceId, panelId, request.title.trim() || 'Untitled')
  app.setPanelUnsavedContent(request.workspaceId, panelId, request.content)
  app.setPanelDirty(request.workspaceId, panelId, true)
  return panelId
}
