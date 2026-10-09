// Opening a folder of a machine this device runs commands on (SSH, WSL) as a
// workspace: the runtime is installed there first when it is missing, then
// the folder is recorded and opened like any workspace; its connection runs
// the machine's bridge.

import type { SshMachine } from '@runtime/daemon/contract'

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
