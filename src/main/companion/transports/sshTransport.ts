// =============================================================================
// SshTransport — runs the companion daemon on a remote Linux/macOS host over
// SSH. The daemon is SELF-CONTAINED per target (companion.cjs + node_modules
// incl. the matching node-pty prebuild + a bundled Node runtime), so the host
// needs nothing preinstalled (server-side `git` is still needed for VCS).
//
// On connect the transport installs the daemon into ~/.cate/companion/<ver>/<target>:
//   1. REMOTE PULL — the host downloads its own tarball straight from the
//      GitHub release (curl/wget). Bytes never transit the laptop; this is the
//      fast path and works whenever the host has internet.
//   2. SFTP FALLBACK — if the host can't fetch (no internet / no curl+wget, or
//      the release doesn't have this target yet, e.g. a dev build), the client
//      downloads the tarball (companionArtifacts.ensureLocalTarball) and pushes
//      it over SFTP.
// Either way the install is cached by version+target on the host (.ok marker),
// so reconnects are instant.
//
// STATUS: implemented but NOT runtime-verified in this sandbox (needs a real
// server). Requires the `ssh2` package (installed); the import is dynamic to
// keep the build resilient.
// =============================================================================

import log from '../../logger'
import { ensureLocalTarball, ensureLocalPiTarball, localTarballIfPresent, localCompanionBundlePath, isCompanionDevMode, tarballHash, releaseUrl, isCompanionTarget, type CompanionTarget } from '../companionArtifacts'
import type { CompanionChannel, CompanionTransport } from './transport'

export interface SshOptions {
  host: string
  user: string
  port?: number
  /** Companion-absolute workspace root on the server. */
  root: string
  id: string
  privateKey?: Buffer | string
  passphrase?: string
  agentSock?: string
  exclusions?: string[]
}

async function loadSsh2(): Promise<unknown> {
  const spec = 'ssh2'
  return import(spec)
}

export class SshTransport implements CompanionTransport {
  readonly kind = 'server'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private conn: any = null
  private target: CompanionTarget | '' = ''
  private installDir = ''

  constructor(private readonly opts: SshOptions) {}

  private async ensureConnected(): Promise<void> {
    if (this.conn) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ssh2 = (await loadSsh2()) as any
    const conn = new ssh2.Client()
    await new Promise<void>((resolve, reject) => {
      conn.on('ready', resolve)
      conn.on('error', reject)
      conn.connect({
        host: this.opts.host,
        port: this.opts.port ?? 22,
        username: this.opts.user,
        privateKey: this.opts.privateKey,
        passphrase: this.opts.passphrase,
        agent: this.opts.agentSock,
        keepaliveInterval: 15000,
      })
    })
    this.conn = conn
  }

