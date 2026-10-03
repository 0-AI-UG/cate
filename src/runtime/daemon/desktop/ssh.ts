// Setting up a runtime on another machine over SSH (architecture 7.1), for
// the desktop shell. It runs the system `ssh` (so ~/.ssh/config, keys, the
// agent and known_hosts apply) non-interactively and pipes a script to the
// machine's `sh -s`. Two steps: `ensureRuntime` installs this app's build
// only when the machine does not have it, and `serve` starts exactly that
// build and returns the pairing link. SSH carries nothing after that.

import { spawn } from 'node:child_process'
import {
  installScript,
  isSshTarget,
  listDirScript,
  mkdirScript,
  parseDirListing,
  parseMkdir,
  parseProbe,
  parseServeOutput,
  probeScript,
  serveScript,
  sshArgs,
  type SshProbe,
  type SshSetup,
  type SshTarget,
} from '../contract'

export interface SshRunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Runs `script` with `sh -s` on `target`. */
export type SshRunner = (target: SshTarget, script: string, timeoutMs: number) => Promise<SshRunResult>

const SHORT_MS = 45_000
const INSTALL_MS = 10 * 60_000

/** The system `ssh` (or `bin`), with the script on stdin. */
export function systemSshRunner(bin = 'ssh'): SshRunner {
  return (target, script, timeoutMs) => new Promise((resolve, reject) => {
    const child = spawn(bin, sshArgs(target), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${target.destination} did not answer in time.`))
    }, timeoutMs)
    child.stdout.setEncoding('utf-8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf-8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(new Error(err.code === 'ENOENT' ? 'No `ssh` command was found. Install OpenSSH and try again.' : err.message))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.on('error', () => { /* ssh exited early; reported on close */ })
    child.stdin.end(`${script}\n`)
  })
}

/** A message for ssh's own failure (exit 255). */
export function sshErrorMessage(target: SshTarget, stderr: string): string {
  const text = stderr.trim()
  if (/Permission denied/i.test(text)) {
    return `${target.destination} refused the login. Cate signs in with your SSH keys or agent, not a password: check that \`ssh ${target.destination}\` works in a terminal without asking for one.`
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(text)) {
    return `The host key of ${target.destination} does not match the one in known_hosts. Check the machine, then fix known_hosts.`
  }
  if (/Could not resolve hostname/i.test(text)) return `${target.destination} could not be found.`
  if (/Connection refused|timed out|No route to host/i.test(text)) return `${target.destination} could not be reached over SSH.`
  const last = text.split(/\r?\n/).filter(Boolean).pop()
  return last ? `SSH failed: ${last}` : `SSH to ${target.destination} failed.`
}

export interface SshRuntimeStatus extends SshProbe {
  /** This call installed the runtime. */
  installedNow: boolean
}

export interface SshProvisioner extends SshSetup {
  ensureRuntime(target: SshTarget): Promise<SshRuntimeStatus>
}

export function createSshProvisioner(deps: {
  /** This app's build; the install the machine needs. */
  build: string | undefined
  version: string
  run?: SshRunner
}): SshProvisioner {
  const run = deps.run ?? systemSshRunner()

  const exec = async (target: SshTarget, script: string, timeoutMs = SHORT_MS): Promise<string> => {
    if (!isSshTarget(target)) throw new Error('invalid SSH target')
    const result = await run(target, script, timeoutMs)
    if (result.code === 255) throw new Error(sshErrorMessage(target, result.stderr))
    if (result.code !== 0) {
      const last = result.stderr.trim().split(/\r?\n/).filter(Boolean).pop()
      throw new Error(last ?? `The command on ${target.destination} failed (exit ${result.code}).`)
    }
    return result.stdout
  }

  const build = (): string => {
    if (!deps.build) throw new Error('This build of Cate has no build id, so it cannot install its runtime elsewhere.')
    return deps.build
  }

  const probe = async (target: SshTarget): Promise<SshProbe> => parseProbe(await exec(target, probeScript(build())))

  return {
    async ensureRuntime(target) {
      const before = await probe(target)
      if (before.installed) return { ...before, installedNow: false }
      if (!before.target) throw new Error(`Cate has no runtime for ${before.system}. It runs on Linux and macOS, x64 or arm64.`)
      if (!before.canInstall) throw new Error(`Installing needs curl and tar on ${target.destination}.`)
      await exec(target, installScript(deps.version), INSTALL_MS)
      const after = await probe(target)
      if (!after.installed) {
        throw new Error(after.current
          ? `Release ${deps.version} installed as build ${after.current}, not this app's ${build()}. A development build cannot set up another machine.`
          : `The runtime did not install on ${target.destination}.`)
      }
      return { ...after, installedNow: true }
    },
    async listDir(target, path) {
      return parseDirListing(await exec(target, listDirScript(path)))
    },
    async mkdir(target, path) {
      return parseMkdir(await exec(target, mkdirScript(path)))
    },
    async serve(target, path) {
      return parseServeOutput(await exec(target, serveScript(build(), path)))
    },
  }
}
