// =============================================================================
// SshTransport — runs the runtime daemon on a remote Linux/macOS host over
// SSH. The daemon is SELF-CONTAINED per target (runtime.cjs + node_modules
// incl. the matching node-pty prebuild + a bundled Node runtime), so the host
// needs nothing preinstalled (server-side `git` is still needed for VCS).
//
// On connect the transport installs the daemon into ~/.cate/runtime/<ver>/<target>:
//   1. REMOTE PULL — the host downloads its own tarball straight from the
//      GitHub release (curl/wget). Bytes never transit the laptop; this is the
//      fast path and works whenever the host has internet.
//   2. SFTP FALLBACK — if the host can't fetch (no internet / no curl+wget, or
//      the release doesn't have this target yet, e.g. a dev build), the client
//      downloads the tarball (runtimeArtifacts.ensureLocalTarball) and pushes
//      it over SFTP.
// Either way the install is cached by version+target on the host (.ok marker),
// so reconnects are instant.
//
// STATUS: runtime-verified against a real server via the opt-in live harness
// (sshLive.itest.ts) — connect/hold, concurrent-connect dedup, and force
// reinstall all behave, with the remote daemon exiting cleanly on teardown.
// Requires the `ssh2` package (installed); the import is dynamic to keep the
// build resilient.
// =============================================================================

import { ensureLocalTarball, isRuntimeDevMode, isRuntimeTarget, type RuntimeTarget } from '../runtimeArtifacts'
import { verifyAndPinHostKey, hostKeyId } from '../sshKnownHosts'
import { shellQuote as shq, bootstrapDevShared, isInstalledShared, bootstrapProdShared, buildExtractCommand, type RuntimeChannel, type RuntimeTransport } from './transport'

export interface SshOptions {
  host: string
  user: string
  port?: number
  /** Runtime-absolute workspace root on the server. */
  root: string
  id: string
  privateKey?: Buffer | string
  passphrase?: string
  agentSock?: string
  exclusions?: string[]
  /** Idle-suspend of backgrounded terminals (the user's setting); appended as
   *  `--idle-suspend` to the daemon launch args when true — same flag the
   *  local transport passes, so an SSH host honors the setting identically. */
  idleSuspend?: boolean
  /** Host-key policy (TOFU pin). Injected for tests; defaults to the on-disk
   *  known-hosts store keyed by host:port. Receives ssh2's sha256 fingerprint;
   *  must throw to reject the connection (host-key mismatch / MITM). */
  verifyHostKey?: (fingerprint: string) => Promise<void>
}

async function loadSsh2(): Promise<unknown> {
  const spec = 'ssh2'
  return import(spec)
}

export class SshTransport implements RuntimeTransport {
  readonly kind = 'server'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private conn: any = null
  private target: RuntimeTarget | '' = ''
  private installDir = ''

  constructor(private readonly opts: SshOptions) {}

  private verifyHostKey(fingerprint: string): Promise<void> {
    if (this.opts.verifyHostKey) return this.opts.verifyHostKey(fingerprint)
    return verifyAndPinHostKey(hostKeyId(this.opts.host, this.opts.port), fingerprint)
  }

