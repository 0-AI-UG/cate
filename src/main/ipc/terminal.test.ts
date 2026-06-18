// Regression: cross-window drag DROP must transfer terminal PTY ownership.
//
// When a target window claims a cross-window drop, main's
// CROSS_WINDOW_DRAG_DROP handler must call beginTerminalTransfer so that the
// subsequent panelTransferAck (sent by the target after wiring its IPC
// listeners in reconnectTerminal) actually flips terminalOwners to the target
// window. Otherwise PTY data keeps flowing to the (now-released) source
// window — the user-visible "gray terminal, no input, no output" symptom.
//
// These tests mock node-pty + electron just enough to exercise the
// beginTerminalTransfer / acknowledgeTerminalTransfer pair against the real
// owner map exported from terminal.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}))

// Captured ipcMain.handle map so tests can invoke a handler directly.
const handlers = new Map<string, (...args: unknown[]) => unknown>()
const clipboardWriteText = vi.fn()
vi.mock('electron', () => ({
  clipboard: {
    writeText: clipboardWriteText,
  },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }),
    on: vi.fn(),
  },
}))

// getLogDir is read inside the scrollback handlers; let tests point it at a
// real temp dir so the async fs round-trip exercises the filesystem.
let logDir = '/tmp'

// The terminal IPC module pulls in a few neighbors at module init; stub them
// out so importing the module under test is side-effect-free.
vi.mock('./pathValidation', () => ({ validateCwd: (p: string) => p }))
vi.mock('./terminalLogger', () => ({
  getOrCreateLogger: () => ({ append: () => {}, flush: () => {}, readAll: () => '' }),
  removeLogger: () => {},
  flushAll: () => {},
  disposeAll: () => {},
  TerminalLogger: { getLogDir: () => logDir },
}))
vi.mock('../windowRegistry', () => {
  const sent: Array<{ windowId: number; channel: string; args: unknown[] }> = []
  return {
    sendToWindow: (windowId: number, channel: string, ...args: unknown[]) => {
      sent.push({ windowId, channel, args })
    },
    windowFromEvent: () => null,
    onWindowClosed: () => {},
    __sent: sent,
  }
})
vi.mock('../shellEnv', () => ({ getShellEnv: () => ({}) }))
vi.mock('../shellResolver', () => ({ resolveShell: () => ({ path: '/bin/sh', fallback: false }) }))

// Hoisted spies shared with the module mocks below (vi.mock factories are
// hoisted above all other code, so the spies they reference must be too).
const diag = vi.hoisted(() => ({ warn: vi.fn(), ptyCreate: vi.fn() }))
vi.mock('../logger', () => ({ default: { warn: diag.warn, info: () => {}, error: () => {}, debug: () => {} } }))

// A fake runtime whose process.create is the hoisted spy, so the instant-exit
// tests can drive onData/onExit deterministically through the real spawnTerminal.
vi.mock('../runtime/runtimeManager', () => ({
  runtimes: {
    resolve: () => ({ validateCwd: (p: string) => p, process: { create: diag.ptyCreate } }),
    disposeAll: () => Promise.resolve(),
  },
}))
vi.mock('../runtime/locator', () => ({ parseLocator: (cwd: string) => ({ runtimeId: 'local', path: cwd }) }))

// --- terminalLifecycle (renderer) deps, stubbed so getOrCreate/dispose run
//     without a real xterm/DOM/store stack. registryState is left REAL so the
//     dispose-during-creation path exercises the actual registry bookkeeping.
const makeFakeTerminal = () => ({
  parser: {
    registerOscHandler: () => ({ dispose: () => {} }),
  },
  loadAddon: () => {},
  registerLinkProvider: () => ({ dispose: () => {} }),
  write: () => {},
  dispose: () => {},
})
vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn(() => makeFakeTerminal()) }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => ({ dispose: () => {} })) }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: vi.fn(() => ({})) }))
vi.mock('@xterm/addon-serialize', () => ({ SerializeAddon: vi.fn(() => ({ dispose: () => {} })) }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(() => ({})) }))
vi.mock('../../renderer/lib/logger', () => ({ default: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } }))
vi.mock('../../renderer/lib/terminal/terminalSettings', () => ({
  getTerminalFontFamily: () => 'mono',
  getTerminalBaseFontSize: () => 12,
  getScrollback: () => 1000,
  getScrollSensitivity: () => 1,
  getContrastRatio: () => 1,
  getOptionIsMeta: () => false,
  effectiveCursorBlink: () => false,
}))
vi.mock('../../renderer/lib/terminal/terminalInput', () => ({
  createTerminalLinkHandler: () => () => {},
  makeTerminalKeyEventHandler: () => () => true,
}))
vi.mock('../../renderer/lib/terminal/terminalFileLinkProvider', () => ({
  createFileLinkProvider: () => ({}),
  resolveLinkRoot: () => undefined,
}))
vi.mock('../../renderer/lib/themeManager', () => ({ getActiveTheme: () => ({ terminal: {} }) }))
vi.mock('../../renderer/stores/statusStore', () => ({
  useStatusStore: { getState: () => ({ unregisterTerminal: () => {}, workspaces: {} }) },
  setTerminalWorkspaceResolver: () => {},
}))
vi.mock('../../renderer/stores/appStore', () => ({
  awaitWorkspaceSync: () => Promise.resolve(),
  useAppStore: { getState: () => ({ updatePanelTitleFromAgent: () => {} }) },
}))
vi.mock('../../renderer/lib/workspace/session', () => ({ replayTerminalLog: () => Promise.resolve() }))

