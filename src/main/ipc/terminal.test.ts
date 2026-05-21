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

import { describe, it, expect, vi, beforeEach } from 'vitest'

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
