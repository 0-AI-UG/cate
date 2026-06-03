// =============================================================================
// LocalSubprocessTransport — runs the companion daemon as a child process on
// THIS machine. Mainly a building block / parity test of the protocol against a
// real OS pipe (the local workspace itself uses the in-process LocalCompanion,
// not this). In the packaged app, `nodePath` is Electron-as-node
// (process.execPath with ELECTRON_RUN_AS_NODE=1) and `bundlePath` is the
// shipped companion.cjs.
// =============================================================================

import { spawn, type ChildProcess } from 'child_process'
import type { CompanionChannel, CompanionTransport } from './transport'

export interface LocalSubprocessOptions {
  nodePath: string
  bundlePath: string
  root: string
  id: string
  exclusions?: string[]
  env?: NodeJS.ProcessEnv
}

export class LocalSubprocessTransport implements CompanionTransport {
  readonly kind = 'local'
  private child: ChildProcess | null = null

  constructor(private readonly opts: LocalSubprocessOptions) {}

  async bootstrap(): Promise<void> {
    // The bundle is shipped with the app; nothing to install for local.
  }

  async launch(): Promise<CompanionChannel> {
    const args = [this.opts.bundlePath, '--root', this.opts.root, '--id', this.opts.id]
    if (this.opts.exclusions?.length) args.push('--exclude', this.opts.exclusions.join(','))

    const child = spawn(this.opts.nodePath, args, {
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
