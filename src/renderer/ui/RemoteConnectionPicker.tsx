import { useEffect, useState } from 'react'
import { ensureWorkspaceTarget } from '../lib/runAction'
import { Server } from 'lucide-react'
import { remoteConnectSpecFromConnection, runtimeConnectionLabel, runtimeConnectionPath, type RemoteRuntimeConnection } from '../../shared/runtimeConnection'
import { useRemoteConnectionsStore } from '../stores/remoteConnectionsStore'
import { useAppStore } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'

export function RemoteConnectionPicker({ workspaceId }: { workspaceId: string }) {
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { connections, loaded, error: loadError, load } = useRemoteConnectionsStore()
  useEffect(() => { void load() }, [load])
  async function connect(connection: RemoteRuntimeConnection) {
    setPending(connection.runtimeId)
    setError(null)
    try {
      const app = useAppStore.getState()
      const existing = app.workspaces.find((ws) => ws.connection?.kind !== 'local' && ws.connection?.runtimeId === connection.runtimeId)
      if (existing) { await app.selectWorkspace(existing.id); return }
      const targetId = ensureWorkspaceTarget(workspaceId)
      if (!targetId) throw new Error('Close a workspace before opening another connection.')
      const ok = await app.connectRemoteWorkspace(targetId, remoteConnectSpecFromConnection(connection))
      if (!ok) throw new Error('Could not open this connection. Check its details in Settings.')
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setPending(null) }
  }
  return <div>
    <div className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-hover">
      <Server size={16} className="shrink-0 text-muted" />
      <select
        aria-label="Connect to remote"
        aria-busy={pending !== null}
        value={pending ?? ''}
        disabled={pending !== null}
        className="min-w-0 flex-1 cursor-pointer bg-transparent text-sm text-focus-blue outline-none focus-visible:ring-1 focus-visible:ring-focus-blue disabled:opacity-50"
        onChange={(event) => {
          if (event.target.value === '__manage') {
            useUIStore.getState().openSettings('remote connections')
            return
          }
          const connection = connections.find((c) => c.runtimeId === event.target.value)
          if (connection) void connect(connection)
        }}
      >
        <option value="" disabled className="bg-surface-5 text-primary">{!loaded && !loadError ? 'Loading connections…' : 'Connect to remote'}</option>
        {connections.map((connection) => <option key={connection.runtimeId} value={connection.runtimeId} className="bg-surface-5 text-primary">
          {pending === connection.runtimeId ? 'Connecting…' : `${runtimeConnectionLabel(connection)} · ${connection.kind === 'wsl' ? 'WSL' : 'SSH'} · ${runtimeConnectionPath(connection)}`}
        </option>)}
        {loaded && !connections.length && <option disabled className="bg-surface-5 text-muted">No saved connections yet</option>}
        <option value="__manage" className="bg-surface-5 text-primary">Manage connections…</option>
      </select>
    </div>
    {(error || loadError) && <p role="alert" className="px-2 py-2 text-xs text-danger">{error || loadError}</p>}
    {loadError && <button className="px-2 py-1.5 text-xs text-focus-blue" onClick={() => void load()}>Retry</button>}
  </div>
}
