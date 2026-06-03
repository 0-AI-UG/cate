import os from 'node:os'
import { describe, expect, test } from 'vitest'
import { CompanionManager } from './companionManager'
import { localCompanion } from './LocalCompanion'
import { LOCAL_COMPANION_ID } from './locator'
import { RpcServer, type RpcServerOptions } from '../../companion/rpcServer'
import type { CompanionChannel, CompanionTransport } from './transports/transport'

// A transport whose "daemon" is an in-process RpcServer backed by the real
// LocalCompanion — exercises the full connect/handshake/version lifecycle in
// CompanionManager without a real host. The server is started only once a data
// listener attaches, so the hello frame is never dropped.
class FakeTransport implements CompanionTransport {
  readonly kind = 'wsl'
  installed = true
  bootstrapped = false
  forcedBootstrap = false
  uninstalled = false
  disposed = false
  private server: RpcServer | null = null
  private dataCb: ((chunk: string | Buffer) => void) | null = null
  private closeCb: ((info: { code: number | null }) => void) | null = null

  constructor(private readonly serverOpts: RpcServerOptions = {}) {}

  async isInstalled(): Promise<boolean> {
    return this.installed
  }

  async bootstrap(_version?: string, force = false): Promise<void> {
    this.bootstrapped = true
    this.forcedBootstrap = force
    this.installed = true
  }

  async uninstall(): Promise<void> {
    this.uninstalled = true
    this.installed = false
  }

