import type { AgentChangesFilter } from '../../../shared/agentChanges'
import { useAppStore } from '../../stores/appStore'
import { requestPanelTarget } from '../panelTargetPicker'
import { retargetReviewPanel } from './openReviewPanel'

export async function openAgentChanges(options: {
  workspaceId: string
  panelId: string
  cwd: string
  sessionId?: string
  turnId?: string
  focusedFile?: string
}): Promise<boolean> {
  const { workspaceId, panelId, cwd, focusedFile } = options
  const target = await requestPanelTarget({ workspaceId, sourcePanelId: panelId, panelType: 'review', availability: 'both', chooseExistingInDock: true })
  if (!target) return false
  const agentChanges: AgentChangesFilter = { panelId, sessionId: options.sessionId, turnId: options.turnId }
  const app = useAppStore.getState()
  const workspace = app.getWorkspace(workspaceId)
  const source = workspace?.panels[panelId]
  if (!source || (options.sessionId && source.agentThreadId !== options.sessionId)) return false
  const currentCwd = source.cwd ?? workspace?.worktrees?.find((w) => w.id === source.worktreeId)?.path ?? workspace?.rootPath
  if (currentCwd !== cwd) return false
  if (target.kind === 'existing') {
    const state = app.getWorkspace(workspaceId)?.panels[target.panelId]?.reviewState
    if (!state) return false
    if (state.repoPath !== cwd) app.setPanelReviewState(workspaceId, target.panelId, { ...state, repoPath: cwd, notes: [], collapsedFiles: [] })
    return retargetReviewPanel(workspaceId, target.panelId, { spec: { kind: 'uncommitted' }, agentChanges, focusedFile })
  }
  const id = app.createReview(workspaceId, cwd, { spec: { kind: 'uncommitted' }, agentChanges, focusedFile }, undefined, target.placement)
  app.updatePanelTitle(workspaceId, id, 'Agent changes')
  return true
}
