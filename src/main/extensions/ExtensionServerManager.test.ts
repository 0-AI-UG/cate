// Coverage for ExtensionServerManager's lifecycle: lazy spawn, reuse, grace,
// rejoin-cancels-grace, grace-expiry stop, crash → restart backoff cap, and
// disposeForWebContents. Uses a FAKE runtime (stubbed server.start/stop and
// tunnel.*) so nothing real is spawned, and fake timers for the grace + backoff
// windows.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Stub the manager's collaborators. parseLocator -> local/'/ws'; the workspace
// has a root; the manifest is server-backed; the runtime resolves to our fake.
const serverStart = vi.fn()
const serverStop = vi.fn()
let onExitCb: ((id: string, code: number | null, signal: string | null) => void) | null = null

const fakeRuntime = {
  id: 'local',
  server: {
    start: serverStart,
    stop: serverStop,
  },
  tunnel: {
    open: vi.fn(),
    write: vi.fn(),
    close: vi.fn(),
    listen: vi.fn(async () => ({ port: 54321 })),
    stopListen: vi.fn(),
  },
}

vi.mock('electron', () => ({}))
vi.mock('../runtime/runtimeManager', () => ({ runtimes: { resolve: () => fakeRuntime } }))
vi.mock('../../shared/runtimeLocator', () => ({
  parseLocator: () => ({ runtimeId: 'local', path: '/ws' }),
}))
vi.mock('../workspaceManager', () => ({
  getWorkspaceInfo: () => ({ rootPath: '/ws' }),
}))
const isEnabledState = vi.hoisted(() => ({ enabled: true }))
vi.mock('./ExtensionManager', () => ({
  extensionManager: {
    getManifest: () => ({
      id: 'cate.echo',
      name: 'Echo',
      panels: [{ id: 'main', label: 'Echo' }],
      server: { command: 'node server.js', readyPath: '/health', portEnv: 'PORT' },
    }),
    ensureProvisioned: async () => '/fake/ext/cate.echo',
    isEnabled: () => isEnabledState.enabled,
  },
}))
vi.mock('../logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { ExtensionServerManager } from './ExtensionServerManager'

const EXT = 'cate.echo'
const WS = 'ws1'

function fakeSender(id: number): Electron.WebContents {
  return { id } as unknown as Electron.WebContents
}

/** Make server.start resolve with a handle and capture its onExit callback. */
function startResolves(port = 5000): void {
  serverStart.mockImplementation(async (opts, _onOutput, onExit) => {
    onExitCb = onExit
    return { id: opts.id, pid: 1234, port }
  })
}

describe('ExtensionServerManager', () => {
  let mgr: ExtensionServerManager

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    onExitCb = null
    isEnabledState.enabled = true
    startResolves()
    mgr = new ExtensionServerManager()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lazily spawns the server on first join', async () => {
    const ep = await mgr.joinPanel(EXT, WS, 'p1', fakeSender(1))
    expect(serverStart).toHaveBeenCalledTimes(1)
    expect(ep.port).toBe(5000)
    expect(ep.token).toMatch(/.+/)
    expect(mgr.getState(EXT, WS)).toBe('READY')
  })

  it('reuses the same server across a second join (one start call)', async () => {
    await mgr.joinPanel(EXT, WS, 'p1', fakeSender(1))
    const ep2 = await mgr.joinPanel(EXT, WS, 'p2', fakeSender(1))
    expect(serverStart).toHaveBeenCalledTimes(1)
    expect(ep2.port).toBe(5000)
  })

  it('starts a grace timer when the last panel leaves; expiry stops the server', async () => {
    await mgr.joinPanel(EXT, WS, 'p1', fakeSender(1))
    mgr.leavePanel(EXT, WS, 'p1')
    expect(mgr.getState(EXT, WS)).toBe('GRACE')
    expect(serverStop).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(serverStop).toHaveBeenCalledTimes(1)
    // Session deleted after stop.
    expect(mgr.getState(EXT, WS)).toBeNull()
  })

  it('ensureServer during grace reuses the live server (no second spawn, grace cancelled)', async () => {
    await mgr.joinPanel(EXT, WS, 'p1', fakeSender(1))
    mgr.leavePanel(EXT, WS, 'p1')
    expect(mgr.getState(EXT, WS)).toBe('GRACE')

    // A straggler proxyHttp/handleUpgrade calls ensureServer directly during the
    // grace window: it must reuse the live handle, not spawn a second child.
    const ep = await mgr.ensureServer(EXT, WS)
    expect(ep.port).toBe(5000)
    expect(serverStart).toHaveBeenCalledTimes(1)
    expect(mgr.getState(EXT, WS)).toBe('READY')

    // Grace timer was cancelled by the reuse, so it never stops the server.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(serverStop).not.toHaveBeenCalled()
  })

  it('does not stop while other panels remain', async () => {
    await mgr.joinPanel(EXT, WS, 'p1', fakeSender(1))
    await mgr.joinPanel(EXT, WS, 'p2', fakeSender(1))
    mgr.leavePanel(EXT, WS, 'p1')
    expect(mgr.getState(EXT, WS)).toBe('READY')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(serverStop).not.toHaveBeenCalled()
  })

  it('rejoin within grace cancels the timer (no restart, no stop)', async () => {
    await mgr.joinPanel(EXT, WS, 'p1', fakeSender(1))
    mgr.leavePanel(EXT, WS, 'p1')
    expect(mgr.getState(EXT, WS)).toBe('GRACE')

    // Rejoin before grace expires.
    await mgr.joinPanel(EXT, WS, 'p1', fakeSender(1))
    expect(mgr.getState(EXT, WS)).toBe('READY')

    await vi.advanceTimersByTimeAsync(30_000)
    expect(serverStop).not.toHaveBeenCalled()
    // Still the original server (no re-start).
    expect(serverStart).toHaveBeenCalledTimes(1)
  })

  it('crash auto-restarts, capping at 2 per 60s then ERROR', async () => {
    await mgr.joinPanel(EXT, WS, 'p1', fakeSender(1))
    expect(serverStart).toHaveBeenCalledTimes(1)

    // Crash 1 → restart (start #2).
    onExitCb!('id', 1, null)
    await vi.runAllTimersAsync()
    expect(serverStart).toHaveBeenCalledTimes(2)
    expect(mgr.getState(EXT, WS)).toBe('READY')

    // Crash 2 → restart (start #3).
    onExitCb!('id', 1, null)
    await vi.runAllTimersAsync()
    expect(serverStart).toHaveBeenCalledTimes(3)
    expect(mgr.getState(EXT, WS)).toBe('READY')

    // Crash 3 → budget exhausted → ERROR, no further start.
    onExitCb!('id', 1, null)
    await vi.runAllTimersAsync()
    expect(serverStart).toHaveBeenCalledTimes(3)
    expect(mgr.getState(EXT, WS)).toBe('ERROR')
  })

  it('manual restart from ERROR resets the budget', async () => {
    await mgr.joinPanel(EXT, WS, 'p1', fakeSender(1))
    onExitCb!('id', 1, null)
    await vi.runAllTimersAsync()
    onExitCb!('id', 1, null)
    await vi.runAllTimersAsync()
    onExitCb!('id', 1, null)
    await vi.runAllTimersAsync()
    expect(mgr.getState(EXT, WS)).toBe('ERROR')

    const res = await mgr.restart(EXT, WS)
    expect(res.ok).toBe(true)
    expect(mgr.getState(EXT, WS)).toBe('READY')
  })

  it('surfaces a start failure as ERROR with the captured output', async () => {
    serverStart.mockImplementation(async (_opts, onOutput) => {
      onOutput('id', 'stderr', 'boom: cannot bind')
      throw new Error('ready probe timed out')
    })
    await expect(mgr.ensureServer(EXT, WS)).rejects.toThrow(/ready probe timed out/)
    expect(mgr.getState(EXT, WS)).toBe('ERROR')
    expect(mgr.getOutput(EXT, WS)).toContain('boom: cannot bind')
  })

  it('stopForExtension stops every session for that extension across workspaces', async () => {
    // Same extension in two workspaces, plus a different extension.
    await mgr.joinPanel(EXT, 'ws1', 'p1', fakeSender(1))
    await mgr.joinPanel(EXT, 'ws2', 'p2', fakeSender(1))
    await mgr.joinPanel('cate.other', 'ws1', 'p3', fakeSender(1))
    expect(serverStart).toHaveBeenCalledTimes(3)

    await mgr.stopForExtension(EXT)

    // Both EXT sessions stopped + dropped; the other extension untouched.
    expect(serverStop).toHaveBeenCalledTimes(2)
    expect(mgr.getState(EXT, 'ws1')).toBeNull()
    expect(mgr.getState(EXT, 'ws2')).toBeNull()
    expect(mgr.getState('cate.other', 'ws1')).toBe('READY')
  })

  it('stopForExtension clears a pending grace timer (no double stop on expiry)', async () => {
    await mgr.joinPanel(EXT, WS, 'p1', fakeSender(1))
    mgr.leavePanel(EXT, WS, 'p1')
    expect(mgr.getState(EXT, WS)).toBe('GRACE')

    await mgr.stopForExtension(EXT)
    expect(serverStop).toHaveBeenCalledTimes(1)
    expect(mgr.getState(EXT, WS)).toBeNull()

    // Grace timer was cleared, so advancing past it does not stop again.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(serverStop).toHaveBeenCalledTimes(1)
  })

  it('does not spawn a server for a disabled extension (disable raced the join)', async () => {
    // A disable() lands after the panel joined but before startServer runs (both
    // serialize on the per-key lock). startServer must re-check enable state and
    // bail, so no server is left running for the disabled extension.
    isEnabledState.enabled = false
    await expect(mgr.joinPanel(EXT, WS, 'p1', fakeSender(1))).rejects.toThrow(/disabled/)
    expect(serverStart).not.toHaveBeenCalled()
    expect(mgr.getState(EXT, WS)).not.toBe('READY')
  })

  it('stopForExtension is a no-op when no session matches', async () => {
    await mgr.stopForExtension('cate.nope')
    expect(serverStop).not.toHaveBeenCalled()
  })

  it('disposeForRuntime drops sessions on the dead runtime and tears down CATE_API without an RPC stop', async () => {
    // Two live sessions on runtime 'local' (the fake runtime's id).
    await mgr.joinPanel(EXT, 'ws1', 'p1', fakeSender(1))
    await mgr.joinPanel(EXT, 'ws2', 'p2', fakeSender(1))
    expect(mgr.getState(EXT, 'ws1')).toBe('READY')
    expect(mgr.getState(EXT, 'ws2')).toBe('READY')
    // Each start opened a CATE_API reverse listener.
    expect(fakeRuntime.tunnel.listen).toHaveBeenCalledTimes(2)

    // Runtime disconnects: the daemon + its children are already gone, so we
    // must NOT try to stop the server over the (dead) RPC — just release state.
    await mgr.disposeForRuntime('local')

    // Sessions removed so the next join rebuilds fresh against the reconnected
    // runtime (no stale READY+handle short-circuit → no 502).
    expect(mgr.getState(EXT, 'ws1')).toBeNull()
    expect(mgr.getState(EXT, 'ws2')).toBeNull()
    // No server.stop RPC against the dead runtime.
    expect(serverStop).not.toHaveBeenCalled()
    // The CATE_API reverse listener was torn down for each session.
    expect(fakeRuntime.tunnel.stopListen).toHaveBeenCalledTimes(2)
  })

  it('disposeForRuntime leaves sessions on OTHER runtimes untouched', async () => {
    await mgr.joinPanel(EXT, WS, 'p1', fakeSender(1))
    expect(mgr.getState(EXT, WS)).toBe('READY')
    // A drop on some other runtime id must not touch our 'local' session.
    await mgr.disposeForRuntime('srv_other')
    expect(mgr.getState(EXT, WS)).toBe('READY')
    expect(serverStop).not.toHaveBeenCalled()
  })

  it('disposeForRuntime clears a pending grace timer (no stop on expiry)', async () => {
    await mgr.joinPanel(EXT, WS, 'p1', fakeSender(1))
    mgr.leavePanel(EXT, WS, 'p1')
    expect(mgr.getState(EXT, WS)).toBe('GRACE')

    await mgr.disposeForRuntime('local')
    expect(mgr.getState(EXT, WS)).toBeNull()

    // The grace timer was cleared with the session, so advancing past it does
    // nothing (no stop, and no throw on a now-missing session).
    await vi.advanceTimersByTimeAsync(30_000)
    expect(serverStop).not.toHaveBeenCalled()
  })

  it('disposeForWebContents leaves panels owned by the destroyed window', async () => {
    await mgr.joinPanel(EXT, WS, 'p1', fakeSender(1))
    await mgr.joinPanel(EXT, WS, 'p2', fakeSender(2))

    // Window 1 closes: p1 leaves, but p2 keeps the server READY.
    mgr.disposeForWebContents(1)
    expect(mgr.getState(EXT, WS)).toBe('READY')

    // Window 2 closes: last panel leaves → grace.
    mgr.disposeForWebContents(2)
    expect(mgr.getState(EXT, WS)).toBe('GRACE')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(serverStop).toHaveBeenCalledTimes(1)
  })
})
