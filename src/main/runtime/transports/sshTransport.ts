// =============================================================================
// SshTransport — runs the runtime daemon through the user's system OpenSSH
// client. OpenSSH remains the authority for ~/.ssh/config, Include/Match blocks,
// ProxyCommand/ProxyJump, certificates, IdentityAgent, hardware-backed keys, and
// the known-hosts database. Cate supplies explicit form overrides plus its
// existing accept-new TOFU default, and otherwise leaves SSH config intact.
// =============================================================================

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ensureLocalTarball, isRuntimeDevMode, isRuntimeTarget, type RuntimeTarget } from '../runtimeArtifacts'
import { shellQuote as shq, bootstrapDevShared, isInstalledShared, bootstrapProdShared, buildExtractCommand, type RuntimeChannel, type RuntimeTransport } from './transport'

export interface SshOptions {
  /** Host name or unmodified OpenSSH Host alias. */
  host: string
  /** Optional explicit user. Empty means OpenSSH resolves User from its config. */
  user: string
  port?: number
  /** Runtime-absolute workspace root on the server. */
  root: string
  id: string
  /** Explicit identity path. OpenSSH automatically discovers its `-cert.pub`. */
  keyPath?: string
  passphrase?: string
  /** False disables both SSH_AUTH_SOCK and configured IdentityAgent use. */
  useAgent?: boolean
  /** Resolved login-shell environment, including SSH_AUTH_SOCK and PATH. */
  env?: NodeJS.ProcessEnv
  exclusions?: string[]
  /** Idle-suspend of backgrounded terminals (the user's setting); appended as
   *  `--idle-suspend` to the daemon launch args when true — same flag the
   *  local transport passes, so an SSH host honors the setting identically. */
  idleSuspend?: boolean
  /** Test seam; production always uses child_process.spawn. */
  spawn?: typeof nodeSpawn
}

interface ProcessResult {
  code: number
  stdout: string
  stderr: string
}

function detail(stderr: string): string {
  return stderr.trim().replace(/\s+/g, ' ')
}

function openSshFailure(binary: string, target: string, stderr: string, cause?: NodeJS.ErrnoException): Error {
  if (cause?.code === 'ENOENT') {
    return new Error(
      `The system OpenSSH ${binary} client was not found. Install OpenSSH and ensure "${binary}" is available on PATH.`,
    )
  }
  const message = detail(stderr) || cause?.message || `${binary} exited without an error message`
  if (/permission denied|no supported authentication methods available/i.test(message)) {
    return new Error(`SSH authentication failed for "${target}". OpenSSH reported: ${message}`)
  }
  if (/could not resolve hostname|name or service not known|nodename nor servname/i.test(message)) {
    return new Error(
      `SSH could not resolve or route "${target}". OpenSSH configuration, including ProxyCommand, was applied. ${message}`,
    )
  }
  if (/host key verification failed|remote host identification has changed/i.test(message)) {
    return new Error(`SSH host-key verification failed for "${target}". OpenSSH reported: ${message}`)
  }
  return new Error(`SSH connection to "${target}" failed. OpenSSH reported: ${message}`)
}

export class SshTransport implements RuntimeTransport {
  readonly kind = 'server'
  private target: RuntimeTarget | '' = ''
  private installDir = ''
  private readonly children = new Set<ChildProcessWithoutNullStreams>()
  private askpassDir = ''
  private askpassPromise: Promise<string> | null = null

  constructor(private readonly opts: SshOptions) {}

  private get spawn(): typeof nodeSpawn {
    return this.opts.spawn ?? nodeSpawn
  }

  private destination(): string {
    return this.opts.user ? `${this.opts.user}@${this.opts.host}` : this.opts.host
  }

  /** Options shared by ssh/scp. They deliberately do not use IdentitiesOnly:
   * OpenSSH must remain free to offer configured certificates and agent keys. */
  private connectionArgs(portFlag: '-p' | '-P'): string[] {
    const args = [
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=20',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
    ]
    if (this.opts.passphrase) {
      // Askpass unlocks only local public-key identities. Restricting the SSH
      // methods prevents the key passphrase from being reused as a host password.
      args.push('-o', 'BatchMode=no', '-o', 'PreferredAuthentications=publickey')
      // Even a broad user `SendEnv *` must never forward Cate's askpass secret.
      args.push(
        '-o', 'SendEnv=-CATE_SSH_*',
        '-o', 'SendEnv=-NODE_OPTIONS',
        '-o', 'SendEnv=-ELECTRON_RUN_AS_NODE',
      )
    } else {
      args.push('-o', 'BatchMode=yes')
    }
    if (this.opts.useAgent === false) args.push('-o', 'IdentityAgent=none')
    if (this.opts.keyPath) args.push('-i', this.opts.keyPath)
    if (this.opts.port != null) args.push(portFlag, String(this.opts.port))
    return args
  }

