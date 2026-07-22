// =============================================================================
// LocalSubprocessTransport — runs the runtime daemon as a child process on
// THIS machine, over real OS stdio pipes. Two modes:
//
//   - Direct (nodePath + bundlePath given): launch an explicit node + bundle, no
//     provisioning. Used by tests and as a building block.
//   - Provisioned (tarballPath + installDir given, or via `forLocalHost`): extract
//     the SAME per-target runtime tarball remote hosts use into a local install
//     dir and run its bundled `runtime/bin/node` + runtime.cjs — so the local
//     workspace is just another runtime host, ABI-matched to its own node-pty.
// =============================================================================

import { spawn, execFile, type ChildProcess } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { promisify } from 'util'
import os from 'os'
import path from 'path'
import type { RuntimeChannel, RuntimeTransport } from './transport'
import { RUNTIME_VERSION } from '../../../runtime/version'
import { LOGIN_ENV_MARKER } from '../../../runtime/loginEnv'
import { hostRuntimeTarget, localTarballIfPresent, shippedRuntimeTarball, tarballHash, type RuntimeTarget } from '../runtimeArtifacts'

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
  /** Provisioned mode: extract this tarball into a content-keyed dir under
   *  `installRoot` (see localInstallRoot / installDir), then run its node. */
  tarballPath?: string
  installRoot?: string
  /** The tarball's target — the readable half of the install dir's name. */
  target?: RuntimeTarget
}

/** node binary inside an extracted tarball. Unified layout: runtime/bin/node on
 *  posix, runtime/bin/node.exe on win32 — only the filename differs, so the
 *  install-dir depth (and every other resolver) stays platform-agnostic. */
function tarballNode(installDir: string): string {
  return process.platform === 'win32'
    ? path.join(installDir, 'runtime', 'bin', 'node.exe')
    : path.join(installDir, 'runtime', 'bin', 'node')
}

/** Where this version's local installs live: `~/.cate/runtime/<ver>` (mirrors
 *  the remote layout one level up). The install dirs INSIDE it are content-keyed
 *  — see `installDir`. */
export function localInstallRoot(): string {
  return path.join(os.homedir(), '.cate', 'runtime', RUNTIME_VERSION)
}

/** Best-effort cleanup of a staging/retired tree. A retired tree can still be
 *  open in a running daemon — on POSIX unlinking it is fine, on Windows it can
 *  fail with EBUSY. Either way the leftover is inert and the NEXT bootstrap
 *  clears it, so a failure here must not fail provisioning. */
async function discard(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch { /* still in use (win32) — harmless, retried on the next bootstrap */ }
}

export class LocalSubprocessTransport implements RuntimeTransport {
  readonly kind = 'local'
  private child: ChildProcess | null = null
  private tarballHashPromise: Promise<string> | null = null

  constructor(private readonly opts: LocalSubprocessOptions) {}

  /** Build a provisioned local transport from the host-target tarball (dev build
   *  or cache). Returns null on an unsupported platform or when no tarball is
   *  available — ensureLocalRuntime then marks LOCAL unreachable (there is no
   *  in-process fallback). */
  static forLocalHost(opts: {
    root: string
    id?: string
    exclusions?: string[]
    env?: NodeJS.ProcessEnv
    idleSuspend?: boolean
  }): LocalSubprocessTransport | null {
    const target = hostRuntimeTarget()
    if (!target) return null
    const tarballPath = localTarballIfPresent(RUNTIME_VERSION, target) ?? shippedRuntimeTarball()
    if (!tarballPath) return null
    return new LocalSubprocessTransport({
      ...opts,
      id: opts.id ?? 'local',
      tarballPath,
      installRoot: localInstallRoot(),
      target,
    })
  }

  /** Short content hash of our tarball, computed once. */
  private async hash(): Promise<string> {
    this.tarballHashPromise ??= tarballHash(this.opts.tarballPath!)
    return this.tarballHashPromise
  }

  /**
   * Where this transport's tarball installs to: `<installRoot>/<target>-<hash>`.
   * Null in direct mode.
   *
   * CONTENT-KEYED on purpose. Keying by version alone put a packaged Cate and a
   * dev build — same RUNTIME_VERSION, different daemon bytes — in one directory,
   * where each read the other's `.ok` as stale and `rm -rf`d a tree the other
   * app's daemon was running from. Every agent hook bridge wrapper embeds
   * `<installDir>/runtime/bin/node`, so hooks fired during the re-extract died
   * with "no such file or directory". Distinct builds now install side by side
   * and nothing ever deletes a live install.
   */
  async installDir(): Promise<string | null> {
    const { installRoot, tarballPath, target } = this.opts
    if (!installRoot || !tarballPath || !target) return null
    return path.join(installRoot, `${target}-${await this.hash()}`)
  }

  /** Freshness marker stored in `.ok`: version + the tarball's content hash.
   *  Now that the dir name carries the hash this is a COMPLETION marker (the
   *  last thing written before the swap) plus a self-describing breadcrumb.
   *  Mirrors SshTransport's `version:hash` marker. */
  private async marker(version: string): Promise<string> {
    return `${version}:${await this.hash()}`
  }

