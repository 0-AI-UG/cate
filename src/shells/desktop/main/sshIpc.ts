// IPC for setting up a runtime on another machine over SSH. Main checks every
// target and path itself: the ssh command line is built from validated
// fields only (runtime/daemon/contract `sshArgs`).

import { isSshTarget, type SshTarget } from '@runtime/daemon/contract'
import type { SshProvisioner } from '@runtime/daemon/desktop'
import { DESKTOP_CHANNELS as C } from '../contract'
import { handle } from './ipc'

function target(value: unknown): SshTarget {
  if (!isSshTarget(value)) throw new Error('invalid SSH target')
  return value
}

function remotePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error('invalid path')
  return value
}

export function registerSshIpc(ssh: SshProvisioner): void {
  handle(C.sshEnsureRuntime, (_event, t: unknown) => ssh.ensureRuntime(target(t)))
  handle(C.sshListDir, (_event, t: unknown, path: unknown) => ssh.listDir(target(t), remotePath(path)))
  handle(C.sshMkdir, (_event, t: unknown, path: unknown) => ssh.mkdir(target(t), remotePath(path)))
  handle(C.sshServe, (_event, t: unknown, path: unknown) => ssh.serve(target(t), remotePath(path)))
}
