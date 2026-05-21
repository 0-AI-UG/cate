// Regression tests for the user-reported "terminal goes gray after multi-step
// drag round trip" bug. The bug scenario relies on global invariants of the
// registry that aren't covered by helper-level unit tests:
//
//   - getOrCreate(panelId) must short-circuit when an entry already exists,
//     but the pending-transfer slot for that panelId MUST NOT leak so that
//     unrelated future mounts don't accidentally reconnect against a stale ptyId.
//
// These tests exercise the real terminalRegistry module with the heavy
// xterm/IPC/store collaborators stubbed out via vi.mock.

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Shared event log so tests can assert ordering of cross-cutting calls
// (terminal.open, terminal.write, panelTransferAck) during reconnect+attach.
const events: string[] = []
beforeEach(() => { events.length = 0 })

vi.mock('@xterm/xterm', () => {
  class FakeTerminal {
    public writes: string[] = []
    public options: { theme?: unknown } = {}
    public buffer = { active: { baseY: 0, cursorY: 0, getLine: () => undefined } }
    public element: HTMLElement | undefined
    public cols = 80
    public rows = 24
    loadAddon(): void { /* no-op */ }
    open(container: HTMLElement): void {
      this.element = document.createElement('div')
      container.appendChild(this.element)
      events.push('open')
    }
    write(s: string): void {
      this.writes.push(s)
      events.push(`write:${s.slice(0, 24)}`)
    }
    onData(): { dispose: () => void } { return { dispose: () => {} } }
    onResize(): { dispose: () => void } { return { dispose: () => {} } }
    attachCustomKeyEventHandler(): void { /* no-op */ }
    refresh(): void { /* no-op */ }
    scrollToBottom(): void { /* no-op */ }
    resize(c: number, r: number): void { this.cols = c; this.rows = r }
    dispose(): void { /* no-op */ }
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

vi.mock('../stores/statusStore', () => ({
  useStatusStore: { getState: () => ({ registerTerminal: vi.fn(), unregisterTerminal: vi.fn() }) },
}))
vi.mock('../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      terminalScrollback: 2000,
      defaultTerminalTheme: undefined,
      terminalCustomThemes: [],
    }),
    subscribe: () => () => {},
  },
}))
vi.mock('../stores/appStore', () => ({
  awaitWorkspaceSync: async () => {},
}))
vi.mock('./session', () => ({
  terminalRestoreData: new Map(),
  replayTerminalLog: async () => {},
}))
vi.mock('./terminalUrlAutoOpen', () => ({
  scanTerminalChunkForUrls: () => {},
  clearTerminalUrlBuffer: () => {},
}))
vi.mock('./themeManager', () => ({
  getResolvedTheme: () => 'dark-warm',
  subscribeTheme: () => () => {},
}))
vi.mock('./logger', () => ({ default: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } }))

// Track how many fresh PTYs are spawned vs reconnect-mode entries that adopt
// a pre-existing ptyId. The bug manifests when a leaked pending-transfer
// causes a fresh getOrCreate to silently go down the reconnect path.
const terminalCreate = vi.fn(async () => 'pty-fresh')
const panelTransferAck = vi.fn(async (_id: string) => undefined as undefined)
const shellRegisterTerminal = vi.fn(async () => undefined)

beforeEach(() => {
  terminalCreate.mockClear()
  panelTransferAck.mockClear()
  shellRegisterTerminal.mockClear()
  panelTransferAck.mockImplementation(async (id: string) => {
    events.push(`ack:${id}`)
  })
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      terminalCreate,
      terminalWrite: vi.fn(),
      terminalResize: vi.fn(),
      terminalKill: vi.fn(async () => undefined),
      onTerminalData: vi.fn(() => () => {}),
      onTerminalExit: vi.fn(() => () => {}),
      shellRegisterTerminal,
      shellUnregisterTerminal: vi.fn(async () => undefined),
      settingsGet: vi.fn(async () => ''),
      panelTransferAck,
    },
  })
})

describe('terminalRegistry pending-transfer cleanup invariant', () => {
  // Establish a baseline: a fresh getOrCreate with a pending transfer reconnects.
  // The panelTransferAck is deferred to attach() now — see the
  // "reconnectTerminal defers scrollback + ack" suite below for the why.
  it('consumes a pending transfer when no entry exists (reconnect path baseline)', async () => {
    const { terminalRegistry } = await import('./terminalRegistry')
    terminalRegistry.setPendingTransfer('panel-baseline', 'pty-existing', 'hello-scrollback')

    const entry = await terminalRegistry.getOrCreate('panel-baseline', { workspaceId: 'ws-1' })

    expect(entry.ptyId).toBe('pty-existing')
    expect(terminalCreate).not.toHaveBeenCalled()

    terminalRegistry.dispose('panel-baseline')
  })

  // Core regression: when getOrCreate short-circuits because an entry already
  // exists in this renderer (same-window canvas drag from dock), a pending
  // transfer that was deposited for that panelId is NOT consumed by the short-
  // circuit and is left in the pendingTransfers map. The next time the panel
  // is genuinely unmounted-and-remounted (e.g. workspace switch, or any
  // codepath that disposes then re-creates), that stale transfer will be
  // consumed, blowing away the live PTY wiring.
  it('clears pending transfer when getOrCreate short-circuits on an existing entry', async () => {
    const { terminalRegistry } = await import('./terminalRegistry')

    // Seed an existing live entry.
    terminalCreate.mockResolvedValueOnce('pty-live')
    const first = await terminalRegistry.getOrCreate('panel-leak', { workspaceId: 'ws-1' })
    expect(first.ptyId).toBe('pty-live')

    // Same-window remount path deposits a pending transfer for the SAME panel.
    terminalRegistry.setPendingTransfer('panel-leak', 'pty-live', 'live-scrollback')

    // The remount triggers getOrCreate; since the entry still exists in the
    // registry (TerminalPanel unmount used detach(), not release()), the call
    // short-circuits and returns the same entry without going through
    // reconnectTerminal.
    const second = await terminalRegistry.getOrCreate('panel-leak', { workspaceId: 'ws-1' })
    expect(second).toBe(first)

    // Now simulate a future, unrelated dispose+remount of the same panelId
    // (e.g. user closes the panel and re-opens, or a workspace switch tears
    // down the entry). If the pending transfer leaked, the registry will go
    // into reconnect mode with the STALE ptyId 'pty-live' instead of spawning
    // a fresh PTY.
    terminalRegistry.dispose('panel-leak')
    terminalCreate.mockResolvedValueOnce('pty-fresh-after-dispose')
    const third = await terminalRegistry.getOrCreate('panel-leak', { workspaceId: 'ws-1' })

    expect(third.ptyId).toBe('pty-fresh-after-dispose')
    expect(terminalCreate).toHaveBeenCalledTimes(2)
    // If the leak existed, panelTransferAck would have been called against
    // the stale 'pty-live' during the third getOrCreate.
    expect(panelTransferAck).not.toHaveBeenCalled()

    terminalRegistry.dispose('panel-leak')
  })
})

