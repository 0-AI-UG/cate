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

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}))

// The terminal IPC module pulls in a few neighbors at module init; stub them
// out so importing the module under test is side-effect-free.
vi.mock('./pathValidation', () => ({ validateCwd: (p: string) => p }))
vi.mock('./terminalLogger', () => ({
  getOrCreateLogger: () => ({ append: () => {}, flush: () => {}, readAll: () => '' }),
  removeLogger: () => {},
  flushAll: () => {},
  disposeAll: () => {},
  TerminalLogger: { getLogDir: () => '/tmp' },
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
vi.mock('../logger', () => ({ default: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } }))

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

  // Regression: begin is called twice during detach (-1 placeholder, then the
  // real window id). The first call's 5s fallback timer must be CLEARED so it
  // can't fire mid-transfer and revert ownership to the source. On a slow ack
  // (> 5s) the fallback must complete to the TARGET, not the source.
  it('re-begin clears the stale timer; the fallback completes to the target, not the source', async () => {
    const { beginTerminalTransfer, acknowledgeTerminalTransfer, reassignTerminalWindow, getTerminalOwner } =
      await import('./terminal')

    const ptyId = 'pty-rebegin'
    reassignTerminalWindow(ptyId, 100) // source
    beginTerminalTransfer(ptyId, -1) // placeholder
    beginTerminalTransfer(ptyId, 200) // real target

    vi.advanceTimersByTime(5000) // fallback fires (ack hasn't arrived yet)
    expect(getTerminalOwner(ptyId)).toBe(200) // completed to target, NOT reverted to 100

    acknowledgeTerminalTransfer(ptyId) // late ack is a harmless no-op
    expect(getTerminalOwner(ptyId)).toBe(200)
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