describe('cross-window drop terminal ownership transfer', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  // End-to-end pin of the IPC handler's contract on the cross-window drop
  // path. The exported `handleCrossWindowDropTerminalTransfer` helper is what
  // the CROSS_WINDOW_DRAG_DROP handler MUST call so the subsequent
  // panelTransferAck (from the target window's reconnectTerminal) flips
  // terminalOwners[ptyId] to the target. Without it, ownership stays at the
  // source window, the source's xterm was released by the source-side commit,
  // and PTY output is dropped — the "gray terminal" symptom.
  it('handleCrossWindowDropTerminalTransfer + ack routes future PTY output to the target window', async () => {
    const mod = await import('./terminal')
    const {
      handleCrossWindowDropTerminalTransfer,
      acknowledgeTerminalTransfer,
      reassignTerminalWindow,
      getTerminalOwner,
    } = mod

    // Seed an owner — mimics createTerminal having registered the source window.
    const ptyId = 'pty-cross-window'
    reassignTerminalWindow(ptyId, 100) // source window
    expect(getTerminalOwner(ptyId)).toBe(100)

    // Handler-level call (what CROSS_WINDOW_DRAG_DROP must invoke on the
    // claim path before notifying source), then target ACKs after wiring
    // its listeners in reconnectTerminal.
    handleCrossWindowDropTerminalTransfer(ptyId, 200)
    acknowledgeTerminalTransfer(ptyId)

    expect(getTerminalOwner(ptyId)).toBe(200)
  })

  // Negative case documenting the underlying mechanism: ack alone is a no-op
  // if no transfer was started, so ownership stays on a (potentially-dead)
  // source window — the gray-terminal mechanism.
  it('panelTransferAck without a prior begin is a no-op (regression guard)', async () => {
    const mod = await import('./terminal')
    const { acknowledgeTerminalTransfer, reassignTerminalWindow, getTerminalOwner } = mod

    const ptyId = 'pty-no-begin'
    reassignTerminalWindow(ptyId, 100)
    acknowledgeTerminalTransfer(ptyId)
    expect(getTerminalOwner(ptyId)).toBe(100)
  })
})

