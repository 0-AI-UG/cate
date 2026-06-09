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
  // Faithful-enough fake: models the buffer viewportY/baseY scroll indices and
  // a real `.xterm-viewport` DOM child (so the registry's scroll listener and
  // line-index save/restore both exercise real code paths). scrollToLine /
  // scrollToBottom mutate viewportY the way xterm does.
  class FakeTerminal {
    public writes: string[] = []
    public options: { theme?: unknown } = {}
    public buffer = { active: { baseY: 0, cursorY: 0, viewportY: 0, getLine: () => undefined } }
    public element: HTMLElement | undefined
    public cols = 80
    public rows = 24
    loadAddon(): void { /* no-op */ }
    open(container: HTMLElement): void {
      this.element = document.createElement('div')
      // Real xterm renders a `.xterm-viewport` scrollable child; the registry
      // reads/writes its scrollTop and queries it on attach/detach.
      const viewport = document.createElement('div')
      viewport.className = 'xterm-viewport'
      this.element.appendChild(viewport)
      container.appendChild(this.element)
      events.push('open')
    }
    write(s: string): void {
      this.writes.push(s)
      events.push(`write:${s.slice(0, 24)}`)
    }
    onData(): { dispose: () => void } { return { dispose: () => {} } }
    onResize(): { dispose: () => void } { return { dispose: () => {} } }
    onTitleChange(): { dispose: () => void } { return { dispose: () => {} } }
    hasSelection(): boolean { return false }
    attachCustomKeyEventHandler(): void { /* no-op */ }
    registerLinkProvider(): { dispose: () => void } { return { dispose: () => {} } }
    refresh(): void { /* no-op */ }
    focus(): void { /* no-op */ }
    scrollToLine(line: number): void {
      this.buffer.active.viewportY = Math.max(0, Math.min(line, this.buffer.active.baseY))
    }
    scrollToBottom(): void { this.buffer.active.viewportY = this.buffer.active.baseY }
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

vi.mock('../../stores/statusStore', () => ({
  useStatusStore: { getState: () => ({ registerTerminal: vi.fn(), unregisterTerminal: vi.fn() }) },
  setTerminalWorkspaceResolver: vi.fn(),
}))
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      terminalScrollback: 2000,
      terminalCursorBlink: false,
      terminalScrollSpeed: 1.0,
      terminalContrast: 4.5,
    }),
    subscribe: () => () => {},
  },
}))
vi.mock('../../stores/appStore', () => ({
  awaitWorkspaceSync: async () => {},
  useAppStore: { getState: () => ({ workspaces: [] }) },
}))
vi.mock('../workspace/session', () => ({
  terminalRestoreData: new Map(),
  replayTerminalLog: async () => {},
}))
vi.mock('./terminalUrlOpen', () => ({
  openTerminalUrl: () => {},
}))
vi.mock('../themeManager', () => ({
  getActiveTheme: () => ({ terminal: {} }),
  subscribeTheme: () => () => {},
}))
vi.mock('../logger', () => ({ default: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } }))

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

describe('isTerminalPasteChord', () => {
  const kd = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)

  it('matches Ctrl+V and Ctrl+Shift+V on non-mac', async () => {
    const { isTerminalPasteChord } = await import('./terminalRegistry')
    expect(isTerminalPasteChord(kd({ ctrlKey: true, key: 'v' }), false)).toBe(true)
    expect(isTerminalPasteChord(kd({ ctrlKey: true, shiftKey: true, key: 'V' }), false)).toBe(true)
  })

  it('ignores Ctrl+V on macOS (it is the terminal "literal next" key there)', async () => {
    const { isTerminalPasteChord } = await import('./terminalRegistry')
    expect(isTerminalPasteChord(kd({ ctrlKey: true, key: 'v' }), true)).toBe(false)
  })

  it('does not match when alt or meta is also held, or without ctrl', async () => {
    const { isTerminalPasteChord } = await import('./terminalRegistry')
    expect(isTerminalPasteChord(kd({ ctrlKey: true, altKey: true, key: 'v' }), false)).toBe(false)
    expect(isTerminalPasteChord(kd({ metaKey: true, key: 'v' }), false)).toBe(false)
    expect(isTerminalPasteChord(kd({ key: 'v' }), false)).toBe(false)
    expect(isTerminalPasteChord(kd({ ctrlKey: true, key: 'c' }), false)).toBe(false)
  })

  it('only matches keydown, not keyup', async () => {
    const { isTerminalPasteChord } = await import('./terminalRegistry')
    const up = new KeyboardEvent('keyup', { ctrlKey: true, key: 'v' })
    expect(isTerminalPasteChord(up, false)).toBe(false)
  })
})

