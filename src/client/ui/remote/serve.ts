// Serving a folder of a remote machine over SSH as one step for the person,
// two for the logic: `ensureRuntime` (installs this app's runtime only when
// the machine lacks it) before the folder is picked, then `serve` (never
// installs) and pairing with what it printed. Afterwards the workspace is an
// ordinary paired one; SSH is not used again.

import type { SshMachine, SshSetup } from '@runtime/daemon/contract'
import type { PairedWorkspace, WorkspaceList } from '@client/workspaces'
import type { ClientApp } from '../app'
import { joinWorkspace } from '../pairing/join'

export function folderName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export interface ServeDeps {
  ssh: SshSetup
  pair: NonNullable<ClientApp['pair']>
  workspaces: WorkspaceList
}

/** Serves `path` on `machine`, pairs this device with it and names the
 *  workspace after the folder. */
export async function serveOverSsh(machine: SshMachine, path: string, deps: ServeDeps): Promise<PairedWorkspace> {
  const served = await deps.ssh.serve(machine.target, path)
  const entry = await joinWorkspace(served.uri, { pair: deps.pair, workspaces: deps.workspaces })
  await deps.workspaces.rename(entry.id, folderName(served.root))
  return entry
}

/** `machines` with `machine` saved (added or replaced by id). */
export function withMachine(machines: readonly SshMachine[], machine: SshMachine): SshMachine[] {
  return machines.some((m) => m.id === machine.id)
    ? machines.map((m) => (m.id === machine.id ? machine : m))
    : [...machines, machine]
}

/** The parent of a remote absolute path. */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut <= 0 ? '/' : trimmed.slice(0, cut)
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}