describe('terminal transfer robustness', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Detach buffers BEFORE the new window exists (beginTerminalBuffering), then
  // points the transfer at the real window id (setTerminalTransferTarget). The
  // buffering call's fallback timer must be CLEARED by the retarget so it can't
  // fire mid-transfer and flush back to the source. On a slow ack (> 5s) the
  // fallback must complete to the TARGET, not the source.
  it('retarget clears the buffering timer; the fallback completes to the target, not the source', async () => {
    const { beginTerminalBuffering, setTerminalTransferTarget, acknowledgeTerminalTransfer, reassignTerminalWindow, getTerminalOwner } =
      await import('./terminal')

    const ptyId = 'pty-retarget'
    reassignTerminalWindow(ptyId, 100) // source
    beginTerminalBuffering(ptyId) // window doesn't exist yet
    setTerminalTransferTarget(ptyId, 200) // real target

    vi.advanceTimersByTime(5000) // fallback fires (ack hasn't arrived yet)
    expect(getTerminalOwner(ptyId)).toBe(200) // completed to target, NOT reverted to 100

    acknowledgeTerminalTransfer(ptyId) // late ack is a harmless no-op
    expect(getTerminalOwner(ptyId)).toBe(200)
  })

  // Window creation failed (or never happened): a destination-less transfer
  // must abort back to the owner — ownership unchanged, ack remains a no-op.
  it('buffering with no destination aborts back to the owner on timeout', async () => {
    const { beginTerminalBuffering, acknowledgeTerminalTransfer, reassignTerminalWindow, getTerminalOwner } =
      await import('./terminal')

    const ptyId = 'pty-no-destination'
    reassignTerminalWindow(ptyId, 100)
    beginTerminalBuffering(ptyId)

    acknowledgeTerminalTransfer(ptyId) // stray ack while target-less is ignored
    expect(getTerminalOwner(ptyId)).toBe(100)

    vi.advanceTimersByTime(5000) // abort fallback fires
    expect(getTerminalOwner(ptyId)).toBe(100) // never moved

    acknowledgeTerminalTransfer(ptyId) // state gone — no-op
    expect(getTerminalOwner(ptyId)).toBe(100)
  })

  // Explicit abort (DRAG_DETACH's createWindow threw): transfer state is torn
  // down immediately and ownership stays at the source.
  it('abortTerminalTransfer ends the transfer with ownership unchanged', async () => {
    const { beginTerminalBuffering, abortTerminalTransfer, acknowledgeTerminalTransfer, reassignTerminalWindow, getTerminalOwner } =
      await import('./terminal')

    const ptyId = 'pty-abort'
    reassignTerminalWindow(ptyId, 100)
    beginTerminalBuffering(ptyId)
    abortTerminalTransfer(ptyId)

    expect(getTerminalOwner(ptyId)).toBe(100)
    acknowledgeTerminalTransfer(ptyId) // no-op after abort
    expect(getTerminalOwner(ptyId)).toBe(100)
  })

  // Source window closes mid-transfer → ownership follows the panel to the target.
  it('completes a transfer to the target when the source window closes', async () => {
    const { beginTerminalTransfer, handleWindowClosedTerminalTransfers, reassignTerminalWindow, getTerminalOwner } =
      await import('./terminal')

    const ptyId = 'pty-src-close'
    reassignTerminalWindow(ptyId, 100) // source owner
    beginTerminalTransfer(ptyId, 200) // target
    handleWindowClosedTerminalTransfers(100) // source window gone

    expect(getTerminalOwner(ptyId)).toBe(200)
  })

  // Target window dies before acking → abandon the transfer, owner unchanged.
  it('abandons a transfer when the target window closes (owner stays at source)', async () => {
    const { beginTerminalTransfer, handleWindowClosedTerminalTransfers, acknowledgeTerminalTransfer, reassignTerminalWindow, getTerminalOwner } =
      await import('./terminal')

    const ptyId = 'pty-tgt-close'
    reassignTerminalWindow(ptyId, 100)
    beginTerminalTransfer(ptyId, 200)
    handleWindowClosedTerminalTransfers(200) // target window gone

    expect(getTerminalOwner(ptyId)).toBe(100)
    acknowledgeTerminalTransfer(ptyId) // state already gone → no-op
    expect(getTerminalOwner(ptyId)).toBe(100)
  })
})

describe('scrollback IPC async fs round-trip', () => {
  beforeEach(() => {
    vi.resetModules()
    handlers.clear()
  })
  afterEach(async () => {
    await fs.rm(logDir, { recursive: true, force: true }).catch(() => {})
  })

  // The save/read handlers were converted from sync fs to fs.promises so they
  // can't stall every window inside ipcMain.handle. Pin that the handler
  // contract still round-trips: TERMINAL_SCROLLBACK_SAVE persists content (and
  // creates the dir) and TERMINAL_LOG_READ reads it straight back.
  it('save then read returns the same content (dir created on demand)', async () => {
    logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-scrollback-'))
    // Remove it so the save handler's mkdir(recursive) has to recreate it.
    await fs.rm(logDir, { recursive: true, force: true })

    const { TERMINAL_SCROLLBACK_SAVE, TERMINAL_LOG_READ } = await import('../../shared/ipc-channels')
    await import('./terminal').then((m) => m.registerHandlers())

    const save = handlers.get(TERMINAL_SCROLLBACK_SAVE)!
    const read = handlers.get(TERMINAL_LOG_READ)!
    expect(save).toBeTypeOf('function')
    expect(read).toBeTypeOf('function')

    const ptyId = 'pty-scrollback'
    const content = 'line one\nline two\n[31mred[0m\n'

    await save({}, ptyId, content)
    const got = await read({}, ptyId)

    expect(got).toBe(content)
  })

  // A missing scrollback file falls through (raw-log mock returns ''), so the
  // read handler yields null rather than throwing on the absent file.
  it('read returns null when no scrollback file exists', async () => {
    logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-scrollback-'))
    const { TERMINAL_LOG_READ } = await import('../../shared/ipc-channels')
    await import('./terminal').then((m) => m.registerHandlers())

    const read = handlers.get(TERMINAL_LOG_READ)!
    const got = await read({}, 'pty-never-saved')
    expect(got).toBeNull()
  })
})

