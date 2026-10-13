// Machines the desktop shell runs commands on (architecture 7.1, 7.5): over
// the system `ssh` (so ~/.ssh/config, keys, the agent and known_hosts apply)
// or `wsl.exe`. `createMachineProvisioner` pipes small scripts to the
// machine's `sh -s` to browse folders, and installs this app's build by
// streaming its runtime tarball to the machine (downloaded here first when
// this device has none for the machine's target), so the machine needs no
// network of its own;
// `dialMachine` runs that build's `runtime.cjs bridge`, which starts the
// workspace's runtime when nothing answers and carries its local socket over
// the command's stdio.

import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ByteDuplex } from '@kernel/rpc/contract'
import {
  BRIDGE_READY,
  machineKey,
  bridgeScript,
  isMachine,
  listDirScript,
  machineCommand,
  machineLabel,
  mkdirScript,
  parseDirListing,
  parseMkdir,
  parseProbe,
  parseSshConfig,
  readMarked,
  probeScript,
  pushInstallScript,
  type Machine,
  type MachineSetup,
  type RuntimeInstallProgress,
  type RuntimeTarget,
  type SshConfigHost,
  type SshProbe,
} from '../contract'
import { downloadRuntimeRelease } from '../node'
import type { SshPrompting } from './askpass'

export interface MachineRunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Runs `script` with `sh -s` on `machine`; with `input` (a file), runs it
 *  with `sh -c` and streams the file to its stdin, telling `onSent` how much
 *  went. `signal` stops it. */
export type MachineRunner = (
  machine: Machine,
  script: string,
  timeoutMs: number,
  signal?: AbortSignal,
  input?: string,
  onSent?: (sent: number, total: number) => void,
) => Promise<MachineRunResult>

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

/** Spawns the machine's command; ssh asks through `prompting` when given,
 *  and what it still asks is withdrawn once it exits (cancelled, timed out). */
function spawnOn(machine: Machine, script: 'stdin' | string, prompting: SshPrompting | undefined): ChildProcessWithoutNullStreams {
  const ask = machine.kind === 'ssh' ? prompting : undefined
  const { command, args } = machineCommand(machine, script, ask ? { controlPath: ask.controlPath } : {})
  const owner = randomUUID()
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(ask ? { env: ask.env(machine, owner) } : {}) })
  if (ask) child.once('close', () => ask.withdraw(owner))
  return child
}

/** The system `ssh` or `wsl.exe`, with the script (or `input`) on stdin. */
export function systemMachineRunner(prompting?: SshPrompting): MachineRunner {
  return (machine, script, timeoutMs, signal, input, onSent) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled.'))
    // The file is checked before ssh starts, so a missing one leaves nothing running.
    let total = 0
    if (input) {
      try { total = fs.statSync(input).size } catch (err) { return reject(err) }
    }
    const child = spawnOn(machine, input ? script : 'stdin', prompting)
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
    const stream = input ? fs.createReadStream(input) : null
    child.once('close', (code) => {
      clearTimeout(timer)
      // Exited before it took all of the file: let go of it.
      stream?.destroy()
      resolve({ code, stdout, stderr })
    })
    child.stdin.on('error', () => { /* exited early; reported on close */ })
    if (!stream) return void child.stdin.end(`${script}\n`)
    if (onSent) {
      // What the pipe took (it holds back the file as ssh sends it).
      let sent = 0
      stream.on('data', (chunk) => { sent += chunk.length; onSent(sent, total) })
    }
    stream.once('error', (err) => {
      clearTimeout(timer)
      child.kill()
      reject(err)
    }).pipe(child.stdin)
  })
}

