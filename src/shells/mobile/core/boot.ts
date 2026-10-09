// Starting the client core on a phone (architecture 15): the device, the
// client identity, the connections and the workspace list, over the native
// bridge. No UI here; the app renders the core's state natively.

import type { ShellTransports, WorkspaceConnections } from '@client/connections'
import { startClientCore } from '@client/core'
import { PANEL_DEFINITIONS } from '@panels/definitions'
import type { WorkspaceList } from '@client/workspaces'
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
  const info = await bridge('app.info', {})
  const device = createDeviceStore(bridge)
  const deviceKeys = await loadDeviceKeys(bridge)

  const transports = createMobileShellTransports({
    bridge,
    deviceKeys,
    deviceName: info.device,
    pins: new KnownRuntimes(device),
  })
  // The core is built from this checkout's sources, like the runtime it
  // talks to, so it carries the same version and build.
  const { connections, workspaces } = await startClientCore({
    device: { name: info.device, keyFingerprint: fingerprint(deviceKeys.publicKey) },
    features: knownFeatures(info.features),
    deviceStore: device,
    transports,
    version: RUNTIME_VERSION,
    build: RUNTIME_BUILD,
    panels: PANEL_DEFINITIONS,
    capabilities: RUNTIME_CAPABILITIES,
  })
  return { connections, workspaces, pair: transports.pair! }
}
