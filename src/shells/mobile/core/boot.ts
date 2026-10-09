// Starting the client core on a phone (architecture 15): the device, the
// client identity, the connections and the workspace list, over the native
// bridge. No UI here; the app renders the core's state natively.

import { createClientIdentity, installClientIdentity, WorkspaceConnections, type ShellTransports } from '@client/connections'
import { attachDocuments } from '@client/document'
import { registerPanelDefinitions } from '@client/host'
import { PANEL_DEFINITIONS } from '@panels/definitions'
import { WorkspaceList } from '@client/workspaces'
import { knownFeatures } from '@kernel/rpc/contract'
import { RUNTIME_BUILD, RUNTIME_VERSION } from '@runtime/daemon/contract'
import { KnownRuntimes } from '@runtime/pairing/client'
import { fingerprint } from '@runtime/security/contract'
import type { MobileBridge } from '../contract'
import { createDeviceStore, loadDeviceKeys } from './device'
import { createMobileShellTransports } from './transports'
import { RUNTIME_CAPABILITIES } from '@panels/capabilities'

export interface MobileClient {
  connections: WorkspaceConnections
  workspaces: WorkspaceList
  pair: NonNullable<ShellTransports['pair']>
}

export async function bootMobileClient(bridge: MobileBridge): Promise<MobileClient> {
  registerPanelDefinitions(PANEL_DEFINITIONS)
  const info = await bridge('app.info', {})
  const device = createDeviceStore(bridge)
  const deviceKeys = await loadDeviceKeys(bridge)

  const identity = createClientIdentity({
    device: { name: info.device, keyFingerprint: fingerprint(deviceKeys.publicKey) },
    features: knownFeatures(info.features),
  })
  installClientIdentity(identity)
  const transports = createMobileShellTransports({
    bridge,
    deviceKeys,
    deviceName: info.device,
    pins: new KnownRuntimes(device),
  })
  // The core is built from this checkout's sources, like the runtime it
  // talks to, so it carries the same version and build.
  const connections = new WorkspaceConnections({ identity, transports, capabilities: RUNTIME_CAPABILITIES, version: RUNTIME_VERSION, build: RUNTIME_BUILD })
  attachDocuments(connections)
  const workspaces = new WorkspaceList({ store: device, connections })
  await workspaces.load()
  return { connections, workspaces, pair: transports.pair! }
}
