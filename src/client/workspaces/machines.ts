// The machine a workspace lives on, for lists that group workspaces by
// machine: this device, a machine this device runs commands on (SSH, WSL),
// or the machine of a paired runtime (by the name it reported; paired
// workspaces whose machine is not known yet share one group).

import { machineKey, machineLabel, type Machine } from '@runtime/daemon/contract'
import type { WorkspaceEntry } from './workspaceList'

export type WorkspaceMachine =
  | { key: 'this'; kind: 'this' }
  | { key: string; kind: 'machine'; machine: Machine; label: string }
  | { key: string; kind: 'paired'; label: string | null }

export interface MachineGroup {
  machine: WorkspaceMachine
  /** In list order. */
  entries: WorkspaceEntry[]
}

export function machineOf(entry: WorkspaceEntry): WorkspaceMachine {
  if (entry.kind === 'local') return { key: 'this', kind: 'this' }
  if (entry.kind === 'machine') return { key: `machine:${machineKey(entry.machine)}`, kind: 'machine', machine: entry.machine, label: machineLabel(entry.machine) }
  return { key: `paired:${entry.machineName ?? ''}`, kind: 'paired', label: entry.machineName ?? null }
}

/** The entries grouped by machine; groups in the order their first entry
 *  appears. */
export function groupByMachine(entries: readonly WorkspaceEntry[]): MachineGroup[] {
  const groups = new Map<string, MachineGroup>()
  for (const entry of entries) {
    const machine = machineOf(entry)
    const group = groups.get(machine.key)
    if (group) group.entries.push(entry)
    else groups.set(machine.key, { machine, entries: [entry] })
  }
  return [...groups.values()]
}

/** The entries in the order a list grouped by machine shows them: machine
 *  by machine, list order within each. */
export function byMachine(entries: readonly WorkspaceEntry[]): WorkspaceEntry[] {
  return groupByMachine(entries).flatMap((g) => g.entries)
}
