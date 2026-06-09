// Regression: a terminal detached into its own window as a TOP-LEVEL dock tab
// did NOT restore its scrollback on app restart, while a terminal in the MAIN
// window did. Root cause: the detached path keyed scrollback by the ephemeral
// ptyId and depended on a captured terminalPtyIds map surviving in the snapshot.
// Fix: the detached path now keys scrollback by the STABLE panelId and replays
// every terminal panel by its own id — identical to the main window.
//
// This test drives the full detached-window round-trip end to end with the
// xterm/IPC/store collaborators stubbed (the same harness shape as
// terminalRegistry.test.ts):
//
//   1. A live detached window saves a terminal's scrollback via
//      captureAndSaveScrollback (keyed by the panelId), exactly as
//      DockWindowShell.syncNow does.
//   2. We assemble the persisted DetachedDockWindowSnapshot the way main caches
//      it (no ptyId map needed), wrap it in a ProjectSessionFile, and run it
//      through dockWindowsFromSession + buildDockWindowRestoreInit — the real
//      restore reconstruction (which sets initPayload.restore = true).
//   3. We simulate DockWindowShell.onDockWindowInit arming the restore map: for
//      a restore, replay EVERY terminal panel (top-level + canvas children) by
//      its own panelId — one uniform path.
//   4. We drive terminalRegistry.getOrCreate (fresh spawn) and assert the saved
//      scrollback is replayed: terminalLogRead is called with the panelId AND
//      the fake xterm receives the restored content.
//
// The SAME assertions run for a top-level terminal and a canvas-child terminal.

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// In-memory scrollback "disk": terminalScrollbackSave writes here keyed by the
// save key (ptyId); terminalLogRead reads it back (matching main's behaviour of
// preferring the `${ptyId}.scrollback` file).
// ---------------------------------------------------------------------------
const scrollbackDisk = new Map<string, string>()

beforeEach(() => {
  scrollbackDisk.clear()
})

vi.mock('@xterm/xterm', () => {
  class FakeTerminal {
    public writes: string[] = []
    public options: { theme?: unknown } = {}
    public buffer = {
      active: {
        baseY: 0,
        cursorY: 0,
        viewportY: 0,
        getLine: (_i: number) => undefined as undefined | { translateToString: (t: boolean) => string },
      },
    }
    public element: HTMLElement | undefined
    public cols = 80
    public rows = 24
    loadAddon(): void {}
    open(container: HTMLElement): void {
      this.element = document.createElement('div')
      const viewport = document.createElement('div')
      viewport.className = 'xterm-viewport'
      this.element.appendChild(viewport)
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
    scrollToLine(): void {}
    scrollToBottom(): void {}
    resize(c: number, r: number): void { this.cols = c; this.rows = r }
    dispose(): void {}
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
  SerializeAddon: class { activate() {} serialize() { return '' } dispose() {} },
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
vi.mock('../terminal/terminalUrlOpen', () => ({ openTerminalUrl: () => {} }))
vi.mock('../themeManager', () => ({
  getActiveTheme: () => ({ terminal: {} }),
  subscribeTheme: () => () => {},
}))
vi.mock('../logger', () => ({ default: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } }))

// NOTE: deliberately NOT mocking ../workspace/session — we want the REAL
// replayTerminalLog so the restore path is exercised end to end. terminalLifecycle
// imports replayTerminalLog from there; the real implementation reads
// terminalLogRead and writes into the xterm.

const terminalCreate = vi.fn(async () => 'pty-fresh')

beforeEach(() => {
  terminalCreate.mockClear()
  terminalCreate.mockResolvedValue('pty-fresh')
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
      shellRegisterTerminal: vi.fn(async () => undefined),
      shellUnregisterTerminal: vi.fn(async () => undefined),
      settingsGet: vi.fn(async () => ''),
      panelTransferAck: vi.fn(async () => undefined),
      terminalScrollbackSave: vi.fn(async (key: string, content: string) => {
        scrollbackDisk.set(key, content)
      }),
      terminalLogRead: vi.fn(async (id: string) => scrollbackDisk.get(id) ?? null),
    },
  })
})

// Build a fake registry entry whose serialize addon returns a saved buffer —
// two visible rows of `ls` output and a prompt — as serializeTerminalState reads.
function fakeEntryWithLsOutput() {
  return {
    serializeAddon: { serialize: () => '$ ls\r\nfile-a.txt  file-b.txt\r\n$ ' },
  } as any
}

