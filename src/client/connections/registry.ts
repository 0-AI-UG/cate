// The open workspace connections of this client. It fills the kernel/rpc
// runtime slot, so `runtimeFor(workspaceId)` works for everything above.

import { notifyRuntimesChanged, setRuntimeResolver } from '@kernel/rpc/client'
import { WorkspaceConnection, type Backoff } from './connection'
import type { ClientIdentity } from './identity'
import type { ConnectionTarget, ShellTransports } from './transports'

export interface WorkspaceConnectionsOptions {
  identity: ClientIdentity
  transports: ShellTransports
  version: string
  /** App build: a runtime of another build is incompatible. */
  build?: string
  backoff?: Partial<Backoff>
  now?: () => number
}

export class WorkspaceConnections {
  private readonly byId = new Map<string, WorkspaceConnection>()
  private readonly listeners = new Set<() => void>()
  private snapshot: readonly WorkspaceConnection[] = []
  private readonly uninstall: () => void

  constructor(private readonly opts: WorkspaceConnectionsOptions) {
    this.uninstall = setRuntimeResolver((workspaceId) => this.byId.get(workspaceId)?.runtime ?? null)
  }

  /** Opens (and starts) the workspace's connection, or returns the open one. */
  open(workspaceId: string, target: ConnectionTarget): WorkspaceConnection {
    const existing = this.byId.get(workspaceId)
    if (existing) return existing
    const connection = new WorkspaceConnection({ ...this.opts, workspaceId, target })
    this.byId.set(workspaceId, connection)
    this.changed()
    connection.start()
    return connection
  }

  get(workspaceId: string): WorkspaceConnection | undefined {
    return this.byId.get(workspaceId)
  }

  close(workspaceId: string): void {
    const connection = this.byId.get(workspaceId)
    if (!connection) return
    this.byId.delete(workspaceId)
    this.changed()
    connection.close()
  }

  getSnapshot = (): readonly WorkspaceConnection[] => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    for (const id of [...this.byId.keys()]) this.close(id)
    this.uninstall()
    this.listeners.clear()
  }

  private changed(): void {
    this.snapshot = [...this.byId.values()]
    notifyRuntimesChanged()
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* isolate listeners */ }
    }
  }
}
