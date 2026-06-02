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
  bootstrapped = false
  disposed = false
  private server: RpcServer | null = null
  private dataCb: ((chunk: string | Buffer) => void) | null = null
  private closeCb: ((info: { code: number | null }) => void) | null = null

  constructor(private readonly serverOpts: RpcServerOptions = {}) {}

  async bootstrap(): Promise<void> {
    this.bootstrapped = true
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
}

describe('CompanionManager connection lifecycle', () => {
  test('connect bootstraps, handshakes, registers, and resolves', async () => {
    const mgr = new CompanionManager()
    const transport = new FakeTransport()
    const companion = await mgr.connect('wsl_test', transport)

    expect(transport.bootstrapped).toBe(true)
    expect(companion.id).toBe('wsl_test')
    expect(mgr.resolve('wsl_test')).toBe(companion)

    // The connected companion really works over the wire. tmpdir is always an
    // allowed root, and it isn't a git repo.
    expect(await companion.vcs.isRepo(os.tmpdir())).toBe(false)
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

  test('a version mismatch rejects the connect and disposes the transport', async () => {
    const mgr = new CompanionManager()
    const transport = new FakeTransport({ hello: { companionVersion: '0.0.0-old' } })
    await expect(mgr.connect('wsl_test', transport)).rejects.toThrow(/version mismatch/)
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

  test('a version mismatch auto-upgrades: re-bootstrap + relaunch, then connects', async () => {
    // First launch reports an old version; bootstrap "installs" the correct one,
    // so the relaunch after the mismatch reports the right version.
    class UpgradingTransport implements CompanionTransport {
      readonly kind = 'wsl'
      bootstrapCount = 0
      private dataCb: ((c: string | Buffer) => void) | null = null
      async bootstrap(): Promise<void> { this.bootstrapCount++ }
      async launch(): Promise<CompanionChannel> {
        const correct = this.bootstrapCount >= 2
        const server = new RpcServer(
          localCompanion,
          (line) => this.dataCb?.(line),
          correct ? {} : { hello: { companionVersion: '0.0.0-old' } },
        )
        return {
          write: (line) => server.handleChunk(line),
          onData: (cb) => { this.dataCb = cb; server.start() },
          onClose: () => {},
          kill: () => server.dispose(),
        }
      }
      async dispose(): Promise<void> {}
    }
    const mgr = new CompanionManager()
    const transport = new UpgradingTransport()
    const companion = await mgr.connect('wsl_test', transport)
    expect(companion.id).toBe('wsl_test')
    expect(transport.bootstrapCount).toBe(2) // initial + re-bootstrap
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
    expect(seen).toEqual(['connecting', 'connected'])
    await mgr.disposeConnection('wsl_test')
    expect(seen).toContain('disconnected')
  })

  test('the local companion is always present and never connects over a transport', () => {
    const mgr = new CompanionManager()
    expect(mgr.resolve(LOCAL_COMPANION_ID)).toBe(localCompanion)
    expect(() => mgr.connect(LOCAL_COMPANION_ID, new FakeTransport())).toThrow(/does not connect/)
  })
})