describe('detached top-level terminal scrollback restore round-trip', () => {
  async function runRoundTrip(opts: { canvasChild: boolean }) {
    const { terminalRegistry } = await import('../terminal/terminalRegistry')
    const { dockWindowsFromSession } = await import('./sessionLoad')
    const { buildDockWindowRestoreInit } = await import('./sessionStartup')
    const { terminalRestoreData } = await import('../terminal/terminalRestoreData')

    const termPanelId = 'term-panel-1'

    // ---- 1. LIVE detached window saves scrollback (DockWindowShell.syncNow) ----
    // Keyed by the STABLE panel id — same as the main window, and the key restore reads.
    const { captureAndSaveScrollback } = await import('../terminal/captureAndSaveScrollback')
    const liveEntry = fakeEntryWithLsOutput()
    await captureAndSaveScrollback(liveEntry, termPanelId)
    expect(scrollbackDisk.get(termPanelId)).toContain('file-a.txt')

    // ---- 2. Assemble the persisted snapshot the way main caches it ----
    // Top-level case: the terminal panel is referenced by the dock zones.
    // Canvas-child case: a canvas panel is the top-level tab and the terminal is
    // a child (NOT referenced by the zones).
    const canvasPanelId = 'canvas-panel-1'
    const panels: Record<string, any> = {
      [termPanelId]: { id: termPanelId, type: 'terminal', title: 'Terminal' },
    }
    let zonesPanelIds: string[]
    if (opts.canvasChild) {
      panels[canvasPanelId] = { id: canvasPanelId, type: 'canvas', title: 'Canvas' }
      zonesPanelIds = [canvasPanelId]
    } else {
      zonesPanelIds = [termPanelId]
    }

    const session = {
      dockWindows: [
        {
          dockState: {
            zones: {
              center: {
                position: 'center',
                visible: true,
                size: 0,
                layout: { type: 'tabs', id: 'tabs-1', panelIds: zonesPanelIds, activeIndex: 0 },
              },
              left: { position: 'left', visible: false, size: 0, layout: null },
              right: { position: 'right', visible: false, size: 0, layout: null },
              bottom: { position: 'bottom', visible: false, size: 0, layout: null },
            },
            locations: {},
          },
          panels,
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          workspaceId: 'ws-1',
        },
      ],
    } as any

    // ---- 3. Restore reconstruction (sessionLoad + sessionStartup) ----
    const dockWindows = dockWindowsFromSession(session)
    expect(dockWindows).toHaveLength(1)
    const dw = dockWindows[0]
    const { initPayload } = buildDockWindowRestoreInit(dw)

    // ---- 4. Simulate DockWindowShell.onDockWindowInit arming the restore map ----
    // Cold restore arms replay for EVERY terminal panel (top-level tabs AND canvas
    // children alike) by its STABLE panel id — one uniform path, no ptyId map.
    expect(initPayload.restore).toBe(true)
    for (const panel of Object.values(initPayload.panels)) {
      if (panel.type !== 'terminal') continue
      terminalRestoreData.set(panel.id, { replayFromId: panel.id })
    }

    // The restore map must be armed for the terminal panel.
    expect(terminalRestoreData.has(termPanelId)).toBe(true)

    // ---- 5. Mount: getOrCreate spawns fresh + replays the saved scrollback ----
    await terminalRegistry.getOrCreate(termPanelId, { workspaceId: 'ws-1' })
    // replayTerminalLog runs fire-and-forget inside getOrCreate; let it settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    const entry = terminalRegistry.getEntry(termPanelId)!
    const wrote = (entry.terminal as unknown as { writes: string[] }).writes.join('')

    terminalRegistry.dispose(termPanelId)
    terminalRestoreData.delete(termPanelId)

    return {
      logReadCalls: (window.electronAPI.terminalLogRead as any).mock.calls as any[][],
      wrote,
      replayKey: termPanelId,
    }
  }

  it('CANVAS-CHILD terminal restores its scrollback (known-good baseline)', async () => {
    const { logReadCalls, wrote, replayKey } = await runRoundTrip({ canvasChild: true })
    expect(logReadCalls.some((c) => c[0] === replayKey)).toBe(true)
    expect(wrote).toContain('file-a.txt')
  })

  it('TOP-LEVEL terminal restores its scrollback (the reported bug)', async () => {
    const { logReadCalls, wrote, replayKey } = await runRoundTrip({ canvasChild: false })
    expect(logReadCalls.some((c) => c[0] === replayKey)).toBe(true)
    expect(wrote).toContain('file-a.txt')
  })
})
