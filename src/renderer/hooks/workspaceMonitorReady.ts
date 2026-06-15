import type { WorkspaceState } from '../../shared/types'
import { workspaceRuntime } from '../lib/workspace/workspaceRuntime'

/** Whether a workspace's git monitor can be armed yet. Local workspaces are
 *  always ready; a remote/WSL workspace is only ready once its runtime is
 *  connected, because GIT_MONITOR_START throws for an unconnected runtime id
 *  during a background session restore. Delegates to the canonical runtime
 *  status (`editable` ⇔ local || connected), so it can never drift from the
 *  canvas lock's notion of "usable". Keying the monitor effect on this lets it
 *  re-arm when the runtime flips to connected. */
export function isWorkspaceMonitorReady(ws: WorkspaceState | undefined): boolean {
  if (!ws?.rootPath) return false
  return workspaceRuntime(ws).editable
}