  /** Provisioned mode only: true when the install dir holds THIS tarball's bytes. */
  async isInstalled(version: string): Promise<boolean> {
    const installDir = await this.installDir()
    if (!installDir) return true // direct mode: nothing to install
    const ok = path.join(installDir, '.ok')
    if (
      !existsSync(tarballNode(installDir)) ||
      !existsSync(path.join(installDir, 'runtime.cjs')) ||
      !existsSync(ok)
    ) {
      return false
    }
    return readFileSync(ok, 'utf-8').trim() === (await this.marker(version))
  }

  /**
   * Provisioned mode only: extract the tarball into the install dir.
   *
   * Extraction goes to a staging sibling and is swapped in with rename(2), so
   * the install dir is either the old complete tree or the new one — never a
   * half-extracted one. A daemon already running out of the old tree keeps its
   * inodes across the swap, and anything resolving the path (agent hook
   * bridges) finds a complete install at every instant. A failed extract leaves
   * the previous install untouched.
   */
  async bootstrap(version: string, force?: boolean): Promise<void> {
    const { tarballPath } = this.opts
    const installDir = await this.installDir()
    if (!installDir || !tarballPath) return // direct mode: bundle ships with the app
    if (!force && (await this.isInstalled(version))) return

    const staging = `${installDir}.staging-${process.pid}`
    const retired = `${installDir}.retired-${process.pid}`
    await mkdir(path.dirname(installDir), { recursive: true })
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    try {
      await execFileP('tar', ['-xzf', tarballPath, '-C', staging])
      await writeFile(path.join(staging, '.ok'), await this.marker(version))
      // Two renames, not one: POSIX has no atomic directory swap. The gap where
      // installDir is absent is a single syscall wide (vs. the minutes a full
      // re-extract took), and only opens when a tree is already there — the
      // common fresh-hash path is one rename with no gap at all.
      if (existsSync(installDir)) await rename(installDir, retired)
      await rename(staging, installDir)
    } finally {
      await discard(staging)
      await discard(retired)
    }
  }

  async launch(): Promise<RuntimeChannel> {
    const installDir = await this.installDir()
    const nodePath = this.opts.nodePath ?? tarballNode(installDir!)
    const bundlePath = this.opts.bundlePath ?? path.join(installDir!, 'runtime.cjs')
    const args = [bundlePath, '--root', this.opts.root, '--id', this.opts.id]
    if (this.opts.exclusions?.length) args.push('--exclude', this.opts.exclusions.join(','))
    if (this.opts.idleSuspend) args.push('--idle-suspend')

    const child = spawn(nodePath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // The env passed here is already the login-shell env (getShellEnv());
      // the marker tells the daemon to skip its own login-env capture.
      env: { ...(this.opts.env ?? process.env), [LOGIN_ENV_MARKER]: '1' },
    })
    child.stdin?.on('error', () => { /* EPIPE after daemon exit is reported via close */ })
    this.child = child

    return {
      write: (line) => { writeToChildStdin(child, line) },
      onData: (cb) => { child.stdout?.on('data', cb) },
      onStderr: (cb) => { child.stderr?.on('data', cb) },
      onClose: (cb) => { child.on('close', (code) => cb({ code })) },
      // Graceful, cross-platform: close stdin so the daemon's `stdin.on('close')`
      // handler reaps its pty groups + exits; only hard-kill if it lingers. On
      // POSIX child.kill() (SIGTERM) already runs that handler; on Windows
      // child.kill() terminates hard and would orphan pty grandchildren, so the
      // stdin-close path is what saves us there.
      kill: () => { void gracefulStop(child) },
    }
  }

  async dispose(): Promise<void> {
    const child = this.child
    this.child = null
    if (child) await gracefulStop(child)
  }
}

function writeToChildStdin(child: ChildProcess, line: string): void {
  const stdin = child.stdin
  if (!stdin || stdin.destroyed || stdin.writableEnded || child.exitCode !== null || child.signalCode !== null) {
    throw new Error('Runtime stdin is closed')
  }
  stdin.write(line)
}

/**
 * Ask the runtime daemon to shut down cleanly, then force-kill if it lingers.
 * Closing stdin triggers the daemon's `process.stdin.on('close')` handler
 * (src/runtime/index.ts), which reaps every live pty's process group via
 * killAllGroups before exiting — so dev-server grandchildren don't orphan. This
 * works on Windows too, where a bare child.kill() terminates the process hard
 * and bypasses that handler. Resolves as soon as the child exits, or after the
 * grace window when we send a hard kill as a fallback.
 */
function gracefulStop(child: ChildProcess, graceMs = 1500): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    child.once('close', done)
    // Closing stdin lets the daemon reap its pty groups + exit gracefully.
    try { child.stdin?.end() } catch { /* already closed */ }
    const timer = setTimeout(() => {
      // Force-kill the laggard. SIGKILL on POSIX can't be trapped/ignored; on
      // Windows the signal arg is ignored and child.kill() terminates hard.
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      done()
    }, graceMs)
    if (timer.unref) timer.unref()
  })
}