  async launch(): Promise<CompanionChannel> {
    const server = new RpcServer(localCompanion, (line) => this.dataCb?.(line), this.serverOpts)
    this.server = server
    return {
      write: (line) => server.handleChunk(line),
      onData: (cb) => {
        this.dataCb = cb
        server.start() // emit hello now that someone is listening
      },
      onClose: (cb) => { this.closeCb = cb },
      kill: () => { server.dispose(); this.closeCb?.({ code: 0 }) },
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.server?.dispose()
  }

  /** Simulate an *unexpected* drop (daemon crash / network), distinct from an
   *  intentional disposeConnection() teardown. */
  triggerClose(code = 1): void {
    this.closeCb?.({ code })
  }
}

describe('CompanionManager connection lifecycle', () => {
  test('a probe connect to an installed host connects WITHOUT installing', async () => {
    const mgr = new CompanionManager()
    const transport = new FakeTransport() // installed = true
    const companion = await mgr.connect('wsl_test', transport)

    expect(transport.bootstrapped).toBe(false) // probe never installs
    expect(companion.id).toBe('wsl_test')
    expect(mgr.resolve('wsl_test')).toBe(companion)

    // The connected companion really works over the wire. tmpdir is always an
    // allowed root, and it isn't a git repo.
    expect(await companion.vcs.isRepo(os.tmpdir())).toBe(false)
  })

  test('a probe to a NOT-installed host stops at missing and does not register', async () => {
    const mgr = new CompanionManager()
    const transport = new FakeTransport()
    transport.installed = false
    const seen: string[] = []
    mgr.setStatusListener((_id, state) => seen.push(state))

    await expect(mgr.connect('wsl_test', transport)).rejects.toThrow(/not installed/i)
    expect(transport.bootstrapped).toBe(false) // probe never installs
    expect(seen).toContain('missing')
    expect(mgr.has('wsl_test')).toBe(false)
  })

  test('an install connect bootstraps a not-installed host, then connects', async () => {
    const mgr = new CompanionManager()
    const transport = new FakeTransport()
    transport.installed = false
    const companion = await mgr.connect('wsl_test', transport, { install: true })
    expect(transport.bootstrapped).toBe(true)
    expect(companion.id).toBe('wsl_test')
  })

  test('install threads the force flag to transport.bootstrap (clean reinstall)', async () => {
    const mgr = new CompanionManager()
    const def = new FakeTransport()
    await mgr.connect('wsl_default', def) // probe only — installed, no bootstrap
    expect(def.forcedBootstrap).toBe(false)
    expect(def.bootstrapped).toBe(false)

    const forced = new FakeTransport()
    await mgr.connect('wsl_forced', forced, { install: true, force: true })
    expect(forced.forcedBootstrap).toBe(true)
  })

  test('concurrent connects to the same id share one in-flight attempt', async () => {
    const mgr = new CompanionManager()
    const transport = new FakeTransport()
    const [a, b] = await Promise.all([
      mgr.connect('wsl_test', transport),
      mgr.connect('wsl_test', transport),
    ])
    expect(a).toBe(b)
  })

  test('a version mismatch reports missing, rejects, and disposes (no auto-upgrade)', async () => {
    const mgr = new CompanionManager()
    const transport = new FakeTransport({ hello: { companionVersion: '0.0.0-old' } })
    const seen: string[] = []
    mgr.setStatusListener((_id, state) => seen.push(state))
    // An installed-but-wrong-version bundle isn't silently re-bootstrapped: it
    // surfaces as `missing` so the user reinstalls explicitly.
    await expect(mgr.connect('wsl_test', transport)).rejects.toThrow(/version mismatch/)
    expect(seen).toContain('missing')
    expect(transport.disposed).toBe(true)
    expect(mgr.has('wsl_test')).toBe(false)
  })

  test('disposeConnection tears the companion down', async () => {
    const mgr = new CompanionManager()
    const transport = new FakeTransport()
    await mgr.connect('wsl_test', transport)
    expect(mgr.has('wsl_test')).toBe(true)
    await mgr.disposeConnection('wsl_test')
    expect(mgr.has('wsl_test')).toBe(false)
    expect(transport.disposed).toBe(true)
  })

  test('deleteInstall removes the host install and reports missing', async () => {
    const mgr = new CompanionManager()
    const transport = new FakeTransport()
    await mgr.connect('wsl_test', transport)
    expect(mgr.has('wsl_test')).toBe(true)

    const seen: string[] = []
    mgr.setStatusListener((_id, state) => seen.push(state))
    // Delete uses a fresh transport (like the IPC layer); reuse this fake.
    const deleter = new FakeTransport()
    await mgr.deleteInstall('wsl_test', deleter)
    expect(mgr.has('wsl_test')).toBe(false) // daemon torn down
    expect(deleter.uninstalled).toBe(true) // host install removed
    expect(seen).toContain('missing') // recover via a normal Install
  })

  test('a daemon that exits before handshake surfaces its stderr in the error', async () => {
    // Simulates `node: command not found` / missing node-pty on the host: the
    // process writes to stderr and exits without ever sending hello.
    class FailingTransport implements CompanionTransport {
      readonly kind = 'wsl'
      async bootstrap(): Promise<void> {}
      async launch(): Promise<CompanionChannel> {
        let stderrCb: ((c: string | Buffer) => void) | null = null
        let closeCb: ((info: { code: number | null }) => void) | null = null
        setTimeout(() => {
          stderrCb?.('node: command not found\n')
          closeCb?.({ code: 127 })
        }, 0)
        return {
          write: () => {},
          onData: () => {},
          onStderr: (cb) => { stderrCb = cb },
          onClose: (cb) => { closeCb = cb },
          kill: () => {},
        }
      }
      async dispose(): Promise<void> {}
    }
    const mgr = new CompanionManager()
    await expect(mgr.connect('wsl_test', new FailingTransport())).rejects.toThrow(/node: command not found/)
  })

  test('status transitions are reported to a listener', async () => {
    const mgr = new CompanionManager()
    const seen: string[] = []
    mgr.setStatusListener((_id, state) => seen.push(state))
    await mgr.connect('wsl_test', new FakeTransport())
    // Probe of an installed host: connecting (probe + launch) → connected. No
    // 'installing' — probes never install.
    expect(seen).toEqual(['connecting', 'connected'])
    // An intentional teardown must NOT report a drop — the caller (reinstall /
    // remove) drives the phase itself, and a late 'disconnected' would clobber
    // a freshly reconnected companion back to disconnected.
    await mgr.disposeConnection('wsl_test')
    expect(seen).not.toContain('disconnected')
  })

  test('an unexpected channel close reports disconnected', async () => {
    const mgr = new CompanionManager()
    const transport = new FakeTransport()
    const seen: string[] = []
    mgr.setStatusListener((_id, state) => seen.push(state))
    await mgr.connect('wsl_test', transport)
    // Daemon crash / network drop while still the live connection.
    transport.triggerClose()
    expect(seen).toContain('disconnected')
    expect(mgr.has('wsl_test')).toBe(false)
  })

  test('the local companion is always present and never connects over a transport', () => {
    const mgr = new CompanionManager()
    expect(mgr.resolve(LOCAL_COMPANION_ID)).toBe(localCompanion)
    expect(() => mgr.connect(LOCAL_COMPANION_ID, new FakeTransport())).toThrow(/does not connect/)
  })
})
