import type { GitComparisonSpec } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import { worktreeForPath } from '../worktreeContext'

/** Points a review panel at another checkout, stashing the current checkout's
 *  comparison and notes so switching back restores them. */
export function switchReviewCheckout(
  workspaceId: string,
  panelId: string,
  target: { id?: string; path: string; branch?: string },
): boolean {
  const app = useAppStore.getState()
  const workspace = app.getWorkspace(workspaceId)
  const state = workspace?.panels[panelId]?.reviewState
  if (!state) return false
  if (target.path === state.repoPath) return true
  const { worktreeStates = {}, ...current } = state
  const spec: GitComparisonSpec = state.spec.kind === 'branch'
    ? { ...state.spec, target: target.branch || 'HEAD' }
    : state.spec
  app.setPanelReviewState(workspaceId, panelId, {
    ...(worktreeStates[target.path] ?? { repoPath: target.path, spec, agentChanges: state.agentChanges ? {} : undefined }),
    display: state.display,
    worktreeStates: { ...worktreeStates, [state.repoPath]: current },
  })
  app.setPanelWorktreeId(workspaceId, panelId, target.id ?? worktreeForPath(target.path, workspace.worktrees ?? [])?.id)
  return true
}
