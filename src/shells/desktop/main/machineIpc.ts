// IPC for setting up and browsing machines this device runs commands on
// (SSH, WSL). Main checks every machine and path itself: the command line is
// built from validated fields only (runtime/daemon/contract `machineCommand`).

import { isMachine, type Machine } from '@runtime/daemon/contract'
import type { MachineProvisioner } from '@runtime/daemon/desktop'
import { DESKTOP_CHANNELS as C } from '../contract'
import { handle } from './ipc'

function machine(value: unknown): Machine {
  if (!isMachine(value)) throw new Error('invalid machine')
  return value
}

function remotePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error('invalid path')
  return value
}

export function registerMachineIpc(machines: MachineProvisioner): void {
  handle(C.machineEnsureRuntime, (_event, m: unknown) => machines.ensureRuntime(machine(m)))
  handle(C.machineListDir, (_event, m: unknown, path: unknown) => machines.listDir(machine(m), remotePath(path)))
  handle(C.machineMkdir, (_event, m: unknown, path: unknown) => machines.mkdir(machine(m), remotePath(path)))
  handle(C.machineWslDistros, () => machines.wslDistros())
  handle(C.machineCancel, (_event, m: unknown) => machines.cancel(machine(m)))
}