describe('isTerminalCopyChord', () => {
  const kd = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)
  const withSelection = { hasSelection: () => true }
  const noSelection = { hasSelection: () => false }

  it('matches Ctrl+C on non-mac when terminal has a selection', async () => {
    const { isTerminalCopyChord } = await import('./terminalRegistry')
    expect(isTerminalCopyChord(kd({ ctrlKey: true, key: 'c' }), withSelection, false)).toBe(true)
    expect(isTerminalCopyChord(kd({ ctrlKey: true, shiftKey: true, key: 'C' }), withSelection, false)).toBe(true)
  })

  it('does not match when there is no selection (SIGINT should go through)', async () => {
    const { isTerminalCopyChord } = await import('./terminalRegistry')
    expect(isTerminalCopyChord(kd({ ctrlKey: true, key: 'c' }), noSelection, false)).toBe(false)
  })

  it('ignores Ctrl+C on macOS (Cmd+C handles copy; Ctrl+C is SIGINT)', async () => {
    const { isTerminalCopyChord } = await import('./terminalRegistry')
    expect(isTerminalCopyChord(kd({ ctrlKey: true, key: 'c' }), withSelection, true)).toBe(false)
  })

  it('does not match when alt or meta is also held, or without ctrl', async () => {
    const { isTerminalCopyChord } = await import('./terminalRegistry')
    expect(isTerminalCopyChord(kd({ ctrlKey: true, altKey: true, key: 'c' }), withSelection, false)).toBe(false)
    expect(isTerminalCopyChord(kd({ metaKey: true, key: 'c' }), withSelection, false)).toBe(false)
    expect(isTerminalCopyChord(kd({ key: 'c' }), withSelection, false)).toBe(false)
  })

  it('only matches keydown, not keyup', async () => {
    const { isTerminalCopyChord } = await import('./terminalRegistry')
    const up = new KeyboardEvent('keyup', { ctrlKey: true, key: 'c' })
    expect(isTerminalCopyChord(up, withSelection, false)).toBe(false)
  })
})

describe('clampScrollSensitivity', () => {
  it('passes through 1.0 (xterm default)', async () => {
    const { clampScrollSensitivity } = await import('./terminalRegistry')
    expect(clampScrollSensitivity(1.0)).toBe(1.0)
  })

  it('allows the slider bounds 0.25 and 3.0', async () => {
    const { clampScrollSensitivity } = await import('./terminalRegistry')
    expect(clampScrollSensitivity(0.25)).toBe(0.25)
    expect(clampScrollSensitivity(3.0)).toBe(3.0)
  })

  it('clamps below the floor up to 0.25 and above the ceiling down to 3.0', async () => {
    const { clampScrollSensitivity } = await import('./terminalRegistry')
    expect(clampScrollSensitivity(0.1)).toBe(0.25)
    expect(clampScrollSensitivity(5)).toBe(3.0)
  })

  it('falls back to 1.0 for invalid or missing values', async () => {
    const { clampScrollSensitivity } = await import('./terminalRegistry')
    expect(clampScrollSensitivity(0)).toBe(1.0)
    expect(clampScrollSensitivity(-1)).toBe(1.0)
    expect(clampScrollSensitivity(NaN)).toBe(1.0)
    expect(clampScrollSensitivity(undefined as unknown as number)).toBe(1.0)
  })
})

