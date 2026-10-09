// Machines the desktop shell runs commands on (architecture 7.1, 7.5): over
// the system `ssh` (so ~/.ssh/config, keys, the agent and known_hosts apply)
// or `wsl.exe`. `createMachineProvisioner` pipes small scripts to the
// machine's `sh -s` to install this app's build and browse folders;
// `dialMachine` runs that build's `runtime.cjs bridge`, which starts the
// workspace's runtime when nothing answers and carries its local socket over
// the command's stdio.

import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ByteDuplex } from '@kernel/rpc/contract'
import {
  BRIDGE_READY,
  machineKey,
  bridgeScript,
  installScript,
  isMachine,
  listDirScript,
  machineCommand,
  machineLabel,
  mkdirScript,
  parseDirListing,
  parseMkdir,
  parseProbe,
  readMarked,
  probeScript,
  type Machine,
  type MachineSetup,
  type SshProbe,
} from '../contract'

export interface MachineRunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Runs `script` with `sh -s` on `machine`; `signal` stops it. */
export type MachineRunner = (machine: Machine, script: string, timeoutMs: number, signal?: AbortSignal) => Promise<MachineRunResult>

const SHORT_MS = 45_000
const INSTALL_MS = 10 * 60_000
/** ssh, the bridge's Node and, when it has to, the runtime's start. */
const BRIDGE_MS = 60_000

function spawnError(machine: Machine, err: NodeJS.ErrnoException): Error {
  if (err.code !== 'ENOENT') return err
  return new Error(machine.kind === 'ssh'
    ? 'No `ssh` command was found. Install OpenSSH and try again.'
    : 'No `wsl.exe` was found. Install WSL and try again.')
}

/** The system `ssh` or `wsl.exe`, with the script on stdin. */
export function systemMachineRunner(): MachineRunner {
  return (machine, script, timeoutMs, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled.'))
    const { command, args } = machineCommand(machine, 'stdin')
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${machineLabel(machine)} did not answer in time.`))
    }, timeoutMs)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      child.kill()
      reject(new Error('Cancelled.'))
    }, { once: true })
    child.stdout.setEncoding('utf-8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf-8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(spawnError(machine, err))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.on('error', () => { /* exited early; reported on close */ })
    child.stdin.end(`${script}\n`)
  })
}

/** A message for the command's own failure: ssh's (exit 255) or wsl.exe's. */
export function machineErrorMessage(machine: Machine, stderr: string): string {
  const text = stderr.replace(/\0/g, '').trim()
  const name = machineLabel(machine)
  if (machine.kind === 'ssh') {
    if (/Permission denied/i.test(text)) {
      return `${name} refused the login. Cate signs in with your SSH keys or agent, not a password: check that \`ssh ${name}\` works in a terminal without asking for one.`
    }
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(text)) {
      return `The host key of ${name} does not match the one in known_hosts. Check the machine, then fix known_hosts.`
    }
    if (/Could not resolve hostname/i.test(text)) return `${name} could not be found.`
    if (/Connection refused|timed out|No route to host/i.test(text)) return `${name} could not be reached over SSH.`
  }
  const last = text.split(/\r?\n/).filter(Boolean).pop()
  return last ? `${name}: ${last}` : `The command on ${name} failed.`
}

export interface MachineProvisioner extends MachineSetup {
  ensureRuntime(machine: Machine): Promise<SshProbe & { installedNow: boolean }>
}

export function createMachineProvisioner(deps: {
  /** This app's build; the install the machine needs. */
  build: string | undefined
  version: string
  run?: MachineRunner
  /** The WSL distros (`wsl.exe --list --quiet`); default: none off Windows. */
  wslDistros?: () => Promise<string[]>
}): MachineProvisioner {
  const run = deps.run ?? systemMachineRunner()
  /** What runs per machine, for `cancel`. */
  const running = new Map<string, Set<AbortController>>()

  const exec = async (machine: Machine, script: string, timeoutMs = SHORT_MS): Promise<string> => {
    if (!isMachine(machine)) throw new Error('invalid machine')
    const key = machineKey(machine)
    const controller = new AbortController()
    const set = running.get(key) ?? new Set()
    running.set(key, set.add(controller))
    const result = await run(machine, script, timeoutMs, controller.signal).finally(() => {
      set.delete(controller)
      if (set.size === 0 && running.get(key) === set) running.delete(key)
    })
    if (result.code === 255 || (result.code !== 0 && machine.kind === 'wsl' && !result.stdout)) {
      throw new Error(machineErrorMessage(machine, result.stderr))
    }
    if (result.code !== 0) {
      const last = result.stderr.trim().split(/\r?\n/).filter(Boolean).pop()
      throw new Error(last ?? `The command on ${machineLabel(machine)} failed (exit ${result.code ?? 'killed'}).`)
    }
    return result.stdout
  }

  const build = (): string => {
    if (!deps.build) throw new Error('This build of Cate has no build id, so it cannot install its runtime elsewhere.')
    return deps.build
  }

  const probe = async (machine: Machine): Promise<SshProbe> => parseProbe(await exec(machine, probeScript(build())))

  return {
    async ensureRuntime(machine) {
      const before = await probe(machine)
      if (before.installed) return { ...before, installedNow: false }
      if (!before.target) throw new Error(`Cate has no runtime for ${before.system}. It runs on Linux (glibc) and macOS, x64 or arm64.`)
      if (!before.canInstall) throw new Error(`Installing needs curl and tar on ${machineLabel(machine)}.`)
      await exec(machine, installScript(deps.version), INSTALL_MS)
      const after = await probe(machine)
      if (!after.installed) {
        throw new Error(after.current
          ? `Release ${deps.version} installed as build ${after.current}, not this app's ${build()}. A development build cannot set up another machine.`
          : `The runtime did not install on ${machineLabel(machine)}.`)
      }
      return { ...after, installedNow: true }
    },
    async listDir(machine, path) {
      return parseDirListing(await exec(machine, listDirScript(path)))
    },
    async mkdir(machine, path) {
      return parseMkdir(await exec(machine, mkdirScript(path)))
    },
    wslDistros: deps.wslDistros ?? (() => Promise.resolve([])),
    async cancel(machine) {
      if (!isMachine(machine)) return
      for (const controller of running.get(machineKey(machine)) ?? []) controller.abort()
    },
  }
}

