// Behavioral tests for terminalLifecycle — the renderer-side spawn / adopt /
// release / dispose state machine behind every terminal panel. These drive the
// real module (real registryState maps, real terminalSettings/terminalInput)
// through its public functions, with the heavy collaborators (xterm, IPC
// bridge, zustand stores, session module) stubbed the same way
// terminalRegistry.test.ts does.

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Fakes / shared spies. Mock factories run lazily (on the first dynamic import
// in beforeAll), so referencing these module-level consts is safe.
// ---------------------------------------------------------------------------

interface FakeTerminalShape {
  writes: string[]
  disposeCount: number
  options: Record<string, unknown>
  cols: number
  rows: number
}
const terminalInstances: FakeTerminalShape[] = []

vi.mock('@xterm/xterm', () => {
  class FakeTerminal {
    public writes: string[] = []
    public disposeCount = 0
    public options: Record<string, unknown>
    public buffer = { active: { baseY: 0, cursorY: 0, viewportY: 0, getLine: () => undefined } }
    public element: HTMLElement | undefined
    public cols = 80
    public rows = 24
    constructor(options: Record<string, unknown> = {}) {
      this.options = options
      terminalInstances.push(this as unknown as FakeTerminalShape)
    }
    loadAddon(): void {}
    open(container: HTMLElement): void {
      this.element = document.createElement('div')
      container.appendChild(this.element)
    }
    write(s: string): void { this.writes.push(s) }
    onData(): { dispose: () => void } { return { dispose: () => {} } }
    onResize(): { dispose: () => void } { return { dispose: () => {} } }
    onTitleChange(): { dispose: () => void } { return { dispose: () => {} } }
    hasSelection(): boolean { return false }
    attachCustomKeyEventHandler(): void {}
    registerLinkProvider(): { dispose: () => void } { return { dispose: () => {} } }
    refresh(): void {}
    focus(): void {}
    scrollToBottom(): void {}
    resize(c: number, r: number): void { this.cols = c; this.rows = r }
    dispose(): void { this.disposeCount++ }
  }
  return { Terminal: FakeTerminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { proposeDimensions() { return { cols: 80, rows: 24 } } fit() {} dispose() {} },
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class { onContextLoss() {} dispose() {} },
}))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class { findNext() { return false } findPrevious() { return false } clearDecorations() {} },
}))
vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class { serialize() { return '' } dispose() {} },
}))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class { dispose() {} },
}))

const statusRegisterTerminal = vi.fn()
const statusUnregisterTerminal = vi.fn()
vi.mock('../../stores/statusStore', () => ({
  useStatusStore: {
    getState: () => ({
      registerTerminal: statusRegisterTerminal,
      unregisterTerminal: statusUnregisterTerminal,
      workspaces: {},
    }),
  },
  setTerminalWorkspaceResolver: vi.fn(),
}))
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      terminalFontFamily: '',
      terminalFontSize: 0,
      terminalScrollback: 2000,
      terminalCursorBlink: false,
      terminalScrollSpeed: 1.0,
      terminalContrast: 4.5,
      terminalOptionIsMeta: true,
    }),
    subscribe: () => () => {},
  },
}))
vi.mock('../../stores/appStore', () => ({
  awaitWorkspaceSync: async () => {},
  useAppStore: {
    getState: () => ({ workspaces: [], updatePanelTitleFromAgent: vi.fn() }),
  },
}))
const replayTerminalLog = vi.fn(async () => {})
vi.mock('../workspace/session', () => ({
  get replayTerminalLog() { return replayTerminalLog },
  terminalRestoreData: new Map(),
}))
vi.mock('./terminalUrlOpen', () => ({ openTerminalUrl: () => {} }))
vi.mock('./terminalFileLinkProvider', () => ({
  createFileLinkProvider: () => ({ provideLinks: (_y: number, cb: (l?: unknown[]) => void) => cb(undefined) }),
  resolveLinkRoot: () => undefined,
}))
vi.mock('../agent/agentScreenDetector', () => ({
  noteAgentTitle: vi.fn(),
  noteAgentSpinnerByte: vi.fn(),
  noteAgentPresence: vi.fn(),
  forgetAgentTracker: vi.fn(),
}))
vi.mock('../themeManager', () => ({
  getActiveTheme: () => ({ terminal: {} }),
  subscribeTheme: () => () => {},
}))
vi.mock('../logger', () => ({
  default: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
}))

