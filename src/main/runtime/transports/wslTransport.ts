// =============================================================================
// WslTransport — runs the self-contained runtime daemon inside a WSL distro
// via `wsl.exe`. Installs the matching linux tarball (runtime.cjs +
// node_modules incl. node-pty + a bundled Node runtime) into
// ~/.cate/runtime/<ver>/<target>/ so the distro needs nothing preinstalled
// (server-side `git` still needed for VCS).
//
//   1. IN-DISTRO PULL — the distro fetches its own tarball from the GitHub
//      release (curl/wget); WSL shares the host network so this usually works.
//   2. /mnt FALLBACK — otherwise the client-side tarball
//      (runtimeArtifacts.ensureLocalTarball) is copied in through /mnt.
//
// STATUS: implemented but NOT runtime-verified here (needs a Windows host with
// WSL).
// =============================================================================

import { spawn, execFile, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { ensureLocalTarball, isRuntimeDevMode, isRuntimeTarget, type RuntimeTarget } from '../runtimeArtifacts'
import { shellQuote as shq, bootstrapDevShared, isInstalledShared, bootstrapProdShared, buildExtractCommand, type RuntimeChannel, type RuntimeTransport } from './transport'

const execFileP = promisify(execFile)

export interface WslOptions {
  distro: string
  /** Runtime-absolute workspace root inside the distro. */
  root: string
  id: string
  exclusions?: string[]
}

export class WslTransport implements RuntimeTransport {
  readonly kind = 'wsl'
  private child: ChildProcess | null = null
  private installDir = ''
  private target: RuntimeTarget | '' = ''

  constructor(private readonly opts: WslOptions) {}

  private async wsl(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileP('wsl.exe', ['-d', this.opts.distro, '-e', ...args])
    return { stdout, stderr }
  }

  /** Run a /bin/sh script inside the distro; never throws (returns code+output). */
  private async wslSh(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await this.wsl(['sh', '-c', script])
      return { code: 0, stdout, stderr }
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string }
      return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(err) }
    }
  }

  /** Probe arch + resolve the version-specific install dir, caching both.
   *  Shared by isInstalled / bootstrap / launch / uninstall. */
  private async resolveInstallDir(version: string): Promise<string> {
    if (!this.target) {
      const { stdout: machine } = await this.wsl(['uname', '-m'])
      const arch = /(aarch64|arm64)/i.test(machine) ? 'arm64' : /(x86_64|amd64)/i.test(machine) ? 'x64' : null
      if (!arch) throw new Error(`Unsupported WSL arch: "${machine.trim()}"`)
      const target = `linux-${arch}`
      if (!isRuntimeTarget(target)) throw new Error(`No runtime build for target "${target}"`)
      this.target = target
    }
    if (!this.installDir) {
      const { stdout: home } = await this.wsl(['sh', '-c', 'echo $HOME'])
      this.installDir = `${home.trim()}/.cate/runtime/${version}/${this.target}`
    }
    return this.installDir
  }

  /** Reachable + correct-version bundle present? Does NOT install. */
  async isInstalled(version: string): Promise<boolean> {
    const D = shq(await this.resolveInstallDir(version))
    return isInstalledShared(version, D, this.target as RuntimeTarget, (cmd) => this.wslSh(cmd))
  }

  /** Remove the whole runtime install tree inside the distro (all versions). */
  async uninstall(): Promise<void> {
    const { stdout: home } = await this.wsl(['sh', '-c', 'echo $HOME'])
    await this.wslSh(`rm -rf ${shq(`${home.trim()}/.cate/runtime`)}`)
    this.installDir = ''
  }

  async bootstrap(version: string, force?: boolean): Promise<void> {
    const D = shq(await this.resolveInstallDir(version))

    // Reinstall: wipe the install dir (binaries + .ok/.cjs.ok markers) so the
    // provisioned/marker probes below see a clean slate and re-copy.
    if (force) await this.wslSh(`rm -rf ${D}`)

    // DEV: provision the heavy parts once, then hot-swap only runtime.cjs by
    // hash (mirrors sshTransport.bootstrapDev) — no version bump, no /mnt of the
    // full tarball on every iteration, no in-distro pull of a stale release.
    if (isRuntimeDevMode()) {
      await this.bootstrapDev(version, D)
      return
    }

    // PROD: probe the `.ok` marker, then in-distro pull from the release with a
    // /mnt copy fallback when the distro can't fetch (shared with SSH).
    await bootstrapProdShared(version, D, {
      tag: 'wsl',
      target: this.target as RuntimeTarget,
      installDir: this.installDir,
      exec: (cmd) => this.wslSh(cmd),
      pushTarball: (v, marker) => this.copyTarball(v, marker),
      pullFallbackLabel: '[runtime:wsl] in-distro pull unavailable (%s); copying via /mnt',
    })
  }

  /** Dev provisioning (mirrors sshTransport.bootstrapDev): install runtime +
   *  node_modules from the local tarball once via /mnt, then overlay the freshest
   *  local runtime.cjs keyed by its hash in `.cjs.ok`. Never in-distro pulls. */
  private bootstrapDev(version: string, D: string): Promise<void> {
    return bootstrapDevShared(version, D, {
      tag: 'wsl',
      exec: (cmd) => this.wslSh(cmd),
      pushTarball: (v, marker) => this.copyTarball(v, marker),
      pushBundle: async (bundle, hash, quotedDir) => {
        const { stdout: srcMnt } = await this.wsl(['wslpath', bundle])
        const res = await this.wslSh(
          `mkdir -p ${quotedDir} && cp ${shq(srcMnt.trim())} ${quotedDir}/runtime.cjs && ` +
            `printf %s ${shq(hash)} > ${quotedDir}/.cjs.ok && echo CATE_CJS_OK`,
        )
        if (!res.stdout.includes('CATE_CJS_OK')) {
          throw new Error(`WSL dev runtime.cjs push failed: ${res.stderr || res.stdout}`)
        }
      },
    })
  }

  private async copyTarball(version: string, marker: string): Promise<void> {
    if (!this.target) throw new Error('copyTarball called before arch probe')
    const localTar = await ensureLocalTarball(version, this.target)
    const { stdout: srcMnt } = await this.wsl(['wslpath', localTar])
    const D = shq(this.installDir)
    const extract = await this.wslSh(
      `mkdir -p ${D} && cd ${D} && cp ${shq(srcMnt.trim())} pkg.tgz && ` +
        buildExtractCommand(shq(marker), 'CATE_EXTRACT_OK'),
    )
    if (!extract.stdout.includes('CATE_EXTRACT_OK')) {
      throw new Error(`WSL extract failed: ${extract.stderr || extract.stdout}`)
    }
  }

  async launch(): Promise<RuntimeChannel> {
    const nodeBin = `${this.installDir}/runtime/bin/node`
    const args = ['-d', this.opts.distro, '-e', nodeBin, `${this.installDir}/runtime.cjs`, '--root', this.opts.root, '--id', this.opts.id]
    if (this.opts.exclusions?.length) args.push('--exclude', this.opts.exclusions.join(','))
    const child = spawn('wsl.exe', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin?.on('error', () => { /* EPIPE after daemon exit is reported via close */ })
    this.child = child
    return {
      write: (line) => { writeToChildStdin(child, line) },
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

function writeToChildStdin(child: ChildProcess, line: string): void {
  const stdin = child.stdin
  if (!stdin || stdin.destroyed || stdin.writableEnded || child.exitCode !== null || child.signalCode !== null) {
    throw new Error('Runtime stdin is closed')
  }
  stdin.write(line)
}
