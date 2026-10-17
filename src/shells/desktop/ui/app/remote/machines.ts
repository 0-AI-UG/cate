// SSH machines this device remembers (the client setting `sshMachines`): a
// machine is saved once it answered, with the folder opened last on it.
// WSL distros are listed afresh each time and never saved.

import { formatSshTarget, type Machine, type SshMachine } from '@runtime/daemon/contract'
import { getClientSetting, setClientSetting } from '../../kernel/settings'
import { withMachine } from './paths'

/** The saved SSH machine `machine` is, if any. */
export function savedMachine(machine: Machine): SshMachine | undefined {
  if (machine.kind !== 'ssh') return undefined
  const key = formatSshTarget(machine.target)
  return getClientSetting('sshMachines').find((m) => formatSshTarget(m.target) === key)
}

/** Saves an SSH machine (when new) and the folder opened on it. */
export function rememberMachine(machine: Machine, lastPath?: string): void {
  if (machine.kind !== 'ssh') return
  const current = savedMachine(machine) ?? { id: crypto.randomUUID(), target: machine.target }
  setClientSetting('sshMachines', withMachine(getClientSetting('sshMachines'), lastPath ? { ...current, lastPath } : current))
}

export function forgetMachine(id: string): void {
  setClientSetting('sshMachines', getClientSetting('sshMachines').filter((m) => m.id !== id))
}