  private async ensureConnected(): Promise<void> {
    if (this.conn) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ssh2 = (await loadSsh2()) as any
    const conn = new ssh2.Client()
    // Host-key verification (TOFU). ssh2 does NO checking without a hostVerifier;
    // a mismatch here is captured so the connect rejects with a clear reason
    // rather than ssh2's generic transport error.
    let hostKeyError: Error | null = null
    await new Promise<void>((resolve, reject) => {
      conn.on('ready', resolve)
      conn.on('error', (err: Error) => reject(hostKeyError ?? err))
      conn.connect({
        host: this.opts.host,
        port: this.opts.port ?? 22,
        username: this.opts.user,
        privateKey: this.opts.privateKey,
        passphrase: this.opts.passphrase,
        agent: this.opts.agentSock,
        keepaliveInterval: 15000,
        readyTimeout: 20000,
        // hostHash makes ssh2 hand us a hex sha256 of the host key — our pin.
        hostHash: 'sha256',
        hostVerifier: (hashedKey: string | Buffer, cb: (valid: boolean) => void) => {
          const fingerprint = typeof hashedKey === 'string' ? hashedKey : Buffer.from(hashedKey).toString('hex')
          this.verifyHostKey(fingerprint).then(
            () => cb(true),
            (err: unknown) => { hostKeyError = err instanceof Error ? err : new Error(String(err)); cb(false) },
          )
        },
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
        // A channel-level error (connection dropped mid-command) would otherwise
        // never fire 'close', hanging this promise forever — reject instead.
        stream.on('error', (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))))
        stream.on('data', (d: Buffer) => { stdout += d.toString() })
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
        stream.on('close', (code: number) => resolve({ code, stdout, stderr }))
      })
    })
  }

  /** Probe the host's platform/arch (and libc) and map to a runtime target. */
  private async probeTarget(): Promise<RuntimeTarget> {
    const { stdout } = await this.exec('uname -s; uname -m; (ldd --version 2>&1 | head -n1) || true')
    const [sys = '', machine = '', libc = ''] = stdout.split('\n').map((s) => s.trim())
    const platform = /linux/i.test(sys) ? 'linux' : /darwin/i.test(sys) ? 'darwin' : null
    const arch = /(aarch64|arm64)/i.test(machine) ? 'arm64' : /(x86_64|amd64)/i.test(machine) ? 'x64' : null
    if (!platform || !arch) throw new Error(`Unsupported server platform: "${sys} ${machine}"`)
    if (platform === 'linux' && /musl/i.test(libc)) {
      throw new Error(
        `This server uses musl libc (e.g. Alpine); the runtime ships glibc node-pty prebuilds only. ` +
          'Use a glibc-based host (Debian/Ubuntu/RHEL/…) or install glibc compatibility.',
      )
    }
    const target = `${platform}-${arch}`
    if (!isRuntimeTarget(target)) throw new Error(`No runtime build for target "${target}"`)
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
      this.installDir = `${home.trim()}/.cate/runtime/${version}/${this.target}`
    }
    return this.installDir
  }

  /** Reachable + correct-version bundle present? Does NOT install. A connect
   *  failure rejects (→ unreachable); `false` means reachable-but-absent (→
   *  missing). In dev the freshness key is the provisioned core (the cjs hot-swap
   *  is part of install, not the probe). */
  async isInstalled(version: string): Promise<boolean> {
    const D = shq(await this.resolveInstallDir(version))
    return isInstalledShared(version, D, this.target as RuntimeTarget, (cmd) => this.exec(cmd))
  }

  /** Remove the whole runtime install tree on the host (all versions). */
  async uninstall(): Promise<void> {
    await this.ensureConnected()
    const { stdout: home } = await this.exec('echo $HOME')
    await this.exec(`rm -rf ${shq(`${home.trim()}/.cate/runtime`)}`)
    this.installDir = '' // force a fresh resolve on the next probe/install
  }

  async bootstrap(version: string, force?: boolean): Promise<void> {
    const D = shq(await this.resolveInstallDir(version))

    // Reinstall: drop the whole install dir (binaries + .ok/.cjs.ok markers) so
    // every "already provisioned?" probe below sees a clean slate and re-pulls.
    if (force) await this.exec(`rm -rf ${D}`)

    // DEV: never remote-pull (it would fetch a stale release tarball). Provision
    // the heavy parts once from the local tarball, then hot-swap only the 262KB
    // runtime.cjs whenever its hash changes — so `npm run build:runtime` +
    // reconnect updates the host with no version bump and no 35MB rebuild.
    if (isRuntimeDevMode()) {
      await this.bootstrapDev(version, D)
      return
    }

    // PROD: probe the `.ok` marker, then remote-pull from the release with an
    // SFTP push fallback when the host can't fetch (shared with WSL).
    await bootstrapProdShared(version, D, {
      tag: 'ssh',
      target: this.target as RuntimeTarget,
      installDir: this.installDir,
      exec: (cmd) => this.exec(cmd),
      pushTarball: (v, marker) => this.pushTarball(v, marker),
      pullFallbackLabel: '[runtime:ssh] remote pull unavailable (%s); falling back to SFTP push',
    })
  }

  /**
   * Dev provisioning. Installs the heavy parts (runtime + node_modules + node-pty)
   * from the local tarball once, then overlays the freshest local runtime.cjs,
   * keyed by its content hash in `.cjs.ok`. Subsequent connects with an unchanged
   * bundle are a single hash check; a changed bundle is a 262KB SFTP push. Never
   * remote-pulls. The host runs whatever `build:runtime` last produced.
   */
  private bootstrapDev(version: string, D: string): Promise<void> {
    return bootstrapDevShared(version, D, {
      tag: 'ssh',
      exec: (cmd) => this.exec(cmd),
      pushTarball: (v, marker) => this.pushTarball(v, marker),
      pushBundle: async (bundle, hash, quotedDir) => {
        await this.exec(`mkdir -p ${quotedDir}`)
        await this.sftpPut(bundle, `${this.installDir}/runtime.cjs`)
        await this.exec(`printf %s ${shq(hash)} > ${quotedDir}/.cjs.ok`)
      },
    })
  }

  private async pushTarball(version: string, marker: string): Promise<void> {
    if (!this.target) throw new Error('pushTarball called before probeTarget')
    const localTar = await ensureLocalTarball(version, this.target)
    const D = shq(this.installDir)
    const remoteTar = `${this.installDir}/pkg.tgz`
    await this.exec(`mkdir -p ${D}`)
    await this.sftpPut(localTar, remoteTar)
    const extract = await this.exec(`cd ${D} && ${buildExtractCommand(shq(marker), 'CATE_EXTRACT_OK')}`)
    if (!extract.stdout.includes('CATE_EXTRACT_OK')) {
      throw new Error(`remote extract failed: ${extract.stderr || extract.stdout}`)
    }
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

  async launch(): Promise<RuntimeChannel> {
    await this.ensureConnected()
    const nodeBin = `${this.installDir}/runtime/bin/node`
    const args = `--root ${shq(this.opts.root)} --id ${shq(this.opts.id)}` +
      (this.opts.exclusions?.length ? ` --exclude ${shq(this.opts.exclusions.join(','))}` : '') +
      (this.opts.idleSuspend ? ' --idle-suspend' : '')
    const cmd = `${shq(nodeBin)} ${shq(`${this.installDir}/runtime.cjs`)} ${args}`

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