  private exec(cmd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.conn.exec(cmd, (err: unknown, stream: any) => {
        if (err) return reject(err)
        let stdout = '', stderr = ''
        stream.on('data', (d: Buffer) => { stdout += d.toString() })
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
        stream.on('close', (code: number) => resolve({ code, stdout, stderr }))
      })
    })
  }

  /** Probe the host's platform/arch (and libc) and map to a companion target. */
  private async probeTarget(): Promise<CompanionTarget> {
    const { stdout } = await this.exec('uname -s; uname -m; (ldd --version 2>&1 | head -n1) || true')
    const [sys = '', machine = '', libc = ''] = stdout.split('\n').map((s) => s.trim())
    const platform = /linux/i.test(sys) ? 'linux' : /darwin/i.test(sys) ? 'darwin' : null
    const arch = /(aarch64|arm64)/i.test(machine) ? 'arm64' : /(x86_64|amd64)/i.test(machine) ? 'x64' : null
    if (!platform || !arch) throw new Error(`Unsupported server platform: "${sys} ${machine}"`)
    if (platform === 'linux' && /musl/i.test(libc)) {
      throw new Error(
        `This server uses musl libc (e.g. Alpine); the companion ships glibc node-pty prebuilds only. ` +
          'Use a glibc-based host (Debian/Ubuntu/RHEL/…) or install glibc compatibility.',
      )
    }
    const target = `${platform}-${arch}`
    if (!isCompanionTarget(target)) throw new Error(`No companion build for target "${target}"`)
    return target
  }

  /** Connect + probe the host's arch and resolve the version-specific install
   *  dir, caching both. Shared by isInstalled / bootstrap / launch / uninstall
   *  so any of them can be the first call in a connect lifecycle. */
  private async resolveInstallDir(version: string): Promise<string> {
    await this.ensureConnected()
    if (!this.target) this.target = await this.probeTarget()
    if (!this.installDir) {
      const { stdout: home } = await this.exec('echo $HOME')
      this.installDir = `${home.trim()}/.cate/companion/${version}/${this.target}`
    }
    return this.installDir
  }

  /** Reachable + correct-version bundle present? Does NOT install. A connect
   *  failure rejects (→ unreachable); `false` means reachable-but-absent (→
   *  missing). In dev the freshness key is the provisioned core (the cjs hot-swap
   *  is part of install, not the probe). */
  async isInstalled(version: string): Promise<boolean> {
    const installDir = await this.resolveInstallDir(version)
    const D = shq(installDir)
    if (isCompanionDevMode()) {
      return (await this.exec(
        `test -x ${D}/runtime/bin/node && test -f ${D}/companion.cjs && test -d ${D}/node_modules && echo CATE_PROVISIONED`,
      )).stdout.includes('CATE_PROVISIONED')
    }
    const localTar = localTarballIfPresent(version, this.target as CompanionTarget)
    const marker = localTar ? `${version}:${await tarballHash(localTar)}` : version
    const ok = (await this.exec(
      `test -x ${D}/runtime/bin/node && test -f ${D}/companion.cjs && cat ${D}/.ok 2>/dev/null`,
    )).stdout.trim()
    return ok === marker || (!localTar && ok.startsWith(version))
  }

  /** Remove the whole companion install tree on the host (all versions). */
  async uninstall(): Promise<void> {
    await this.ensureConnected()
    const { stdout: home } = await this.exec('echo $HOME')
    await this.exec(`rm -rf ${shq(`${home.trim()}/.cate/companion`)}`)
    this.installDir = '' // force a fresh resolve on the next probe/install
  }

  async bootstrap(version: string, force?: boolean): Promise<void> {
    const D = shq(await this.resolveInstallDir(version))

    // Reinstall: drop the whole install dir (binaries + .ok/.cjs.ok markers) so
    // every "already provisioned?" probe below sees a clean slate and re-pulls.
    if (force) await this.exec(`rm -rf ${D}`)

    // DEV: never remote-pull (it would fetch a stale release tarball). Provision
    // the heavy parts once from the local tarball, then hot-swap only the 262KB
    // companion.cjs whenever its hash changes — so `npm run build:companion` +
    // reconnect updates the host with no version bump and no 35MB rebuild.
    if (isCompanionDevMode()) {
      await this.bootstrapDev(version, D)
      return
    }

    // Marker stored in `.ok`. When a local tarball is present (dev build / cache)
    // it includes its content hash, so a changed daemon at the same version
    // re-installs automatically; otherwise (production pull) it's just the version.
    const localTar = localTarballIfPresent(version, this.target as CompanionTarget)
    const marker = localTar ? `${version}:${await tarballHash(localTar)}` : version

    // Already installed and current?
    const installed = await this.exec(
      `test -x ${D}/runtime/bin/node && test -f ${D}/companion.cjs && cat ${D}/.ok 2>/dev/null`,
    )
    const ok = installed.stdout.trim()
    if (ok === marker || (!localTar && ok.startsWith(version))) return

    // 1. Remote pull — let the host fetch its own tarball from the release.
    const url = releaseUrl(version, this.target as CompanionTarget)
    const pull = await this.exec(this.remotePullCmd(this.installDir, url, version))
    if (pull.stdout.includes('CATE_PULL_OK')) {
      log.info('[companion:ssh] %s pulled tarball from release', this.target)
      return
    }
    log.info('[companion:ssh] remote pull unavailable (%s); falling back to SFTP push', pull.stderr.trim() || `code ${pull.code}`)

    // 2. SFTP fallback — client downloads the tarball and pushes it.
    await this.pushTarball(version, marker)
  }

  /**
   * Dev provisioning. Installs the heavy parts (runtime + node_modules + node-pty)
   * from the local tarball once, then overlays the freshest local companion.cjs,
   * keyed by its content hash in `.cjs.ok`. Subsequent connects with an unchanged
   * bundle are a single hash check; a changed bundle is a 262KB SFTP push. Never
   * remote-pulls. The host runs whatever `build:companion` last produced.
   */
  private async bootstrapDev(version: string, D: string): Promise<void> {
    const provisioned = (await this.exec(
      `test -x ${D}/runtime/bin/node && test -f ${D}/companion.cjs && test -d ${D}/node_modules && echo CATE_PROVISIONED`,
    )).stdout.includes('CATE_PROVISIONED')

    // First connect on this host/version: lay down runtime + node_modules from the
    // local tarball (marker is just the version; the cjs overlay below is the real
    // freshness key in dev). No remote-pull.
    if (!provisioned) await this.pushTarball(version, version)

    const bundle = localCompanionBundlePath()
    if (!bundle) {
      if (!provisioned) return // just installed from the tarball; nothing newer to push
      log.warn('[companion:ssh] dev mode but dist-companion/companion.cjs missing; run `npm run build:companion`')
      return
    }

    const h = await tarballHash(bundle)
    const ok = (await this.exec(`cat ${D}/.cjs.ok 2>/dev/null`)).stdout.trim()
    if (provisioned && ok === h) return // host already runs this exact bundle

    await this.exec(`mkdir -p ${D}`)
    await this.sftpPut(bundle, `${this.installDir}/companion.cjs`)
    await this.exec(`printf %s ${shq(h)} > ${D}/.cjs.ok`)
    log.info('[companion:ssh] dev fast-push companion.cjs (%s)', h)
  }

  /** Compound sh command: download (curl|wget) → extract → verify → mark. */
  private remotePullCmd(installDir: string, url: string, version: string): string {
    const D = shq(installDir)
    const U = shq(url)
    const V = shq(version)
    return (
      `mkdir -p ${D} && cd ${D} && rm -f pkg.tgz && ` +
      `if command -v curl >/dev/null 2>&1; then curl -fSL ${U} -o pkg.tgz; ` +
      `elif command -v wget >/dev/null 2>&1; then wget -qO pkg.tgz ${U}; ` +
      `else echo CATE_NO_FETCHER >&2; exit 3; fi && ` +
      `tar -xzf pkg.tgz && rm -f pkg.tgz && ` +
      `test -x runtime/bin/node && test -f companion.cjs && ` +
      `printf %s ${V} > .ok && echo CATE_PULL_OK`
    )
  }

  private async pushTarball(version: string, marker: string): Promise<void> {
    if (!this.target) throw new Error('pushTarball called before probeTarget')
    const localTar = await ensureLocalTarball(version, this.target)
    const D = shq(this.installDir)
    const remoteTar = `${this.installDir}/pkg.tgz`
    await this.exec(`mkdir -p ${D}`)
    await this.sftpPut(localTar, remoteTar)
    const extract = await this.exec(
      `cd ${D} && tar -xzf pkg.tgz && rm -f pkg.tgz && ` +
        `test -x runtime/bin/node && test -f companion.cjs && ` +
        `printf %s ${shq(marker)} > .ok && echo CATE_EXTRACT_OK`,
    )
    if (!extract.stdout.includes('CATE_EXTRACT_OK')) {
      throw new Error(`remote extract failed: ${extract.stderr || extract.stdout}`)
    }
  }

  /**
   * Air-gapped pi fallback: download the pi tarball client-side and SFTP it to
   * ~/.cate/pi/<piVersion>/pkg.tgz so the daemon's re-invoked ensurePiOnHost
   * extracts it instead of downloading. Idempotent — no-op if pi is installed.
   */
  async pushPi(appVersion: string, piVersion: string): Promise<void> {
    await this.ensureConnected()
    const { stdout: home } = await this.exec('echo $HOME')
    const piDir = `${home.trim()}/.cate/pi/${piVersion}`
    const D = shq(piDir)

    // Already installed on the host? Then there's nothing to push.
    const installed = await this.exec(`test -f ${D}/dist/cli.js && echo CATE_PI_OK`)
    if (installed.stdout.includes('CATE_PI_OK')) return

    const localTar = await ensureLocalPiTarball(appVersion, piVersion)
    await this.exec(`mkdir -p ${D}`)
    // Push to pkg.tgz — the exact path ensurePi.piPushedTarballPath() expects.
    await this.sftpPut(localTar, `${piDir}/pkg.tgz`)
    log.info('[companion:ssh] pushed pi tarball to %s (air-gapped fallback)', piDir)
    // Extraction happens daemon-side: agent.ensurePi() is retried after this,
    // and ensurePi.doInstall extracts the pushed pkg.tgz.
  }

  private sftpPut(localPath: string, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.conn.sftp((err: unknown, sftp: any) => {
        if (err) return reject(err)
        sftp.fastPut(localPath, remotePath, (e: unknown) => (e ? reject(e) : resolve()))
      })
    })
  }

  async launch(): Promise<CompanionChannel> {
    await this.ensureConnected()
    const nodeBin = `${this.installDir}/runtime/bin/node`
    const args = `--root ${shq(this.opts.root)} --id ${shq(this.opts.id)}` +
      (this.opts.exclusions?.length ? ` --exclude ${shq(this.opts.exclusions.join(','))}` : '')
    const cmd = `${shq(nodeBin)} ${shq(`${this.installDir}/companion.cjs`)} ${args}`

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream: any = await new Promise((resolve, reject) => {
      // No PTY on the control channel — clean stdout for JSON framing.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.conn.exec(cmd, { pty: false }, (err: unknown, s: any) => (err ? reject(err) : resolve(s)))
    })

    return {
      write: (line) => { stream.write(line) },
      onData: (cb) => { stream.on('data', cb) },
      onStderr: (cb) => { stream.stderr?.on('data', cb) },
      onClose: (cb) => { stream.on('close', (code: number) => cb({ code })) },
      kill: () => { try { stream.close?.() } catch { /* ignore */ } },
    }
  }

  async dispose(): Promise<void> {
    try { this.conn?.end() } catch { /* ignore */ }
    this.conn = null
  }
}

/** Minimal shell-quote for argv interpolated into the remote command string. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
