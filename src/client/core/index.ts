// The client core's one entry (architecture 12, 15): every shell starts it
// once with its transports, device and features, and gets the connections
// and the workspace list. It fills the client layer's slots itself (the
// session source, page operations, documents), so a shell installs none of
// them. The panel index and capability list come in from the shell, which
// may import the panels layer.

import type { AnyCapability, ClientFeature, DeviceInfo } from '@kernel/rpc/contract'
import type { DeviceStore } from '@kernel/state/contract'
import { createClientIdentity, installClientIdentity, WorkspaceConnections, type ClientIdentity, type ShellTransports } from '@client/connections'
import { attachDocuments } from '@client/document'
import { attachSessions, registerPanelDefinitions, serveSurfaces } from '@client/host'
import { nameJoinedWorkspaces, WorkspaceList } from '@client/workspaces'
import type { AnyPanelDefinition } from '@panels/framework/contract'

export interface ClientCoreOptions {
  device: DeviceInfo
  features: readonly ClientFeature[]
  /** The device's documents (workspace list, known runtimes, ...). */
  deviceStore: DeviceStore
  transports: ShellTransports
  version: string
  build?: string
  /** `PANEL_DEFINITIONS`. */
  panels: readonly AnyPanelDefinition[]
  /** `RUNTIME_CAPABILITIES`. */
  capabilities: readonly AnyCapability[]
}

export interface ClientCore {
  identity: ClientIdentity
  connections: WorkspaceConnections
  workspaces: WorkspaceList
  dispose(): void
}

export async function startClientCore(options: ClientCoreOptions): Promise<ClientCore> {
  registerPanelDefinitions(options.panels)
  const identity = createClientIdentity({ device: options.device, features: options.features })
  installClientIdentity(identity)
  const connections = new WorkspaceConnections({
    identity,
    transports: options.transports,
    capabilities: options.capabilities,
    version: options.version,
    ...(options.build ? { build: options.build } : {}),
  })
  const stops: (() => void)[] = [attachDocuments(connections)]
  stops.push(attachSessions(connections))
  stops.push(serveSurfaces(connections))
  const workspaces = new WorkspaceList({ store: options.deviceStore, connections })
  await workspaces.load()
  stops.push(nameJoinedWorkspaces(workspaces, connections))
  return {
    identity,
    connections,
    workspaces,
    dispose() {
      for (const stop of stops.splice(0).reverse()) {
        try { stop() } catch { /* keep disposing */ }
      }
      connections.dispose()
      workspaces.dispose()
    },
  }
}
