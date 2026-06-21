import os from 'node:os'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { RuntimeManager } from './runtimeManager'
import { LOCAL_RUNTIME_ID } from './locator'
import { buildDaemonRuntime } from '../../runtime/capabilities'
import { RpcServer, type RpcServerOptions } from '../../runtime/rpcServer'
import type { Runtime } from './types'
import type { RuntimeChannel, RuntimeTransport } from './transports/transport'

// The real daemon capability set, hosted by the fake transport's in-process
// RpcServer — same api the local/remote workspace daemons serve.
const daemonApi: Runtime = buildDaemonRuntime({ id: 'srv_test' }).runtime

// A transport whose "daemon" is an in-process RpcServer backed by the real
// daemon capabilities — exercises the full connect/handshake/version lifecycle in
// RuntimeManager without a real host. The server is started only once a data
// listener attaches, so the hello frame is never dropped.
class FakeTransport implements RuntimeTransport {
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

  async launch(): Promise<RuntimeChannel> {
    const server = new RpcServer(daemonApi, (line) => this.dataCb?.(line), this.serverOpts)
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

describe('RuntimeManager connection lifecycle', () => {
  test('a probe connect to an installed host connects WITHOUT installing', async () => {
    const mgr = new RuntimeManager()
    const transport = new FakeTransport() // installed = true
    const runtime = await mgr.connect('wsl_test', transport)

    expect(transport.bootstrapped).toBe(false) // probe never installs
    expect(runtime.id).toBe('wsl_test')
    expect(mgr.resolve('wsl_test')).toBe(runtime)

    // The connected runtime really works over the wire. tmpdir is always an
    // allowed root, and it isn't a git repo.
    expect(await runtime.vcs.isRepo(os.tmpdir())).toBe(false)
  })

  test('a probe to a NOT-installed host stops at missing and does not register', async () => {
    const mgr = new RuntimeManager()
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
    const mgr = new RuntimeManager()
    const transport = new FakeTransport()
    transport.installed = false
    const runtime = await mgr.connect('wsl_test', transport, { install: true })
    expect(transport.bootstrapped).toBe(true)
    expect(runtime.id).toBe('wsl_test')
  })

  test('install threads the force flag to transport.bootstrap (clean reinstall)', async () => {
    const mgr = new RuntimeManager()
    const def = new FakeTransport()
    await mgr.connect('wsl_default', def) // probe only — installed, no bootstrap
    expect(def.forcedBootstrap).toBe(false)
    expect(def.bootstrapped).toBe(false)

    const forced = new FakeTransport()
    await mgr.connect('wsl_forced', forced, { install: true, force: true })
    expect(forced.forcedBootstrap).toBe(true)
  })

  test('concurrent connects to the same id share one in-flight attempt', async () => {
    const mgr = new RuntimeManager()
    const transport = new FakeTransport()
    const [a, b] = await Promise.all([
      mgr.connect('wsl_test', transport),
      mgr.connect('wsl_test', transport),
    ])
    expect(a).toBe(b)
  })

  test('connect registers synchronously (a deferred) and resolves to the real runtime', () => {
    // The local and remote paths share this: connect() registers a runtime the
    // instant it is called (so resolve() works / the window paints before the
    // daemon is online), while only reporting `isConnected` once fully connected.
    const mgr = new RuntimeManager()
    const p = mgr.connect('wsl_test', new FakeTransport())
    expect(mgr.has('wsl_test')).toBe(true) // registered synchronously…
    expect(mgr.isConnected('wsl_test')).toBe(false) // …but not yet fully connected
    return p.then((runtime) => {
      expect(mgr.isConnected('wsl_test')).toBe(true)
      expect(mgr.resolve('wsl_test')).toBe(runtime) // deferred replaced by the real one
    })
  })

  test('a version mismatch reports missing, rejects, and disposes (no auto-upgrade)', async () => {
    const mgr = new RuntimeManager()
    const transport = new FakeTransport({ hello: { runtimeVersion: '0.0.0-old' } })
    const seen: string[] = []
    mgr.setStatusListener((_id, state) => seen.push(state))
    // An installed-but-wrong-version bundle isn't silently re-bootstrapped: it
    // surfaces as `missing` so the user reinstalls explicitly.
    await expect(mgr.connect('wsl_test', transport)).rejects.toThrow(/version mismatch/)
    expect(seen).toContain('missing')
    expect(transport.disposed).toBe(true)
    expect(mgr.has('wsl_test')).toBe(false)
  })

  test('disposeConnection tears the runtime down', async () => {
    const mgr = new RuntimeManager()
    const transport = new FakeTransport()
    await mgr.connect('wsl_test', transport)
    expect(mgr.has('wsl_test')).toBe(true)
    await mgr.disposeConnection('wsl_test')
    expect(mgr.has('wsl_test')).toBe(false)
    expect(transport.disposed).toBe(true)
  })

  test('deleteInstall removes the host install and reports missing', async () => {
    const mgr = new RuntimeManager()
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
    class FailingTransport implements RuntimeTransport {
      readonly kind = 'wsl'
      async bootstrap(): Promise<void> {}
      async launch(): Promise<RuntimeChannel> {
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
    const mgr = new RuntimeManager()
    await expect(mgr.connect('wsl_test', new FailingTransport())).rejects.toThrow(/node: command not found/)
  })

  test('status transitions are reported to a listener', async () => {
    const mgr = new RuntimeManager()
    const seen: string[] = []
    mgr.setStatusListener((_id, state) => seen.push(state))
    await mgr.connect('wsl_test', new FakeTransport())
    // Probe of an installed host: connecting (probe + launch) → connected. No
    // 'installing' — probes never install.
    expect(seen).toEqual(['connecting', 'connected'])
    // An intentional teardown must NOT report a drop — the caller (reinstall /
    // remove) drives the phase itself, and a late 'disconnected' would clobber
    // a freshly reconnected runtime back to disconnected.
    await mgr.disposeConnection('wsl_test')
    expect(seen).not.toContain('disconnected')
  })

  test('an unexpected channel close reports disconnected', async () => {
    const mgr = new RuntimeManager()
    const transport = new FakeTransport()
    const seen: string[] = []
    mgr.setStatusListener((_id, state) => seen.push(state))
    await mgr.connect('wsl_test', transport)
    // Daemon crash / network drop while still the live connection.
    transport.triggerClose()
    expect(seen).toContain('disconnected')
    expect(mgr.has('wsl_test')).toBe(false)
  })

  test('the local runtime is NOT registered until ensureLocalRuntime brings it online', () => {
    const mgr = new RuntimeManager()
    // The LOCAL workspace runs as the daemon subprocess, provisioned by
    // ensureLocalRuntime. Until then it's unregistered and resolve() throws.
    expect(mgr.has(LOCAL_RUNTIME_ID)).toBe(false)
    expect(() => mgr.resolve(LOCAL_RUNTIME_ID)).toThrow(/No runtime registered/)
  })

  test('the LOCAL runtime connects over a transport like any other (no special guard)', async () => {
    const mgr = new RuntimeManager()
    const runtime = await mgr.connect(LOCAL_RUNTIME_ID, new FakeTransport(), { install: true })
    expect(runtime.id).toBe(LOCAL_RUNTIME_ID)
    expect(mgr.resolve(LOCAL_RUNTIME_ID)).toBe(runtime)
  })

  test('localStatus() tracks the last LOCAL phase and ignores remote connects', async () => {
    // Seeds the renderer's startup loading blocker, so it must be readable before
    // any connect and reflect LOCAL transitions only.
    const mgr = new RuntimeManager()
    expect(mgr.localStatus().phase).toBe('connecting') // default: LOCAL always comes up at launch
    await mgr.connect('wsl_remote', new FakeTransport())
    expect(mgr.localStatus().phase).toBe('connecting') // a remote connect doesn't touch it
    await mgr.connect(LOCAL_RUNTIME_ID, new FakeTransport(), { install: true })
    expect(mgr.localStatus().phase).toBe('connected')
  })
})

// FIX [4]: a LOCAL daemon crash auto-reconnects (the whole workspace is dead
// otherwise), while REMOTE drops stay the user's to reconnect.
describe('RuntimeManager LOCAL auto-reconnect (FIX 4)', () => {
  afterEach(() => { vi.useRealTimers() })

  /** Prime localOpts the way ensureLocalRuntime would, then connect LOCAL over
   *  a fake transport so we have a live connection to drop. */
  async function connectLocal(mgr: RuntimeManager): Promise<FakeTransport> {
    ;(mgr as unknown as { localOpts: unknown }).localOpts = { root: os.homedir() }
    const transport = new FakeTransport()
    await mgr.connect(LOCAL_RUNTIME_ID, transport, { install: true })
    return transport
  }

  test('a LOCAL crash schedules a reconnect (connecting, not disconnected)', async () => {
    vi.useFakeTimers()
    const mgr = new RuntimeManager()
    const transport = await connectLocal(mgr)
    // Spy on the relaunch entry point. Stub the body so the test doesn't depend on
    // whether a real tarball happens to exist in the env — we only assert the
    // reconnect FIRES with the original opts.
    const ensureSpy = vi
      .spyOn(mgr, 'ensureLocalRuntime')
      .mockResolvedValue(undefined)
    const seen: string[] = []
    mgr.setStatusListener((_id, state) => seen.push(state))

    transport.triggerClose() // daemon crash on the live connection
    // Reconnect path: emits 'connecting' immediately, NOT 'disconnected'.
    expect(seen).toContain('connecting')
    expect(seen).not.toContain('disconnected')
    expect(mgr.has(LOCAL_RUNTIME_ID)).toBe(false) // dropped, awaiting relaunch

    // A second close while a reconnect is pending must NOT stack a second timer.
    seen.length = 0
    transport.triggerClose()
    expect(seen).not.toContain('connecting')

    // Let the backoff fire: ensureLocalRuntime re-runs once with the same opts.
    // First retry assumes a transient failure → no forced re-extract.
    await vi.advanceTimersByTimeAsync(1100)
    expect(ensureSpy).toHaveBeenCalledTimes(1)
    expect(ensureSpy).toHaveBeenCalledWith({ root: os.homedir() }, { force: false })
  })

  test('reconnect backs off, forces a re-extract, then gives up at the cap', () => {
    vi.useFakeTimers()
    const mgr = new RuntimeManager()
    ;(mgr as unknown as { localOpts: unknown }).localOpts = { root: os.homedir() }
    // Stub the relaunch so each scheduled reconnect is a no-op "failure" — the
    // retry budget only resets on a real successful connect (which we never let
    // happen here), so consecutive schedules escalate toward the cap.
    const ensureSpy = vi.spyOn(mgr, 'ensureLocalRuntime').mockReturnValue(undefined)
    const schedule = () => (mgr as unknown as { scheduleLocalReconnect(): void }).scheduleLocalReconnect()
    const home = os.homedir()

    // Attempt 1: ~1s backoff, no forced re-extract (transient-failure assumption).
    schedule()
    vi.advanceTimersByTime(1000)
    expect(ensureSpy).toHaveBeenLastCalledWith({ root: home }, { force: false })

    // Attempt 2+: force a clean re-extract to repair a corrupt/partial install.
    schedule()
    vi.advanceTimersByTime(2000)
    expect(ensureSpy).toHaveBeenLastCalledWith({ root: home }, { force: true })

    schedule(); vi.advanceTimersByTime(4000) // attempt 3
    schedule(); vi.advanceTimersByTime(8000) // attempt 4 (cap)
    expect(ensureSpy).toHaveBeenCalledTimes(4)

    // Past LOCAL_MAX_RETRIES the auto-retry stops — no further relaunch scheduled.
    schedule()
    vi.advanceTimersByTime(8000)
    expect(ensureSpy).toHaveBeenCalledTimes(4)
  })

  test('an intentional LOCAL teardown does NOT reconnect', async () => {
    vi.useFakeTimers()
    const mgr = new RuntimeManager()
    await connectLocal(mgr)
    const seen: string[] = []
    mgr.setStatusListener((_id, state) => seen.push(state))

    await mgr.disposeConnection(LOCAL_RUNTIME_ID)
    // disposeConnection removes the connection first, so the late close event is
    // ignored — no reconnect 'connecting' is emitted.
    await vi.advanceTimersByTimeAsync(1100)
    expect(seen).not.toContain('connecting')
  })

  test('a REMOTE drop still reports disconnected (no reconnect)', async () => {
    vi.useFakeTimers()
    const mgr = new RuntimeManager()
    const transport = new FakeTransport()
    await mgr.connect('wsl_remote', transport)
    const seen: string[] = []
    mgr.setStatusListener((_id, state) => seen.push(state))

    transport.triggerClose()
    expect(seen).toContain('disconnected')
    await vi.advanceTimersByTimeAsync(1100)
    expect(seen).not.toContain('connecting') // REMOTE never auto-reconnects
  })
})