// ---------------------------------------------------------------------------
// IPC bridge spies. Data/exit listeners are captured so tests can inject
// synthetic PTY traffic; the returned disposers are spies so teardown can be
// asserted.
// ---------------------------------------------------------------------------

let ptyCounter = 0
const terminalCreate = vi.fn(async () => `pty-${++ptyCounter}`)
const terminalWrite = vi.fn()
const terminalResize = vi.fn()
const terminalKill = vi.fn(async () => undefined)
const shellRegisterTerminal = vi.fn(async () => undefined)
const shellUnregisterTerminal = vi.fn(async () => undefined)
const panelTransferAck = vi.fn(async () => undefined)
const settingsGet = vi.fn(async () => '')

const dataListeners: Array<(id: string, data: string) => void> = []
const exitListeners: Array<(id: string, code: number) => void> = []
const dataDisposers: Array<ReturnType<typeof vi.fn>> = []
const captureDataListener = (cb: (id: string, data: string) => void) => {
  dataListeners.push(cb)
  const disposer = vi.fn()
  dataDisposers.push(disposer)
  return disposer
}
const captureExitListener = (cb: (id: string, code: number) => void) => {
  exitListeners.push(cb)
  return () => {}
}
const onTerminalData = vi.fn(captureDataListener)
const onTerminalExit = vi.fn(captureExitListener)

function fireData(ptyId: string, data: string): void {
  for (const cb of [...dataListeners]) cb(ptyId, data)
}
function fireExit(ptyId: string, code: number): void {
  for (const cb of [...exitListeners]) cb(ptyId, code)
}

// ---------------------------------------------------------------------------
// Module handles — loaded dynamically AFTER mocks and consts exist.
// ---------------------------------------------------------------------------

let LC: typeof import('./terminalLifecycle')
let RS: typeof import('./registryState')
let restoreData: Map<string, { cwd?: string; replayFromId?: string }>

beforeAll(async () => {
  LC = await import('./terminalLifecycle')
  RS = await import('./registryState')
  restoreData = (await import('./terminalRestoreData')).terminalRestoreData
})

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      terminalCreate, terminalWrite, terminalResize, terminalKill,
      onTerminalData, onTerminalExit,
      shellRegisterTerminal, shellUnregisterTerminal,
      settingsGet, panelTransferAck,
    },
  })
  // Drain module-singleton state left by a prior test.
  for (const panelId of [...RS.registry.keys()]) LC.dispose(panelId)
  RS.pendingTransfers.clear()
  RS.failures.clear()
  restoreData.clear()
  terminalInstances.length = 0
  dataListeners.length = 0
  exitListeners.length = 0
  dataDisposers.length = 0
  terminalCreate.mockClear()
  terminalCreate.mockImplementation(async () => `pty-${++ptyCounter}`)
  terminalWrite.mockClear()
  terminalResize.mockClear()
  terminalKill.mockClear()
  terminalKill.mockImplementation(async () => undefined)
  shellRegisterTerminal.mockClear()
  shellRegisterTerminal.mockImplementation(async () => undefined)
  shellUnregisterTerminal.mockClear()
  shellUnregisterTerminal.mockImplementation(async () => undefined)
  panelTransferAck.mockClear()
  panelTransferAck.mockImplementation(async () => undefined)
  settingsGet.mockClear()
  settingsGet.mockImplementation(async () => '')
  // restoreMocks: true wipes vi.fn implementations after each test — reinstall
  // the listener-capturing implementations.
  onTerminalData.mockClear()
  onTerminalData.mockImplementation(captureDataListener)
  onTerminalExit.mockClear()
  onTerminalExit.mockImplementation(captureExitListener)
  statusRegisterTerminal.mockClear()
  statusUnregisterTerminal.mockClear()
  replayTerminalLog.mockClear()
  replayTerminalLog.mockImplementation(async () => {})
})

