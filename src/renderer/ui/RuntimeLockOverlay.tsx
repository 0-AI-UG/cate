import { Server } from 'lucide-react'
import { useAppStore, useSelectedWorkspace } from '../stores/appStore'
import { workspaceAvailability } from '../lib/workspace/workspaceAvailability'
import { workspaceRuntime } from '../lib/workspace/workspaceRuntime'
import { isRemoteRuntimeConnection, runtimeConnectionLabel } from '../../shared/runtimeConnection'
import { useUIStore } from '../stores/uiStore'
import { Spinner } from './Spinner'
import { Button } from './Button'

/** Remote setup and recovery live in Settings; this only blocks unusable panels. */
export function RuntimeLockOverlay(): JSX.Element | null {
  const workspace = useSelectedWorkspace()
  const localRuntimePhase = useAppStore((s) => s.localRuntimePhase)
  const runtime = workspaceRuntime(workspace)
  if (workspaceAvailability(workspace) !== 'ready') return null
  if (workspace && runtime.status === 'local') {
    if (localRuntimePhase !== null && localRuntimePhase !== 'connecting' && localRuntimePhase !== 'installing') return null
    return <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface-1/95"><Spinner size={24} className="text-muted" label="Connecting to local runtime" /></div>
  }
  if (!workspace || runtime.editable) return null
  const busy = runtime.status === 'connecting' || runtime.status === 'installing'
  const label = isRemoteRuntimeConnection(workspace.connection) ? runtimeConnectionLabel(workspace.connection) : 'Remote workspace'
  return <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface-1/95">
    <div className="flex max-w-md flex-col items-center gap-3 px-6 text-center">
      {busy ? <Spinner size={24} className="text-muted" /> : <Server size={24} className="text-muted" />}
      <p className="text-sm font-medium text-primary">{label}</p>
      <p role="status" className="text-xs text-muted">{runtime.status === 'installing' ? 'Installing runtime…' : runtime.status === 'connecting' ? 'Connecting…' : 'Manage this connection in Settings to finish setup or reconnect.'}</p>
      {runtime.error && <p className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs text-danger">{runtime.error}</p>}
      <Button size="sm" onClick={() => useUIStore.getState().openSettings('remote connections')}>Manage connections</Button>
    </div>
  </div>
}