/** The distros `wsl.exe --list --quiet` names (it prints UTF-16). */
export function listWslDistros(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([])
  return new Promise((resolve) => {
    execFile('wsl.exe', ['--list', '--quiet'], { encoding: 'buffer', windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve([])
      const text = stdout.toString('utf16le').replace(/^\uFEFF/, '').replace(/\0/g, '')
      resolve(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
    })
  })
}

/** Thrown by `dialMachine` when this app's build is not installed there. */
export class NotInstalledError extends Error {
  constructor(machine: Machine) {
    super(`The Cate runtime of this app is not installed on ${machineLabel(machine)}.`)
  }
}

/** The command's stdio as a byte pipe, from the bytes after `BRIDGE_READY`. */
function childDuplex(child: ChildProcessWithoutNullStreams, first: Uint8Array): ByteDuplex {
  let listener: ((bytes: Uint8Array) => void) | null = null
  const pending: Uint8Array[] = first.byteLength ? [first] : []
  let reason: string | undefined
  child.stdout.on('data', (chunk: Buffer) => {
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    if (listener) listener(bytes)
    else pending.push(bytes)
  })
  child.stdin.on('error', (err) => { reason ??= err.message })
  return {
    write: (bytes) => { if (child.exitCode === null && !child.stdin.destroyed) child.stdin.write(bytes) },
    onData: (next) => {
      listener = next
      for (const bytes of pending.splice(0)) next(bytes)
    },
    onClose: (next) => { child.once('close', () => next(reason)) },
    close: (why) => {
      reason ??= why
      child.stdin.end()
      child.kill()
    },
  }
}

/** Runs this app's bridge to the runtime of `root` on `machine`: a byte pipe
 *  to the runtime's local socket. Rejects with `NotInstalledError` when the
 *  build is missing there. */
export function dialMachine(machine: Machine, root: string, opts: { build: string; timeoutMs?: number }): Promise<ByteDuplex> {
  if (!isMachine(machine)) return Promise.reject(new Error('invalid machine'))
  const { command, args } = machineCommand(machine, bridgeScript(opts.build, root))
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const ready = Buffer.from(BRIDGE_READY)
    let head = Buffer.alloc(0)
    let stderr = ''
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      reject(err)
    }
    const timer = setTimeout(() => fail(new Error(`${machineLabel(machine)} did not answer in time.`)), opts.timeoutMs ?? BRIDGE_MS)
    const onHead = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk])
      const at = head.indexOf(ready)
      if (at < 0) return
      settled = true
      clearTimeout(timer)
      child.stdout.removeListener('data', onHead)
      const rest = head.subarray(at + ready.length)
      resolve(childDuplex(child, new Uint8Array(rest.buffer, rest.byteOffset, rest.byteLength)))
    }
    child.stdout.on('data', onHead)
    child.stderr.setEncoding('utf-8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096) })
    child.once('error', (err: NodeJS.ErrnoException) => fail(spawnError(machine, err)))
    child.once('close', (code) => {
      if (readMarked(head.toString('utf-8')).get('error')?.[0] === 'not-installed') return fail(new NotInstalledError(machine))
      const runtime = /cate runtime: (.*)/.exec(stderr)?.[1]
      fail(new Error(runtime ?? (code === 255 || machine.kind === 'wsl' ? machineErrorMessage(machine, stderr) : `The runtime bridge on ${machineLabel(machine)} ended (exit ${code ?? 'killed'}).`)))
    })
    child.stdin.on('error', () => { /* reported on close */ })
  })
}
