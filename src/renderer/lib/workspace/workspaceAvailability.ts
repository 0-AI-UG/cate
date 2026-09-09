import type { WorkspaceState } from '../../../shared/types'

export type WorkspaceAvailability = 'unselected' | 'opening' | 'ready'

/** Project readiness, independent of panel layout and remote runtime status. */
export function workspaceAvailability(workspace: Pick<WorkspaceState, 'rootPath' | 'isRootPathPending'> | undefined): WorkspaceAvailability {
  if (workspace?.isRootPathPending) return 'opening'
  return workspace?.rootPath ? 'ready' : 'unselected'
}
