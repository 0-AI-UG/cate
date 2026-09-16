import { compilePanelRelationContext, isExecutionSurface } from '../../../shared/panelRelations'
import type { PanelState, WorkspaceState } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { getDocumentType } from '../fs/fileRouting'
import { worktreeForPanel } from '../worktreeContext'
import { editorDocument, type EditorDocument } from './editorDocuments'

export function connectedEditors(workspace: WorkspaceState, sourceId: string): PanelState[] {
  const context = compilePanelRelationContext(sourceId, workspace.panels, workspace.panelRelations ?? [])
  return (context?.relatedPanelIds ?? []).map(id => workspace.panels[id])
    .filter(panel => panel.type === 'editor' && (!panel.filePath || !getDocumentType(panel.filePath)))
}

function documentFor(workspace: WorkspaceState, panel: PanelState): EditorDocument {
  const root = worktreeForPanel(panel, workspace.worktrees ?? [])?.path ?? workspace.rootPath
  return editorDocument(workspace.id, panel.id, panel.filePath, root)
}

/** Runs in each owning window, including when the editor's view is unmounted. */
export function startConnectedEditorSync(): () => void {
  let active = new Set<EditorDocument>()
  let stopped = false
  let scheduled = false
  const reconcile = () => {
    scheduled = false
    if (stopped) return
    const next = new Set<EditorDocument>()
    if (useSettingsStore.getState().panelRelationsEnabled) {
      for (const workspace of useAppStore.getState().workspaces) {
        for (const source of Object.values(workspace.panels)) {
          if (!isExecutionSurface(source.type)) continue
          for (const panel of connectedEditors(workspace, source.id)) next.add(documentFor(workspace, panel))
        }
      }
    }
    for (const document of active) if (!next.has(document)) document.setShared(false)
    active = next
    for (const document of active) document.setShared(true)
  }
  const schedule = () => {
    if (!scheduled) { scheduled = true; queueMicrotask(reconcile) }
  }
  const offApp = useAppStore.subscribe(schedule)
  const offSettings = useSettingsStore.subscribe(schedule)
  reconcile()
  return () => {
    stopped = true
    offApp(); offSettings()
    for (const document of active) document.setShared(false)
  }
}

export async function flushConnectedEditors(workspaceId: string, sourceId: string): Promise<void> {
  if (!useSettingsStore.getState().panelRelationsEnabled) return
  const workspace = useAppStore.getState().workspaces.find(ws => ws.id === workspaceId)
  if (!workspace) return
  for (const panel of connectedEditors(workspace, sourceId)) {
    if (!await documentFor(workspace, panel).flushShared()) {
      throw new Error(`Could not sync “${panel.title}”. Resolve its editor conflict or save error, then send again.`)
    }
  }
}