describe('terminal clipboard IPC', () => {
  beforeEach(() => {
    vi.resetModules()
    handlers.clear()
    clipboardWriteText.mockClear()
  })

  it('writes terminal clipboard text through Electron clipboard', async () => {
    const { TERMINAL_CLIPBOARD_WRITE } = await import('../../shared/ipc-channels')
    await import('./terminal').then((m) => m.registerHandlers())

    const writeClipboard = handlers.get(TERMINAL_CLIPBOARD_WRITE)
    if (!writeClipboard) throw new Error('clipboard IPC handler was not registered')

    await writeClipboard({}, 'copied from remote tmux')

    expect(clipboardWriteText).toHaveBeenCalledWith('copied from remote tmux')
  })
})

describe('terminalLifecycle dispose-during-creation', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  // Regression: a terminal panel disposed while its PTY spawn is still in flight
  // leaked the PTY. dispose() couldn't kill it (the entry's ptyId was still '')
  // and the post-create bail-out only tore down the xterm. The bail-out must now
  // kill the freshly-created PTY itself so it doesn't linger.
  it('kills the freshly-created PTY when the panel was disposed mid-creation', async () => {
    let resolveCreate!: (ptyId: string) => void
    const createPromise = new Promise<string>((res) => { resolveCreate = res })

    const terminalKill = vi.fn(() => Promise.resolve())
    const electronAPI = {
      settingsGet: vi.fn(() => Promise.resolve('/bin/zsh')),
      terminalCreate: vi.fn(() => createPromise),
      terminalKill,
      shellUnregisterTerminal: vi.fn(() => Promise.resolve()),
    }
    ;(globalThis as unknown as { window: unknown }).window = { electronAPI }

    const lifecycle = await import('../../renderer/lib/terminal/terminalLifecycle')

    const panelId = 'panel-disposed-mid-create'
    const pending = lifecycle.getOrCreate(panelId, { workspaceId: 'ws-1' })

    // Let the synchronous part run + the settingsGet/terminalCreate awaits queue.
    await Promise.resolve()
    await Promise.resolve()

    // Dispose while terminalCreate is still pending: ptyId is '' so dispose()
    // can't kill anything yet.
    lifecycle.dispose(panelId)
    expect(terminalKill).not.toHaveBeenCalled()

    // PTY finally comes up — the bail-out path must kill it.
    resolveCreate('pty-freshly-created')
    await pending

    expect(terminalKill).toHaveBeenCalledWith('pty-freshly-created')
  })
})

// ===========================================================================
// Instant-exit diagnostics (#401): a fresh shell that exits 0 immediately with
// no output never became a session. spawnTerminal logs it with the resolved
// shell so the cause is captured for the next report.
// ===========================================================================
describe('instant-exit diagnostics (#401)', () => {
  beforeEach(() => {
    vi.resetModules()
    diag.warn.mockClear()
    diag.ptyCreate.mockReset()
  })

  // Spawn through the real TERMINAL_CREATE handler; return the captured PTY
  // callbacks so the test fires data/exit deterministically (after create
  // resolves, so the resolved shell is recorded).
  async function spawn(shell = '/bin/zsh'): Promise<{
    onData: (id: string, d: string) => void
    onExit: (id: string, c: number) => void
  }> {
    let cbs!: { onData: (id: string, d: string) => void; onExit: (id: string, c: number) => void }
    diag.ptyCreate.mockImplementation(async (_opts: unknown, onData: never, onExit: never) => {
      cbs = { onData, onExit }
      return { id: 'pty-x', pid: 123, shell }
    })
    const mod = await import('./terminal')
    mod.registerHandlers()
    await handlers.get('terminal:create')!({}, { cols: 80, rows: 24 })
    return cbs
  }

  it('warns (with the resolved shell) when a fresh terminal exits 0 immediately with no output', async () => {
    const { onExit } = await spawn('/bin/zsh')
    onExit('pty-x', 0)
    expect(diag.warn).toHaveBeenCalled()
    expect(diag.warn.mock.calls[0].join(' ')).toContain('/bin/zsh')
  })

  it('does not warn when the shell produced output before exiting 0', async () => {
    const { onData, onExit } = await spawn()
    onData('pty-x', 'prompt$ ')
    onExit('pty-x', 0)
    expect(diag.warn).not.toHaveBeenCalled()
  })

  it('does not warn for a non-zero exit code', async () => {
    const { onExit } = await spawn()
    onExit('pty-x', 1)
    expect(diag.warn).not.toHaveBeenCalled()
  })
})
