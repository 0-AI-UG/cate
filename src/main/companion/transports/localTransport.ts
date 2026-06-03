// =============================================================================
// LocalSubprocessTransport — runs the companion daemon as a child process on
// THIS machine, over real OS stdio pipes. Two modes:
//
//   - Direct (nodePath + bundlePath given): launch an explicit node + bundle, no
//     provisioning. Used by tests and as a building block.
//   - Provisioned (tarballPath + installDir given, or via `forLocalHost`): extract
//     the SAME per-target companion tarball remote hosts use into a local install
//     dir and run its bundled `runtime/bin/node` + companion.cjs — so the local
//     workspace is just another companion host, ABI-matched to its own node-pty.
// =============================================================================

import { spawn, execFile, type ChildProcess } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { mkdir, rm, writeFile } from 'fs/promises'
import { promisify } from 'util'
import os from 'os'
import path from 'path'
import type { CompanionChannel, CompanionTransport } from './transport'
import { COMPANION_VERSION } from '../../../companion/version'
import { hostCompanionTarget, localTarballIfPresent, shippedCompanionTarball, type CompanionTarget } from '../companionArtifacts'

const execFileP = promisify(execFile)

export interface LocalSubprocessOptions {
  root: string
  id: string
  exclusions?: string[]
  env?: NodeJS.ProcessEnv
  /** POSIX-only idle-suspend of backgrounded terminals (the user's setting);
   *  appended as `--idle-suspend` to the daemon launch args when true. */
  idleSuspend?: boolean
  /** Direct mode: explicit node + bundle, no provisioning (tests). */
  nodePath?: string
  bundlePath?: string
  /** Provisioned mode: extract this tarball into installDir, then run its node. */
  tarballPath?: string
  installDir?: string
}

/** node binary inside an extracted tarball. Unified layout: runtime/bin/node on
 *  posix, runtime/bin/node.exe on win32 — only the filename differs, so the
 *  install-dir depth (and every other resolver) stays platform-agnostic. */
function tarballNode(installDir: string): string {
  return process.platform === 'win32'
    ? path.join(installDir, 'runtime', 'bin', 'node.exe')
    : path.join(installDir, 'runtime', 'bin', 'node')
}

/** Where the local host's companion tarball is extracted, keyed by version +
 *  target (mirrors the remote `~/.cate/companion/<ver>/<target>` layout). */
export function localInstallDir(target: CompanionTarget): string {
  return path.join(os.homedir(), '.cate', 'companion', COMPANION_VERSION, target)
}

export class LocalSubprocessTransport implements CompanionTransport {
  readonly kind = 'local'
  private child: ChildProcess | null = null

  constructor(private readonly opts: LocalSubprocessOptions) {}

  /** Build a provisioned local transport from the host-target tarball (dev build
   *  or cache). Returns null on an unsupported platform or when no tarball is
   *  available — callers fall back to the in-process companion. */
  static forLocalHost(opts: {
    root: string
    id?: string
    exclusions?: string[]
    env?: NodeJS.ProcessEnv
    idleSuspend?: boolean
  }): LocalSubprocessTransport | null {
    const target = hostCompanionTarget()
    if (!target) return null
    const tarballPath = localTarballIfPresent(COMPANION_VERSION, target) ?? shippedCompanionTarball()
    if (!tarballPath) return null
    return new LocalSubprocessTransport({
      ...opts,
      id: opts.id ?? 'local',
      tarballPath,
      installDir: localInstallDir(target),
    })
  }

  /** Provisioned mode only: true when the install dir holds this version. */
  async isInstalled(version: string): Promise<boolean> {
    const { installDir, tarballPath } = this.opts
    if (!installDir || !tarballPath) return true // direct mode: nothing to install
    const ok = path.join(installDir, '.ok')
    return (
      existsSync(tarballNode(installDir)) &&
      existsSync(path.join(installDir, 'companion.cjs')) &&
      existsSync(ok) &&
      readFileSync(ok, 'utf-8').trim() === version
    )
  }

  /** Provisioned mode only: extract the tarball into the install dir. */
  async bootstrap(version: string, force?: boolean): Promise<void> {
    const { installDir, tarballPath } = this.opts
    if (!installDir || !tarballPath) return // direct mode: bundle ships with the app
    if (!force && (await this.isInstalled(version))) return
    await rm(installDir, { recursive: true, force: true })
    await mkdir(installDir, { recursive: true })
    await execFileP('tar', ['-xzf', tarballPath, '-C', installDir])
    await writeFile(path.join(installDir, '.ok'), version)
  }

  async launch(): Promise<CompanionChannel> {
    const nodePath = this.opts.nodePath ?? tarballNode(this.opts.installDir!)
    const bundlePath = this.opts.bundlePath ?? path.join(this.opts.installDir!, 'companion.cjs')
    const args = [bundlePath, '--root', this.opts.root, '--id', this.opts.id]
    if (this.opts.exclusions?.length) args.push('--exclude', this.opts.exclusions.join(','))
    if (this.opts.idleSuspend) args.push('--idle-suspend')

    const child = spawn(nodePath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.opts.env ?? process.env,
    })
    this.child = child

    return {
      write: (line) => { child.stdin?.write(line) },
      onData: (cb) => { child.stdout?.on('data', cb) },
      onStderr: (cb) => { child.stderr?.on('data', cb) },
      onClose: (cb) => { child.on('close', (code) => cb({ code })) },
      kill: () => { child.kill() },
    }
  }

  async dispose(): Promise<void> {
    this.child?.kill()
    this.child = null
  }
}
