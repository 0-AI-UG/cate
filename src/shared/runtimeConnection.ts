import type { RemoteConnectSpec, RuntimeConnection } from './types'

/** A connection that needs an out-of-process runtime (SSH server or WSL). */
export type RemoteRuntimeConnection = Exclude<RuntimeConnection, { kind: 'local' }>

/** Canonical interpretation of absent/local connection records. */
export function isRemoteRuntimeConnection(
  connection: RuntimeConnection | null | undefined,
): connection is RemoteRuntimeConnection {
  return connection != null && connection.kind !== 'local'
}

/** Runtime-absolute workspace path, independent of the transport kind. */
export function runtimeConnectionPath(connection: RemoteRuntimeConnection): string {
  return connection.kind === 'server' ? connection.remotePath : connection.distroPath
}

/** Human-readable endpoint identity used for workspace names and status UI. */
export function runtimeConnectionLabel(
  connection: RemoteRuntimeConnection | RemoteConnectSpec,
): string {
  return connection.kind === 'server'
    ? `${connection.user}@${connection.host}`
    : connection.distro
}

/** Persistable, secret-free connection record for a newly registered runtime. */
export function runtimeConnectionFromSpec(
  runtimeId: string,
  spec: RemoteConnectSpec,
): RemoteRuntimeConnection {
  return spec.kind === 'server'
    ? {
        kind: 'server',
        runtimeId,
        host: spec.host,
        user: spec.user,
        port: spec.port,
        remotePath: spec.remotePath,
      }
    : {
        kind: 'wsl',
        runtimeId,
        distro: spec.distro,
        distroPath: spec.distroPath,
      }
}

/** Transport input reconstructed from persisted connection data. Secrets stay
 *  outside this adapter and are re-attached by the main-process secret store. */
export function remoteConnectSpecFromConnection(
  connection: RemoteRuntimeConnection,
): RemoteConnectSpec {
  return connection.kind === 'server'
    ? {
        kind: 'server',
        host: connection.host,
        user: connection.user,
        port: connection.port,
        remotePath: connection.remotePath,
      }
    : {
        kind: 'wsl',
        distro: connection.distro,
        distroPath: connection.distroPath,
      }
}