// ===========================================================================
// Spawn happy path
// ===========================================================================
describe('spawn → wire → dispose happy path', () => {
  it('spawns one PTY, registers identity, routes data, and dispose tears it all down exactly once', async () => {
    terminalCreate.mockResolvedValueOnce('pty-happy')

    const entry = await LC.getOrCreate('panel-happy', { workspaceId: 'ws-1' })

    // One PTY spawn, standard 80x24 defaults (real fit happens on attach).
    expect(terminalCreate).toHaveBeenCalledTimes(1)
    expect(terminalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ cols: 80, rows: 24, workspaceId: 'ws-1' }),
    )

    // Registry + identity bimap populated, entry alive.
    expect(RS.has('panel-happy')).toBe(true)
    expect(entry.ptyId).toBe('pty-happy')
    expect(RS.ptyIdForPanel('panel-happy')).toBe('pty-happy')
    expect(RS.panelIdForPty('pty-happy')).toBe('panel-happy')
    expect(entry.alive).toBe(true)

    // Listener wiring: shell monitor + status store registered.
    expect(shellRegisterTerminal).toHaveBeenCalledWith('pty-happy')
    expect(statusRegisterTerminal).toHaveBeenCalledWith('pty-happy', 'ws-1')

    // PTY data is routed into THIS xterm only when the ptyId matches.
    const fake = terminalInstances[0]
    fireData('pty-happy', 'hello from pty')
    fireData('pty-other', 'not for us')
    expect(fake.writes).toContain('hello from pty')
    expect(fake.writes).not.toContain('not for us')

    // Dispose: kills the PTY, unregisters everywhere, removes the entry,
    // disposes the xterm exactly once, and removes the IPC data listener.
    LC.dispose('panel-happy')
    expect(terminalKill).toHaveBeenCalledTimes(1)
    expect(terminalKill).toHaveBeenCalledWith('pty-happy')
    expect(shellUnregisterTerminal).toHaveBeenCalledWith('pty-happy')
    expect(statusUnregisterTerminal).toHaveBeenCalledWith('pty-happy')
    expect(RS.has('panel-happy')).toBe(false)
    expect(RS.panelIdForPty('pty-happy')).toBeNull()
    expect(fake.disposeCount).toBe(1)
    expect(dataDisposers[0]).toHaveBeenCalledTimes(1)
  })

  it('returns the same in-flight entry for concurrent getOrCreate calls and spawns once', async () => {
    const [a, b] = await Promise.all([
      LC.getOrCreate('panel-race', { workspaceId: 'ws-1' }),
      LC.getOrCreate('panel-race', { workspaceId: 'ws-1' }),
    ])
    expect(a).toBe(b)
    expect(terminalCreate).toHaveBeenCalledTimes(1)
    LC.dispose('panel-race')
  })

  it('writes initialInput into the terminal after spawn', async () => {
    await LC.getOrCreate('panel-input', { workspaceId: 'ws-1', initialInput: 'npm test\r' })
    expect(terminalInstances[0].writes).toContain('npm test\r')
    LC.dispose('panel-input')
  })

  it('uses the session-restore cwd and replays the scrollback log for restored terminals', async () => {
    restoreData.set('panel-restored', { cwd: '/tmp/restored-project', replayFromId: 'old-pty' })

    await LC.getOrCreate('panel-restored', { workspaceId: 'ws-1' })

    expect(terminalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp/restored-project' }),
    )
    expect(replayTerminalLog).toHaveBeenCalledWith('panel-restored')
    LC.dispose('panel-restored')
  })

  it('marks the entry dead (not removed) and prints the exit line when the PTY exits on its own', async () => {
    terminalCreate.mockResolvedValueOnce('pty-exits')
    const entry = await LC.getOrCreate('panel-exits', { workspaceId: 'ws-1' })

    fireExit('pty-exits', 137)

    // Membership != liveness: the entry lingers so the buffer stays readable.
    expect(RS.has('panel-exits')).toBe(true)
    expect(entry.alive).toBe(false)
    const exitLine = terminalInstances[0].writes.find((w) => w.includes('Process exited with code 137'))
    expect(exitLine).toBeTruthy()
    LC.dispose('panel-exits')
  })
})

