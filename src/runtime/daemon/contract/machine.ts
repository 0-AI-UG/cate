// A machine this client runs commands on (architecture 7.1, 7.5): over SSH,
// or a WSL distro on this Windows machine. The client sets the runtime up
// there with small `sh` scripts and reaches it through `runtime.cjs bridge`,
// which carries the workspace's local socket over the command's stdio. Pure.

import { isBuildId } from './install'
import { formatSshTarget, isSshTarget, shQuote, type SshTarget } from './ssh'

export type Machine =
  | { kind: 'ssh'; target: SshTarget }
  | { kind: 'wsl'; distro: string }

const DISTRO = /^[\w.-]{1,64}$/

export function isMachine(value: unknown): value is Machine {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  if (m.kind === 'ssh') return isSshTarget(m.target)
  if (m.kind === 'wsl') return typeof m.distro === 'string' && DISTRO.test(m.distro) && !m.distro.startsWith('-')
  return false
}

/** A stable key for the machine: workspace ids and the sidebar use it. */
export function machineKey(machine: Machine): string {
  return machine.kind === 'ssh' ? `ssh:${formatSshTarget(machine.target)}` : `wsl:${machine.distro}`
}

/** The machine as the person knows it. */
export function machineLabel(machine: Machine): string {
  return machine.kind === 'ssh' ? machine.target.destination : `WSL: ${machine.distro}`
}

/** The program and arguments that run `sh` on the machine. `script` reads
 *  the script from stdin (`sh -s`); a string runs it with `sh -c` and leaves
 *  stdin to the command. SSH is non-interactive (keys and agent only), no
 *  tty, and a host seen for the first time is remembered. */
export function machineCommand(machine: Machine, script: 'stdin' | string): { command: string; args: string[] } {
  const sh = script === 'stdin' ? ['sh', '-s'] : ['sh', '-c', script]
  if (machine.kind === 'wsl') return { command: 'wsl.exe', args: ['-d', machine.distro, '--exec', ...sh] }
  const { target } = machine
  return {
    command: 'ssh',
    args: [
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=15',
      // A dead connection is noticed within 45 s.
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      ...(target.port ? ['-p', String(target.port)] : []),
      ...(target.identityFile ? ['-i', target.identityFile] : []),
      ...(target.jump ? ['-J', target.jump] : []),
      // ssh hands the words to the login shell as one line: quote the script.
      '--', target.destination, ...(script === 'stdin' ? sh : ['sh', '-c', shQuote(script)]),
    ],
  }
}

/** Runs `build`'s bridge to the runtime of `root` on the machine. Prints
 *  `CATE:error=not-installed` when that build is not installed there. */
export function bridgeScript(build: string, root: string): string {
  if (!isBuildId(build)) throw new Error(`invalid build ${build}`)
  const dir = `"$HOME/.cate/runtime/"${shQuote(build)}`
  return [
    `[ -f ${dir}/.ok ] && [ -x ${dir}/runtime/bin/node ] || { printf 'CATE:error=not-installed\\n'; exit 0; }`,
    `exec ${dir}/runtime/bin/node ${dir}/runtime.cjs bridge ${shQuote(root)}`,
  ].join('\n')
}
