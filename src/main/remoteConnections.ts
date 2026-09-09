import { createJsonStateFile } from './jsonStateFile'
import { getRemoteProjects } from './workspaceStateStore'
import { runtimeConnectionFromSpec, type RemoteRuntimeConnection } from '../shared/runtimeConnection'
import { isAbsoluteRuntimePath } from '../shared/runtimeLocator'

interface ConnectionsFile { migrated: boolean; connections: RemoteRuntimeConnection[] }

/** Allow only connection metadata; credentials never enter the profile file. */
export function normalizeRemoteConnection(value: unknown): RemoteRuntimeConnection | null {
  if (!value || typeof value !== 'object') return null
  const c = value as Record<string, unknown>
  if (typeof c.runtimeId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(c.runtimeId)) return null
  if (c.kind === 'server' && typeof c.host === 'string' && c.host.trim() && !/[\s/@[\]]/.test(c.host) && !c.host.startsWith('-') && typeof c.user === 'string'
    && typeof c.remotePath === 'string' && isAbsoluteRuntimePath(c.remotePath)
    && (c.port === undefined || (typeof c.port === 'number' && Number.isInteger(c.port) && c.port > 0 && c.port <= 65535))) {
    return runtimeConnectionFromSpec(c.runtimeId, { kind: 'server', host: c.host, user: c.user, port: c.port as number | undefined, remotePath: c.remotePath })
  }
  if (c.kind === 'wsl' && typeof c.distro === 'string' && c.distro.trim() && typeof c.distroPath === 'string' && isAbsoluteRuntimePath(c.distroPath)) {
    return runtimeConnectionFromSpec(c.runtimeId, { kind: 'wsl', distro: c.distro, distroPath: c.distroPath })
  }
  return null
}

const store = createJsonStateFile<ConnectionsFile>({
  filename: 'remote-connections.json',
  defaults: { migrated: false, connections: [] },
  normalize(raw, defaults) {
    if (!raw || typeof raw !== 'object') return defaults
    const value = raw as Partial<ConnectionsFile>
    const connections = new Map<string, RemoteRuntimeConnection>()
    for (const item of Array.isArray(value.connections) ? value.connections : []) {
      const connection = normalizeRemoteConnection(item)
      if (connection) connections.set(connection.runtimeId, connection)
    }
    return { migrated: value.migrated === true, connections: [...connections.values()] }
  },
})

// Serialize read/modify/flush so concurrent windows cannot overwrite one another.
let pending: Promise<unknown> = Promise.resolve()
export function updateRemoteConnections(change?: (connections: RemoteRuntimeConnection[]) => RemoteRuntimeConnection[]): Promise<RemoteRuntimeConnection[]> {
  const operation = pending.then(async () => {
    let state = store.get()
    if (!state.migrated) {
      const migrated = new Map(state.connections.map((c) => [c.runtimeId, c]))
      for (const entry of getRemoteProjects()) {
        const connection = normalizeRemoteConnection(entry.connection)
        if (connection && !migrated.has(connection.runtimeId)) migrated.set(connection.runtimeId, connection)
      }
      state = { migrated: true, connections: [...migrated.values()] }
      store.set(state)
    }
    if (change) store.set({ migrated: true, connections: change(state.connections) })
    await store.flushDurable()
    return store.get().connections
  })
  pending = operation.catch(() => {})
  return operation
}

export function watchRemoteConnections(onChange: (connections: RemoteRuntimeConnection[]) => void): void {
  store.startWatching((state) => onChange(state.connections))
}
