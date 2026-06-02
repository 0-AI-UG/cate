import type { WorkspaceState } from '../../shared/types'

/** Whether a workspace's git monitor can be armed yet. Local workspaces are
 *  always ready; a remote/WSL workspace is only ready once its companion has
 *  finished connecting, because GIT_MONITOR_START throws for an unconnected
 *  companion id during a background session restore. Keying the monitor effect
 *  on this lets it re-arm when the companion flips to 'connected'. */
export function isWorkspaceMonitorReady(ws: WorkspaceState | undefined): boolean {
  if (!ws?.rootPath) return false
  if (!ws.connection || ws.connection.kind === 'local') return true
  return ws.companionStatus === 'connected'
}