  private async ensureAskpass(): Promise<string> {
    if (!this.askpassPromise) {
      this.askpassPromise = (async () => {
        const dir = await mkdtemp(join(tmpdir(), 'cate-ssh-askpass-'))
        this.askpassDir = dir
        const script = join(dir, 'answer.js')
        await writeFile(
          script,
          "process.stdout.write(process.env.CATE_SSH_PASSPHRASE || ''); process.exit(0)\n",
          { mode: 0o600 },
        )
        return script
      })()
    }
    return this.askpassPromise
  }

  private async processEnv(): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...(this.opts.env ?? process.env) }
    if (this.opts.useAgent === false) delete env.SSH_AUTH_SOCK
    if (!this.opts.passphrase) return env
    const askpassScript = await this.ensureAskpass()
    return {
      ...env,
      DISPLAY: env.DISPLAY || 'cate:0',
      ELECTRON_RUN_AS_NODE: '1',
      // Electron becomes a plain Node executable under ELECTRON_RUN_AS_NODE.
      // Preloading the answer script avoids platform-specific shell wrappers;
      // this works for packaged macOS/Linux builds and Windows electron.exe.
      SSH_ASKPASS: process.execPath,
      SSH_ASKPASS_REQUIRE: 'force',
      NODE_OPTIONS: `--require=${askpassScript}`,
      CATE_SSH_ASKPASS_SCRIPT: askpassScript,
      CATE_SSH_PASSPHRASE: this.opts.passphrase,
    }
  }

  private track(child: ChildProcessWithoutNullStreams): void {
    this.children.add(child)
    child.once('close', () => this.children.delete(child))
  }

  private async run(binary: 'ssh' | 'scp', args: string[]): Promise<ProcessResult> {
    const env = await this.processEnv()
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = this.spawn(binary, args, {
          env,
          stdio: 'pipe',
          windowsHide: true,
        })
      } catch (err) {
        reject(openSshFailure(binary, this.destination(), '', err as NodeJS.ErrnoException))
        return
      }
      this.track(child)
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.once('error', (err: NodeJS.ErrnoException) => {
        reject(openSshFailure(binary, this.destination(), stderr, err))
      })
      child.once('close', (code) => resolve({ code: code ?? 255, stdout, stderr }))
    })
  }

  private async exec(cmd: string): Promise<ProcessResult> {
    const result = await this.run('ssh', [
      '-T',
      ...this.connectionArgs('-p'),
      this.destination(),
      cmd,
    ])
    // OpenSSH reserves 255 for transport/config/authentication failures. Remote
    // command failures use their own exit code and remain ordinary probe data.
    if (result.code === 255) throw openSshFailure('ssh', this.destination(), result.stderr)
    return result
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

  /** Probe + resolve the version-specific install dir. Each operation invokes
   * OpenSSH independently; the long-lived daemon connection is created by launch. */
  private async resolveInstallDir(version: string): Promise<string> {
    if (!this.target) this.target = await this.probeTarget()
    if (!this.installDir) {
      const { stdout: home } = await this.exec('printf %s "$HOME"')
      this.installDir = `${home.trim()}/.cate/runtime/${version}/${this.target}`
    }
    return this.installDir
  }

  async isInstalled(version: string): Promise<boolean> {
    const D = shq(await this.resolveInstallDir(version))
    return isInstalledShared(version, D, this.target as RuntimeTarget, (cmd) => this.exec(cmd))
  }

  /** Remove the whole runtime install tree on the host (all versions). */
  async uninstall(): Promise<void> {
    const { stdout: home } = await this.exec('printf %s "$HOME"')
    await this.exec(`rm -rf ${shq(`${home.trim()}/.cate/runtime`)}`)
    this.installDir = ''
  }

  async bootstrap(version: string, force?: boolean): Promise<void> {
    const D = shq(await this.resolveInstallDir(version))
    if (force) await this.exec(`rm -rf ${D}`)

    if (isRuntimeDevMode()) {
      await this.bootstrapDev(version, D)
      return
    }

    await bootstrapProdShared(version, D, {
      tag: 'ssh',
      target: this.target as RuntimeTarget,
      installDir: this.installDir,
      exec: (cmd) => this.exec(cmd),
      pushTarball: (v, marker) => this.pushTarball(v, marker),
      pullFallbackLabel: '[runtime:ssh] remote pull unavailable (%s); falling back to OpenSSH file transfer',
    })
  }

  private bootstrapDev(version: string, D: string): Promise<void> {
    return bootstrapDevShared(version, D, {
      tag: 'ssh',
      exec: (cmd) => this.exec(cmd),
      pushTarball: (v, marker) => this.pushTarball(v, marker),
      pushBundle: async (bundle, hash, quotedDir) => {
        await this.exec(`mkdir -p ${quotedDir}`)
        await this.upload(bundle, `${this.installDir}/runtime.cjs`)
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
    await this.upload(localTar, remoteTar)
    const extract = await this.exec(`cd ${D} && ${buildExtractCommand(shq(marker), 'CATE_EXTRACT_OK')}`)
    if (!extract.stdout.includes('CATE_EXTRACT_OK')) {
      throw new Error(`remote extract failed: ${extract.stderr || extract.stdout}`)
    }
  }

  /** scp uses OpenSSH's SFTP protocol by default on current clients while also
   * preserving the exact Host alias/configuration used by ssh. */
  private async upload(localPath: string, remotePath: string): Promise<void> {
    const result = await this.run('scp', [
      ...this.connectionArgs('-P'),
      '--',
      localPath,
      `${this.destination()}:${remotePath}`,
    ])
    if (result.code !== 0) throw openSshFailure('scp', this.destination(), result.stderr)
  }

  async launch(): Promise<RuntimeChannel> {
    const nodeBin = `${this.installDir}/runtime/bin/node`
    const args = `--root ${shq(this.opts.root)} --id ${shq(this.opts.id)}` +
      (this.opts.exclusions?.length ? ` --exclude ${shq(this.opts.exclusions.join(','))}` : '') +
      (this.opts.idleSuspend ? ' --idle-suspend' : '')
    const cmd = `${shq(nodeBin)} ${shq(`${this.installDir}/runtime.cjs`)} ${args}`
    const env = await this.processEnv()
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.spawn('ssh', [
        '-T',
        ...this.connectionArgs('-p'),
        this.destination(),
        cmd,
      ], { env, stdio: 'pipe', windowsHide: true })
    } catch (err) {
      throw openSshFailure('ssh', this.destination(), '', err as NodeJS.ErrnoException)
    }
    this.track(child)

    // Attach buffering before awaiting spawn so an immediate auth failure or
    // fast daemon hello cannot race RuntimeManager's listener registration.
    const dataQueue: Buffer[] = []
    const stderrQueue: Buffer[] = []
    let dataListener: ((chunk: Buffer) => void) | null = null
    let stderrListener: ((chunk: Buffer) => void) | null = null
    let closeListener: ((info: { code: number | null }) => void) | null = null
    let closed: { code: number | null } | null = null
    child.stdout.on('data', (chunk: Buffer) => dataListener ? dataListener(chunk) : dataQueue.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrListener ? stderrListener(chunk) : stderrQueue.push(chunk))
    child.once('close', (code) => {
      closed = { code }
      closeListener?.(closed)
    })

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', (err: NodeJS.ErrnoException) => {
        reject(openSshFailure('ssh', this.destination(), '', err))
      })
    })

    return {
      write: (line) => { child.stdin.write(line) },
      onData: (cb) => {
        dataListener = cb
        for (const chunk of dataQueue.splice(0)) cb(chunk)
      },
      onStderr: (cb) => {
        stderrListener = cb
        for (const chunk of stderrQueue.splice(0)) cb(chunk)
      },
      onClose: (cb) => {
        closeListener = cb
        if (closed) queueMicrotask(() => cb(closed!))
      },
      kill: () => { try { child.kill() } catch { /* already exited */ } },
    }
  }

  async dispose(): Promise<void> {
    for (const child of this.children) {
      try { child.kill() } catch { /* already exited */ }
    }
    this.children.clear()
    if (this.askpassDir) await rm(this.askpassDir, { recursive: true, force: true }).catch(() => {})
    this.askpassDir = ''
    this.askpassPromise = null
  }
}