// Regression: dragging a terminal panel OUT of the main window into a fresh
// detached window produces a visually broken terminal — prompts appear at
// random column positions, content is wrapped weirdly (see user-reported
// screenshot).
//
// Root cause: `reconnectTerminal` writes the captured scrollback into the new
// xterm Terminal AND calls `panelTransferAck` before the terminal has been
// `open()`ed into its real container. xterm's defaults are 80x24 at that
// point, so:
//   - scrollback captured from the source's wider/taller buffer wraps when
//     written into the unopened 80-col xterm;
//   - the PTY-data flush triggered by panelTransferAck lands in the same
//     ill-sized buffer.
//
// Once `attach()` later opens the terminal into the real container and
// safeFit() resizes, the wrapping damage is already baked into the buffer
// and any TUI on the alt-screen has been desynced.
//
// The contract we want to pin: reconnect *defers* both the scrollback write
// and the panelTransferAck until `attach()` has opened+fitted the terminal
// to its real container.
describe('reconnectTerminal defers scrollback + ack until attach()', () => {
  it('does not write scrollback or ack before attach() is called', async () => {
    const { terminalRegistry } = await import('./terminalRegistry')
    terminalRegistry.setPendingTransfer('panel-detach', 'pty-source', 'captured scrollback')

    await terminalRegistry.getOrCreate('panel-detach', { workspaceId: 'ws-1' })

    // The new xterm has NOT been opened (no real container yet) and the PTY
    // buffer in main is still being held back. Writing scrollback or acking
    // now would push content into a 80x24 default-sized buffer.
    expect(events).not.toContain('open')
    const wroteScrollback = events.some((e) => e.startsWith('write:captured'))
    expect(wroteScrollback).toBe(false)
    expect(panelTransferAck).not.toHaveBeenCalled()

    terminalRegistry.dispose('panel-detach')
  })

  it('opens, then writes scrollback, then acks — in that order — after attach()', async () => {
    const { terminalRegistry } = await import('./terminalRegistry')
    terminalRegistry.setPendingTransfer('panel-detach', 'pty-source', 'captured scrollback')

    await terminalRegistry.getOrCreate('panel-detach', { workspaceId: 'ws-1' })

    const container = document.createElement('div')
    // Give the container non-zero dimensions so tryFit() doesn't bail.
    Object.defineProperty(container, 'offsetWidth', { value: 800, configurable: true })
    Object.defineProperty(container, 'offsetHeight', { value: 600, configurable: true })
    document.body.appendChild(container)

    terminalRegistry.attach('panel-detach', container)

    // Wait two animation frames — attach() defers safeFit + finalization
    // into requestAnimationFrame to let layout settle.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    const openIdx = events.indexOf('open')
    const writeIdx = events.findIndex((e) => e.startsWith('write:captured'))
    const ackIdx = events.findIndex((e) => e.startsWith('ack:pty-source'))

    expect(openIdx).toBeGreaterThanOrEqual(0)
    expect(writeIdx).toBeGreaterThan(openIdx)
    expect(ackIdx).toBeGreaterThan(writeIdx)

    document.body.removeChild(container)
    terminalRegistry.dispose('panel-detach')
  })

  it('finalization runs only once across multiple attach() calls', async () => {
    const { terminalRegistry } = await import('./terminalRegistry')
    terminalRegistry.setPendingTransfer('panel-detach', 'pty-source', 'captured scrollback')

    await terminalRegistry.getOrCreate('panel-detach', { workspaceId: 'ws-1' })

    const container = document.createElement('div')
    Object.defineProperty(container, 'offsetWidth', { value: 800, configurable: true })
    Object.defineProperty(container, 'offsetHeight', { value: 600, configurable: true })
    document.body.appendChild(container)

    terminalRegistry.attach('panel-detach', container)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    // Re-attach into the same container (e.g. IntersectionObserver toggling).
    terminalRegistry.attach('panel-detach', container)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    expect(panelTransferAck).toHaveBeenCalledTimes(1)
    const scrollbackWrites = events.filter((e) => e.startsWith('write:captured'))
    expect(scrollbackWrites).toHaveLength(1)

    document.body.removeChild(container)
    terminalRegistry.dispose('panel-detach')
  })
})