describe('clampContrastRatio', () => {
  it('passes through 4.5 (the WCAG-AA default)', async () => {
    const { clampContrastRatio } = await import('./terminalRegistry')
    expect(clampContrastRatio(4.5)).toBe(4.5)
  })

  it('allows the slider bounds 1 (off) and 21', async () => {
    const { clampContrastRatio } = await import('./terminalRegistry')
    expect(clampContrastRatio(1)).toBe(1)
    expect(clampContrastRatio(21)).toBe(21)
  })

  it('clamps above the ceiling down to 21 and below the floor up to 1', async () => {
    const { clampContrastRatio } = await import('./terminalRegistry')
    expect(clampContrastRatio(30)).toBe(21)
    expect(clampContrastRatio(0.5)).toBe(1)
  })

  it('falls back to 4.5 for invalid or missing values', async () => {
    const { clampContrastRatio } = await import('./terminalRegistry')
    expect(clampContrastRatio(0)).toBe(4.5)
    expect(clampContrastRatio(-1)).toBe(4.5)
    expect(clampContrastRatio(NaN)).toBe(4.5)
    expect(clampContrastRatio(undefined as unknown as number)).toBe(4.5)
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

// Regression: switching dock terminal tabs via the tab bar resets the
// re-opened terminal's scroll to the very TOP.
//
// Root cause: DockTabStack only renders the active tab, so switching tabs
// UNMOUNTS the outgoing TerminalPanel and MOUNTS the incoming one. Mount calls
// terminalRegistry.attach(), which re-parents the SAME xterm DOM element into
// the new container via appendChild — and the browser zeroes a scrollable
// element's scrollTop when it is re-inserted into the DOM. attach()'s
// fitAndScroll() then measures "was at bottom" from the freshly-zeroed
// viewport (so it reads false for a scrolled-up terminal) and skips
// scrollToBottom, leaving the viewport pinned at the top. The focus-based
// restoreScroll() never compensates because dock panels are never the canvas
// "focused node" (nodeId === panelId, which canvasStore.focusedNodeId never
// equals).
//
// Contract: detach() must SAVE the buffer viewport line index (robust to the
// scrollTop reset), and attach() must RESTORE it after fit settles — through
// the attach/detach path that every tab switch exercises, not only canvas
// focus.
describe('scroll position survives a hide/show (dock tab switch) cycle', () => {
  // xterm's real typings declare viewportY/baseY as readonly; the fake models
  // them as mutable so tests can drive scroll state. Cast through the buffer
  // shape to write them without fighting the readonly types.
  function setBuffer(
    terminal: { buffer: { active: { baseY: number; viewportY: number } } },
    baseY: number,
    viewportY: number,
  ): void {
    const active = terminal.buffer.active as { baseY: number; viewportY: number }
    active.baseY = baseY
    active.viewportY = viewportY
  }

  async function mountAndAttach(panelId: string) {
    const { terminalRegistry } = await import('./terminalRegistry')
    await terminalRegistry.getOrCreate(panelId, { workspaceId: 'ws-1' })
    const container = document.createElement('div')
    Object.defineProperty(container, 'offsetWidth', { value: 800, configurable: true })
    Object.defineProperty(container, 'offsetHeight', { value: 600, configurable: true })
    document.body.appendChild(container)
    terminalRegistry.attach(panelId, container)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    return { terminalRegistry, container }
  }

  it('restores a scrolled-up viewport line after detach + re-attach', async () => {
    const { terminalRegistry, container } = await mountAndAttach('panel-scroll')
    const entry = terminalRegistry.getEntry('panel-scroll')!

    // Terminal has scrollback (baseY > 0) and the user scrolled UP to line 30
    // (not at bottom).
    setBuffer(entry.terminal, 100, 30)

    // Tab switches AWAY: TerminalPanel unmounts → detach(). This must capture
    // the line index BEFORE the element leaves its container.
    terminalRegistry.detach('panel-scroll', container)

    // Simulate the browser zeroing scrollTop and the buffer viewport on the
    // detached element (what really happens on re-insertion / a fresh frame).
    setBuffer(entry.terminal, 100, 0)

    // Tab switches BACK: TerminalPanel re-mounts → attach() into a new
    // container. After fit settles, the saved line must be restored.
    const container2 = document.createElement('div')
    Object.defineProperty(container2, 'offsetWidth', { value: 800, configurable: true })
    Object.defineProperty(container2, 'offsetHeight', { value: 600, configurable: true })
    document.body.appendChild(container2)
    terminalRegistry.attach('panel-scroll', container2)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    expect(entry.terminal.buffer.active.viewportY).toBe(30)

    document.body.removeChild(container)
    document.body.removeChild(container2)
    terminalRegistry.dispose('panel-scroll')
  })

  it('keeps a bottom-pinned terminal stuck to the bottom across a hide/show cycle', async () => {
    const { terminalRegistry, container } = await mountAndAttach('panel-bottom')
    const entry = terminalRegistry.getEntry('panel-bottom')!

    // Following output: viewportY === baseY (at bottom).
    setBuffer(entry.terminal, 100, 100)

    terminalRegistry.detach('panel-bottom', container)

    // More output arrives while hidden — baseY grows; an at-bottom terminal
    // should snap to the NEW bottom on re-show, not to the old line index.
    setBuffer(entry.terminal, 140, 0)

    const container2 = document.createElement('div')
    Object.defineProperty(container2, 'offsetWidth', { value: 800, configurable: true })
    Object.defineProperty(container2, 'offsetHeight', { value: 600, configurable: true })
    document.body.appendChild(container2)
    terminalRegistry.attach('panel-bottom', container2)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    expect(entry.terminal.buffer.active.viewportY).toBe(140)

    document.body.removeChild(container)
    document.body.removeChild(container2)
    terminalRegistry.dispose('panel-bottom')
  })
})

// ===========================================================================
// Terminal identity bimap (panelId<->ptyId<->workspaceId) + alive flag.
// The registry is the single owner of terminal identity; statusStore no longer
// keeps a parallel ptyId->workspaceId map.
// ===========================================================================
describe('terminal identity bimap', () => {
  it('maps panelId<->ptyId and panelId->workspaceId after getOrCreate', async () => {
    const { terminalRegistry } = await import('./terminalRegistry')
    terminalCreate.mockResolvedValueOnce('pty-A')
    await terminalRegistry.getOrCreate('panel-A', { workspaceId: 'ws-A' })

    expect(terminalRegistry.ptyIdForPanel('panel-A')).toBe('pty-A')
    expect(terminalRegistry.panelIdForPty('pty-A')).toBe('panel-A')
    expect(terminalRegistry.workspaceIdForPanel('panel-A')).toBe('ws-A')
    expect(terminalRegistry.workspaceIdForPty('pty-A')).toBe('ws-A')

    terminalRegistry.dispose('panel-A')
  })

  it('clears both directions on dispose', async () => {
    const { terminalRegistry } = await import('./terminalRegistry')
    terminalCreate.mockResolvedValueOnce('pty-B')
    await terminalRegistry.getOrCreate('panel-B', { workspaceId: 'ws-B' })
    expect(terminalRegistry.panelIdForPty('pty-B')).toBe('panel-B')

    terminalRegistry.dispose('panel-B')
    expect(terminalRegistry.ptyIdForPanel('panel-B')).toBeNull()
    expect(terminalRegistry.panelIdForPty('pty-B')).toBeNull()
    expect(terminalRegistry.workspaceIdForPty('pty-B')).toBeUndefined()
  })

  it('clears the reverse mapping on release (transfer source) without killing the pty', async () => {
    const { terminalRegistry } = await import('./terminalRegistry')
    terminalCreate.mockResolvedValueOnce('pty-C')
    await terminalRegistry.getOrCreate('panel-C', { workspaceId: 'ws-C' })
    expect(terminalRegistry.panelIdForPty('pty-C')).toBe('panel-C')

    terminalRegistry.release('panel-C')
    expect(terminalRegistry.panelIdForPty('pty-C')).toBeNull()
    expect(terminalRegistry.ptyIdForPanel('panel-C')).toBeNull()
  })

  it('adopts the transferred ptyId on the reconnect path', async () => {
    const { terminalRegistry } = await import('./terminalRegistry')
    terminalRegistry.setPendingTransfer('panel-D', 'pty-transferred', 'sb')
    await terminalRegistry.getOrCreate('panel-D', { workspaceId: 'ws-D' })

    expect(terminalRegistry.ptyIdForPanel('panel-D')).toBe('pty-transferred')
    expect(terminalRegistry.panelIdForPty('pty-transferred')).toBe('panel-D')
    expect(terminalRegistry.workspaceIdForPty('pty-transferred')).toBe('ws-D')

    terminalRegistry.dispose('panel-D')
  })

  it('marks the entry not-alive on TERMINAL_EXIT (membership != liveness)', async () => {
    const { terminalRegistry } = await import('./terminalRegistry')
    // Capture the exit listener so we can fire a synthetic exit.
    let exitListener: ((id: string, code: number) => void) | undefined
    ;(window.electronAPI as any).onTerminalExit = vi.fn((cb: (id: string, code: number) => void) => {
      exitListener = cb
      return () => {}
    })
    terminalCreate.mockResolvedValueOnce('pty-E')
    await terminalRegistry.getOrCreate('panel-E', { workspaceId: 'ws-E' })

    expect(terminalRegistry.isAlive('panel-E')).toBe(true)
    exitListener?.('pty-E', 0)
    // The entry lingers (still registered) but is no longer alive.
    expect(terminalRegistry.has('panel-E')).toBe(true)
    expect(terminalRegistry.isAlive('panel-E')).toBe(false)

    terminalRegistry.dispose('panel-E')
    expect(terminalRegistry.isAlive('panel-E')).toBeUndefined()
  })
})

describe('captureScrollback helper', () => {
  function fakeTerminal(rows: string[], baseY: number, cursorY: number) {
    return {
      buffer: {
        active: {
          baseY,
          cursorY,
          getLine: (i: number) =>
            i < rows.length ? { translateToString: (_t: boolean) => rows[i], isWrapped: false } : undefined,
        },
      },
    } as any
  }

  // Models xterm soft-wrap: each row carries an isWrapped flag and a full-width
  // (untrimmed) vs trimmed rendering so the capture's trim choice is observable.
  function fakeWrappedTerminal(
    rows: Array<{ full: string; trimmed: string; isWrapped: boolean }>,
    baseY: number,
    cursorY: number,
  ) {
    return {
      buffer: {
        active: {
          baseY,
          cursorY,
          getLine: (i: number) =>
            i < rows.length
              ? {
                  translateToString: (trim: boolean) => (trim ? rows[i].trimmed : rows[i].full),
                  isWrapped: rows[i].isWrapped,
                }
              : undefined,
        },
      },
    } as any
  }

  it('joins buffer rows and trims trailing blank lines', async () => {
    const { terminalRegistry } = await import('./terminalRegistry')
    const entry = { terminal: fakeTerminal(['line 1', 'line 2', '', ''], 1, 1) }
    expect(terminalRegistry.captureScrollback(entry)).toBe('line 1\nline 2')
  })

  it('short-circuits to a precaptured scrollback string', async () => {
    const { terminalRegistry } = await import('./terminalRegistry')
    const entry = { terminal: fakeTerminal(['ignored'], 0, 0), scrollback: 'cached' }
    expect(terminalRegistry.captureScrollback(entry)).toBe('cached')
  })

  it('returns undefined for an all-blank buffer', async () => {
    const { terminalRegistry } = await import('./terminalRegistry')
    const entry = { terminal: fakeTerminal(['', ''], 1, 0) }
    expect(terminalRegistry.captureScrollback(entry)).toBeUndefined()
  })

  it('coalesces soft-wrapped rows into one logical line so the target re-wraps', async () => {
    const { terminalRegistry } = await import('./terminalRegistry')
    // A wide `ls`-style logical line that the source terminal soft-wrapped into
    // three buffer rows. The continuation rows are flagged isWrapped. The middle
    // segments keep their full width (trailing padding intact); only the final
    // segment is trimmed. The result is ONE line — no hard newlines at the
    // source wrap points — so a narrower target re-wraps it itself.
    const entry = {
      terminal: fakeWrappedTerminal(
        [
          { full: 'file_a    file_b    ', trimmed: 'file_a    file_b', isWrapped: false },
          { full: 'file_c    file_d    ', trimmed: 'file_c    file_d', isWrapped: true },
          { full: 'file_e              ', trimmed: 'file_e', isWrapped: true },
        ],
        2,
        0,
      ),
    }
    expect(terminalRegistry.captureScrollback(entry)).toBe(
      'file_a    file_b    file_c    file_d    file_e',
    )
  })

  it('keeps a hard newline between two unwrapped logical lines', async () => {
    const { terminalRegistry } = await import('./terminalRegistry')
    const entry = {
      terminal: fakeWrappedTerminal(
        [
          { full: 'first ', trimmed: 'first', isWrapped: false },
          { full: 'second', trimmed: 'second', isWrapped: false },
        ],
        1,
        0,
      ),
    }
    expect(terminalRegistry.captureScrollback(entry)).toBe('first\nsecond')
  })
})