/** A message for the command's own failure: ssh's (exit 255) or wsl.exe's. */
export function machineErrorMessage(machine: Machine, stderr: string): string {
  const text = stderr.replace(/\0/g, '').trim()
  const name = machineLabel(machine)
  if (machine.kind === 'ssh') {
    if (/Permission denied/i.test(text)) {
      return `${name} refused the login. Check the password or your SSH keys, and that \`ssh ${name}\` works in a terminal.`
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
  /** With `keep`, `cancel` leaves the check and install running while this
   *  caller waits on it (a workspace connecting through the machine). */
  ensureRuntime(machine: Machine, opts?: { keep?: boolean }): Promise<SshProbe & { installedNow: boolean }>
}

export function createMachineProvisioner(deps: {
  /** This app's build; the install the machine needs. */
  build: string | undefined
  version: string
  /** This build's runtime tarball for `target` on this device, or null to
   *  download release `version`'s. Throws when neither can be this build. */
  localTarball?: (target: RuntimeTarget) => string | null
  run?: MachineRunner
  /** Lets ssh ask for passwords and codes; without it, keys and agent only. */
  prompting?: SshPrompting
  fetch?: typeof fetch
  /** The WSL distros (`wsl.exe --list --quiet`); default: none off Windows. */
  wslDistros?: () => Promise<string[]>
  /** The hosts of this device's SSH config; default: none. */
  sshHosts?: () => Promise<SshConfigHost[]>
  /** How far an install on `machine` is; null once it ended. */
  onProgress?: (machine: Machine, progress: RuntimeInstallProgress | null) => void
}): MachineProvisioner {
  const run = deps.run ?? systemMachineRunner(deps.prompting)
  /** What runs per machine, for `cancel`. */
  const running = new Map<string, Set<AbortController>>()
  /** Callers per machine that keep its check and install running. */
  const kept = new Map<string, number>()
  /** The check and install running per machine. */
  const installing = new Map<string, Set<AbortController>>()

  /** Runs `work` with a signal that `cancel(machine)` aborts. */
  const tracked = async <T>(machine: Machine, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (!isMachine(machine)) throw new Error('invalid machine')
    const key = machineKey(machine)
    const controller = new AbortController()
    if (ensuring.has(key)) installing.set(key, (installing.get(key) ?? new Set()).add(controller))
    const set = running.get(key) ?? new Set()
    running.set(key, set.add(controller))
    return work(controller.signal).finally(() => {
      installing.get(key)?.delete(controller)
      set.delete(controller)
      if (set.size === 0 && running.get(key) === set) running.delete(key)
    })
  }

  const exec = async (machine: Machine, script: string, timeoutMs = SHORT_MS, input?: string, onSent?: (sent: number, total: number) => void): Promise<string> => {
    const result = await tracked(machine, (signal) => run(machine, script, timeoutMs, signal, input, onSent))
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

  /** Streams `file` to the machine's install: uploading, then unpacking
   *  once all of it went. */
  const send = async (machine: Machine, file: string): Promise<void> => {
    const report = deps.onProgress
    await exec(machine, pushInstallScript(build()), INSTALL_MS, file, report && ((sent, total) => {
      report(machine, sent < total ? { phase: 'upload', received: sent, total } : { phase: 'install' })
    }))
  }

  /** Streams this build's tarball for `target` to the machine's install. */
  const push = async (machine: Machine, target: RuntimeTarget): Promise<void> => {
    const local = deps.localTarball?.(target)
    if (local) return send(machine, local)
    // A directory of its own (0700): in the shared temp directory, another
    // user could plant or swap the file between the checksum and the upload.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cate-runtime-'))
    const download = path.join(dir, `${target}.tgz`)
    try {
      await tracked(machine, (signal) => downloadRuntimeRelease({
        version: deps.version,
        dest: download,
        platform: target.split('-')[0] as NodeJS.Platform,
        arch: target.split('-')[1],
        fetch: (url) => (deps.fetch ?? fetch)(url, { signal }),
        ...(deps.onProgress ? { onProgress: (received: number, total: number | null) => deps.onProgress?.(machine, { phase: 'download', received, total }) } : {}),
      }).catch((err: unknown) => { throw signal.aborted ? new Error('Cancelled.') : err }))
      await send(machine, download)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  const ensure = async (machine: Machine): Promise<SshProbe & { installedNow: boolean }> => {
    const before = await probe(machine)
    if (before.installed) return { ...before, installedNow: false }
    if (!before.target) throw new Error(`Cate has no runtime for ${before.system}. It runs on Linux (glibc) and macOS, x64 or arm64.`)
    if (!before.canInstall) throw new Error(`Installing needs tar on ${machineLabel(machine)}.`)
    try {
      await push(machine, before.target)
    } finally {
      deps.onProgress?.(machine, null)
    }
    const after = await probe(machine)
    if (!after.installed) throw new Error(`The runtime did not install on ${machineLabel(machine)}.`)
    return { ...after, installedNow: true }
  }
  /** One check (and install) per machine at a time: workspaces of one
   *  machine reconnecting together share it instead of racing two installs. */
  const ensuring = new Map<string, Promise<SshProbe & { installedNow: boolean }>>()

  return {
    ensureRuntime(machine, opts = {}) {
      if (!isMachine(machine)) return Promise.reject(new Error('invalid machine'))
      const key = machineKey(machine)
      let next = ensuring.get(key)
      if (!next) {
        // Registered before it starts, so what it runs counts as the install.
        next = Promise.resolve().then(() => ensure(machine)).finally(() => ensuring.delete(key))
        ensuring.set(key, next)
      }
      if (!opts.keep) return next
      kept.set(key, (kept.get(key) ?? 0) + 1)
      return next.finally(() => {
        const left = (kept.get(key) ?? 1) - 1
        if (left > 0) kept.set(key, left)
        else kept.delete(key)
      })
    },
    async listDir(machine, path) {
      return parseDirListing(await exec(machine, listDirScript(path)))
    },
    async mkdir(machine, path) {
      return parseMkdir(await exec(machine, mkdirScript(path)))
    },
    wslDistros: deps.wslDistros ?? (() => Promise.resolve([])),
    sshHosts: deps.sshHosts ?? (() => Promise.resolve([])),
    async cancel(machine) {
      if (!isMachine(machine)) return
      const key = machineKey(machine)
      // A connecting workspace still waits on the install: it goes on.
      const keep = kept.has(key) ? installing.get(key) : undefined
      for (const controller of running.get(key) ?? []) if (!keep?.has(controller)) controller.abort()
    },
  }
}

/** The files an `Include` names: `~` is the home dir, a relative path is
 *  under ~/.ssh, and `*` / `?` match within the last segment. */
async function includedFiles(pattern: string, home: string): Promise<string[]> {
  const abs = pattern.startsWith('~') ? path.join(home, pattern.slice(1)) : path.isAbsolute(pattern) ? pattern : path.join(home, '.ssh', pattern)
  const name = path.basename(abs)
  if (!/[*?]/.test(name)) return [abs]
  const re = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  const entries = await readdir(path.dirname(abs)).catch(() => [] as string[])
  return entries.filter((entry) => re.test(entry)).sort().map((entry) => path.join(path.dirname(abs), entry))
}

/** The concrete hosts of `~/.ssh/config` and the files it includes: a
 *  file's own hosts, then its includes'; a host listed twice keeps the first.
 *  Only the shown details follow this order: connecting passes the alias and
 *  ssh resolves it. Unreadable files are skipped. */
export async function listSshHosts(home: string = os.homedir()): Promise<SshConfigHost[]> {
  const hosts = new Map<string, SshConfigHost>()
  const seen = new Set<string>()
  const read = async (file: string, depth: number): Promise<void> => {
    if (depth > 8 || seen.has(file)) return
    seen.add(file)
    const text = await readFile(file, 'utf-8').catch(() => null)
    if (text === null) return
    const parsed = parseSshConfig(text)
    for (const host of parsed.hosts) if (!hosts.has(host.alias)) hosts.set(host.alias, host)
    for (const pattern of parsed.includes) {
      for (const included of await includedFiles(pattern, home)) await read(included, depth + 1)
    }
  }
  await read(path.join(home, '.ssh', 'config'), 0)
  return [...hosts.values()]
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
export function dialMachine(machine: Machine, root: string, opts: { build: string; timeoutMs?: number; prompting?: SshPrompting }): Promise<ByteDuplex> {
  if (!isMachine(machine)) return Promise.reject(new Error('invalid machine'))
  const script = bridgeScript(opts.build, root)
  return new Promise((resolve, reject) => {
    const child = spawnOn(machine, script, opts.prompting)
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