// ===========================================================================
// Adopt path (cross-window transfer): reconnect to an existing PTY
// ===========================================================================
describe('adopt path — pending transfer reconnects without spawning', () => {
  it('adopts the existing ptyId, wires listeners, and defers scrollback + ack', async () => {
    LC.setPendingTransfer('panel-adopt', 'pty-transferred', 'CAPTURED-SCROLLBACK')

    const entry = await LC.getOrCreate('panel-adopt', { workspaceId: 'ws-2' })

    // No new PTY — the live one is adopted.
    expect(terminalCreate).not.toHaveBeenCalled()
    expect(entry.ptyId).toBe('pty-transferred')
    expect(RS.panelIdForPty('pty-transferred')).toBe('panel-adopt')
    expect(RS.pendingTransfers.has('panel-adopt')).toBe(false) // consumed

    // Listeners are wired to the EXISTING pty immediately.
    expect(shellRegisterTerminal).toHaveBeenCalledWith('pty-transferred')
    fireData('pty-transferred', 'live output')
    expect(terminalInstances[0].writes).toContain('live output')

    // Scrollback + ack are deferred until attach()/finalizeReconnect — writing
    // them now would land in an unopened 80x24 buffer.
    expect(entry.pendingReconnect).toEqual({ ptyId: 'pty-transferred', scrollback: 'CAPTURED-SCROLLBACK' })
    expect(terminalInstances[0].writes).not.toContain('CAPTURED-SCROLLBACK')
    expect(panelTransferAck).not.toHaveBeenCalled()

    LC.dispose('panel-adopt')
  })

  it('finalizeReconnect nudges winsize, writes scrollback, acks once, then settles size', async () => {
    vi.useFakeTimers()
    try {
      LC.setPendingTransfer('panel-fin', 'pty-fin', 'SB')
      const entry = await LC.getOrCreate('panel-fin', { workspaceId: 'ws-2' })

      LC.finalizeReconnect('panel-fin')

      // SIGWINCH nudge: one COLUMN short of the fitted size (80x24 fake
      // default). Cols, not rows — a rows change makes Ink TUIs leak a
      // duplicate frame into scrollback when their frame fills the viewport.
      expect(terminalResize).toHaveBeenCalledWith('pty-fin', 79, 24)
      expect(terminalInstances[0].writes).toContain('SB')
      expect(panelTransferAck).toHaveBeenCalledTimes(1)
      expect(panelTransferAck).toHaveBeenCalledWith('pty-fin')
      expect(entry.pendingReconnect).toBeUndefined()

      // 150ms later it settles to the real fitted size.
      vi.advanceTimersByTime(150)
      expect(terminalResize).toHaveBeenLastCalledWith('pty-fin', 80, 24)

      // Idempotent: a second finalize is a no-op (no double ack / rewrite).
      LC.finalizeReconnect('panel-fin')
      expect(panelTransferAck).toHaveBeenCalledTimes(1)
      expect(terminalInstances[0].writes.filter((w) => w === 'SB')).toHaveLength(1)

      LC.dispose('panel-fin')
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips the settle resize if the panel was disposed during the 150ms window', async () => {
    vi.useFakeTimers()
    try {
      LC.setPendingTransfer('panel-gone', 'pty-gone', undefined)
      await LC.getOrCreate('panel-gone', { workspaceId: 'ws-2' })
      LC.finalizeReconnect('panel-gone')
      terminalResize.mockClear()

      LC.dispose('panel-gone')
      vi.advanceTimersByTime(200)

      expect(terminalResize).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ===========================================================================
// Release (transfer source) + double-release
// ===========================================================================
describe('release — transfer source lets go without killing the PTY', () => {
  it('removes the entry and identity but never kills the PTY; xterm disposed exactly once', async () => {
    terminalCreate.mockResolvedValueOnce('pty-keep')
    await LC.getOrCreate('panel-rel', { workspaceId: 'ws-1' })

    LC.release('panel-rel')

    expect(RS.has('panel-rel')).toBe(false)
    expect(RS.panelIdForPty('pty-keep')).toBeNull()
    expect(terminalKill).not.toHaveBeenCalled()          // PTY lives on in main
    expect(shellUnregisterTerminal).not.toHaveBeenCalled()
    expect(terminalInstances[0].disposeCount).toBe(1)    // local xterm torn down
    expect(dataDisposers[0]).toHaveBeenCalledTimes(1)    // IPC listener removed
  })

  it('double-release is a safe no-op (no double-dispose, no throw)', async () => {
    await LC.getOrCreate('panel-rel2', { workspaceId: 'ws-1' })

    LC.release('panel-rel2')
    expect(() => LC.release('panel-rel2')).not.toThrow()

    expect(terminalInstances[0].disposeCount).toBe(1)
    expect(dataDisposers[0]).toHaveBeenCalledTimes(1)
  })

  it('double-dispose is a safe no-op (PTY killed exactly once)', async () => {
    terminalCreate.mockResolvedValueOnce('pty-d2')
    await LC.getOrCreate('panel-d2', { workspaceId: 'ws-1' })

    LC.dispose('panel-d2')
    expect(() => LC.dispose('panel-d2')).not.toThrow()

    expect(terminalKill).toHaveBeenCalledTimes(1)
    expect(terminalInstances[0].disposeCount).toBe(1)
  })

  it('release clears a pending transfer so it cannot hijack a later fresh mount', async () => {
    await LC.getOrCreate('panel-hijack', { workspaceId: 'ws-1' })
    LC.setPendingTransfer('panel-hijack', 'pty-stale', 'old-sb')

    LC.release('panel-hijack')
    expect(RS.pendingTransfers.has('panel-hijack')).toBe(false)

    // A later fresh mount spawns a NEW pty instead of adopting the stale one.
    terminalCreate.mockResolvedValueOnce('pty-fresh-again')
    const entry = await LC.getOrCreate('panel-hijack', { workspaceId: 'ws-1' })
    expect(entry.ptyId).toBe('pty-fresh-again')
    LC.dispose('panel-hijack')
  })
})

// ===========================================================================
// Remount armed but the panel never remounts
// ===========================================================================
describe('remount armed but never completed', () => {
  it('an unconsumed pending transfer stays deposited indefinitely', async () => {
    // Arm: source window released, transfer deposited in this window... and
    // then the receiving panel never mounts (e.g. drop aborted mid-flight).
    LC.setPendingTransfer('panel-never', 'pty-orphan', 'sb')

    // Nothing in the lifecycle module ever expires this entry.
    expect(RS.pendingTransfers.get('panel-never')).toEqual({ ptyId: 'pty-orphan', scrollback: 'sb' })

    // BUG?: pendingTransfers has no TTL/cancel path. If the receiving panel
    // never mounts, the PTY in main stays un-acked (main keeps buffering its
    // output) and a MUCH later mount of the same panelId would silently adopt
    // the stale ptyId instead of spawning fresh. Worse: dispose() and release()
    // both early-return when there is no registry entry — BEFORE their
    // pendingTransfers.delete line — so for a never-mounted panel there is NO
    // cleanup path at all except actually mounting it (getOrCreate consumes it).
    LC.dispose('panel-never')
    LC.release('panel-never')
    expect(RS.pendingTransfers.has('panel-never')).toBe(true) // still armed!

    // Mounting is the only consumer — and it adopts the (possibly stale) pty.
    const entry = await LC.getOrCreate('panel-never', { workspaceId: 'ws-1' })
    expect(entry.ptyId).toBe('pty-orphan')
    expect(RS.pendingTransfers.has('panel-never')).toBe(false)
    LC.dispose('panel-never')
  })

  it('an adopted-but-never-attached terminal is fully reclaimed by dispose, though the transfer is never acked', async () => {
    LC.setPendingTransfer('panel-noattach', 'pty-noattach', 'sb')
    const entry = await LC.getOrCreate('panel-noattach', { workspaceId: 'ws-2' })
    expect(entry.pendingReconnect).toBeTruthy()

    // The panel unmounts before attach() ever ran finalizeReconnect.
    LC.dispose('panel-noattach')

    // dispose() kills the adopted PTY, so main-side state is reclaimed; the
    // ack is never sent, which is moot since the PTY is dead. No registry leak.
    expect(terminalKill).toHaveBeenCalledWith('pty-noattach')
    expect(panelTransferAck).not.toHaveBeenCalled()
    expect(RS.has('panel-noattach')).toBe(false)
    expect(RS.panelIdForPty('pty-noattach')).toBeNull()
  })
})

// ===========================================================================
// Spawn failure / IPC error path
// ===========================================================================
describe('spawn failure', () => {
  it('records the failure, notifies, and removes the zombie entry so retry can rebuild', async () => {
    const notified: string[] = []
    const unsub = RS.subscribeFailure((id) => notified.push(id))
    terminalCreate.mockRejectedValueOnce(new Error('spawn failed: no shell'))

    await LC.getOrCreate('panel-fail', { workspaceId: 'ws-1' })

    // No zombie: the half-built entry is gone, the xterm disposed.
    expect(RS.has('panel-fail')).toBe(false)
    expect(terminalInstances[0].disposeCount).toBe(1)
    // Failure recorded + observers notified.
    expect(RS.getFailure('panel-fail')).toMatch(/spawn failed/i)
    expect(notified).toContain('panel-fail')

    // Retry: a fresh getOrCreate clears the failure and spawns for real.
    notified.length = 0
    terminalCreate.mockResolvedValueOnce('pty-retry-ok')
    const entry = await LC.getOrCreate('panel-fail', { workspaceId: 'ws-1' })
    expect(entry.ptyId).toBe('pty-retry-ok')
    expect(RS.getFailure('panel-fail')).toBeNull()
    expect(notified).toContain('panel-fail') // re-render notification on retry
    expect(RS.has('panel-fail')).toBe(true)

    LC.dispose('panel-fail')
    unsub()
  })

  it('kills a PTY that finishes spawning after the panel was already disposed', async () => {
    let resolveSpawn: (id: string) => void = () => {}
    terminalCreate.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveSpawn = resolve }),
    )

    const pending = LC.getOrCreate('panel-late', { workspaceId: 'ws-1' })
    expect(RS.has('panel-late')).toBe(true) // entry registered synchronously

    // Panel torn down while the IPC spawn is still in flight. ptyId is still ''
    // so dispose cannot kill anything yet.
    LC.dispose('panel-late')
    expect(terminalKill).not.toHaveBeenCalled()

    // Wait until getOrCreate has progressed past its earlier awaits and the
    // (deferred) spawn IPC is actually in flight, then let it land — the
    // orphan PTY must be killed, not leaked.
    await vi.waitFor(() => expect(terminalCreate).toHaveBeenCalled())
    resolveSpawn('pty-late')
    await pending

    expect(terminalKill).toHaveBeenCalledWith('pty-late')
    expect(RS.has('panel-late')).toBe(false)
    expect(RS.panelIdForPty('pty-late')).toBeNull()
  })
})

// ===========================================================================
// Workspace boundaries
// ===========================================================================
describe('workspace boundaries', () => {
  it('remounting a panelId under a different workspace kills the old PTY and spawns fresh', async () => {
    terminalCreate.mockResolvedValueOnce('pty-ws-a')
    await LC.getOrCreate('panel-move', { workspaceId: 'ws-A' })

    terminalCreate.mockResolvedValueOnce('pty-ws-b')
    const entry = await LC.getOrCreate('panel-move', { workspaceId: 'ws-B' })

    expect(terminalKill).toHaveBeenCalledWith('pty-ws-a') // old one torn down
    expect(entry.ptyId).toBe('pty-ws-b')
    expect(RS.workspaceIdForPanel('panel-move')).toBe('ws-B')
    expect(RS.panelIdForPty('pty-ws-a')).toBeNull()
    LC.dispose('panel-move')
  })

  it('disposeWorkspace tears down only that workspace\'s terminals', async () => {
    terminalCreate.mockResolvedValueOnce('pty-w1a')
    await LC.getOrCreate('panel-w1a', { workspaceId: 'ws-1' })
    terminalCreate.mockResolvedValueOnce('pty-w1b')
    await LC.getOrCreate('panel-w1b', { workspaceId: 'ws-1' })
    terminalCreate.mockResolvedValueOnce('pty-w2')
    await LC.getOrCreate('panel-w2', { workspaceId: 'ws-2' })

    LC.disposeWorkspace('ws-1')

    expect(RS.has('panel-w1a')).toBe(false)
    expect(RS.has('panel-w1b')).toBe(false)
    expect(RS.has('panel-w2')).toBe(true)
    expect(terminalKill).toHaveBeenCalledWith('pty-w1a')
    expect(terminalKill).toHaveBeenCalledWith('pty-w1b')
    expect(terminalKill).not.toHaveBeenCalledWith('pty-w2')

    LC.dispose('panel-w2')
  })
})
