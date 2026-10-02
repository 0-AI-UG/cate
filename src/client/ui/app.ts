// What client/ui needs from the running client: the device's workspace list,
// the open connections, and how to pair with an unknown runtime. The shell
// builds these at start and installs them once.

import type { SshSetup } from '@runtime/daemon/contract'
import type { ShellTransports, WorkspaceConnections } from '@client/connections'
import type { WorkspaceList } from '@client/workspaces'

export interface ClientApp {
  workspaces: WorkspaceList
  connections: WorkspaceConnections
  /** This client's release version, sent with `runtime.update`. */
  version: string
  /** The shell's `ShellTransports.pair`; absent on a shell that cannot join
   *  network workspaces. */
  pair?: NonNullable<ShellTransports['pair']>
  /** Setting up a runtime on another machine over SSH; absent on a shell
   *  that cannot run ssh. */
  ssh?: SshSetup
}

let installed: ClientApp | null = null
const listeners = new Set<() => void>()

export function installClientApp(app: ClientApp | null): void {
  installed = app
  for (const l of [...listeners]) l()
}

export function clientApp(): ClientApp {
  if (!installed) throw new Error('No client app installed')
  return installed
}

export function tryClientApp(): ClientApp | null {
  return installed
}
