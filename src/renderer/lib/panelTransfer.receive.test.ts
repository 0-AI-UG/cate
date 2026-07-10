// Receive-side tests for panelTransfer: hydrateReceivedPanel /
// depositPanelTerminalTransfer / hydrateCanvasState driven through the REAL
// terminalRegistry (xterm/IPC collaborators stubbed, same harness shape as
// terminalRegistry.test.ts). Each test simulates the real sender→receiver
// sequence the window shells run:
//
//   sender:   terminalRegistry.getOrCreate (live PTY) → createTransferSnapshot
//             → terminalRegistry.release (panelTeardown — PTY stays alive)
//   receiver: hydrateReceivedPanel + ensurePanelsInAppStore (the PANEL_RECEIVE
//             preamble in DockWindowShell/App) → terminalRegistry.getOrCreate
//             (the TerminalPanel mount) → attach (reconnect finalization)
//
// NOTE: sender and receiver share one process here (one registry / one canvas
// store map), so the test releases the sender entry BEFORE depositing the
// receiver hand-off — exactly the order the two real processes produce, and
// required because release() clears the pending start for the panel id.

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted so the vi.mock factories (which run while the import graph loads,
// before this module's body) can safely reference the shared harness state.
const {
  events,
  settingsState,
  appState,
  replayTerminalLog,
  getNodeDockLayout,
  terminalCreate,
  panelTransferAck,
  terminalKill,
} = vi.hoisted(() => ({
  // Shared event log for ordering-sensitive assertions during reconnect+attach.
  events: [] as string[],
  settingsState: {
    terminalFontFamily: '',
    terminalFontSize: 0,
    terminalScrollback: 2000,
    terminalCursorBlink: false,
    terminalScrollSpeed: 1.0,
    terminalContrast: 4.5,
    terminalOptionIsMeta: true,
  },
  // Functional appStore fake state: real mutable state behind a zustand-style
  // setState so the REAL ensurePanelsInAppStore / applyCanvasChildPanels run
  // unmodified and we can assert what actually landed in the receiving store.
  appState: { workspaces: [] as any[], selectedWorkspaceId: '' },
  replayTerminalLog: vi.fn(async (_panelId: string) => undefined),
  // Controllable node mini-dock layout (null = node has only its seed panel).
  getNodeDockLayout: vi.fn<() => unknown>(() => null),
  terminalCreate: vi.fn(async () => 'pty-fresh'),
  panelTransferAck: vi.fn(async (_id: string) => undefined as undefined),
  terminalKill: vi.fn(async (_id: string) => undefined),
}))

vi.mock('@xterm/xterm', () => {
  class FakeTerminal {
    public writes: string[] = []
    public options: Record<string, unknown>
    public buffer = { active: { baseY: 0, cursorY: 0, viewportY: 0, getLine: () => undefined } }
    public element: HTMLElement | undefined
    public cols = 80
    public rows = 24
    constructor(options: Record<string, unknown> = {}) {
      this.options = options
    }
    // Activate addons so the fake SerializeAddon below can capture this
    // terminal's writes (the real registry serializes via the addon).
    loadAddon(addon: { activate?: (t: unknown) => void }): void {
      addon.activate?.(this)
    }
    open(container: HTMLElement): void {
      this.element = document.createElement('div')
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
// Deterministic serialize: a terminal's "scrollback" is everything written to it.
vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class {
    private t: { writes: string[] } | undefined
    activate(t: unknown): void { this.t = t as { writes: string[] } }
    serialize(): string { return this.t ? this.t.writes.join('') : '' }
    dispose(): void { /* no-op */ }
  },
}))

vi.mock('../stores/statusStore', () => ({
  useStatusStore: { getState: () => ({ registerTerminal: vi.fn(), unregisterTerminal: vi.fn() }) },
  setTerminalWorkspaceResolver: vi.fn(),
}))
vi.mock('../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => settingsState,
    subscribe: () => () => {},
  },
}))
vi.mock('../stores/appStore', () => ({
  awaitWorkspaceSync: async () => {},
  useAppStore: {
    getState: () => appState,
    setState: (updater: unknown) => {
      const partial =
        typeof updater === 'function'
          ? (updater as (s: typeof appState) => Partial<typeof appState>)(appState)
          : (updater as Partial<typeof appState>)
      Object.assign(appState, partial)
    },
  },
}))

vi.mock('./workspace/session', () => ({
  replayTerminalLog: (...a: unknown[]) => replayTerminalLog(...(a as [string])),
}))
vi.mock('./terminal/terminalUrlOpen', () => ({ openTerminalUrl: () => {} }))
vi.mock('./themeManager', () => ({
  getActiveTheme: () => ({ terminal: {} }),
  subscribeTheme: () => () => {},
}))
vi.mock('./logger', () => ({ default: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } }))

vi.mock('./workspace/canvasAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workspace/canvasAccess')>()),
  getNodeDockLayout: () => getNodeDockLayout(),
}))

import {
  createTransferSnapshot,
  depositPanelTerminalTransfer,
  hydrateReceivedPanel,
} from './panelTransfer'
import { terminalRegistry } from './terminal/terminalRegistry'
import { pendingTerminalStarts } from './terminal/registryState'
import { getOrCreateCanvasStoreForPanel } from '../stores/canvasStore'
import { ensurePanelsInAppStore } from './canvas/applyCanvasChildPanels'
import type { PanelState, PanelTransferSnapshot, PanelLocation } from '../../shared/types'

beforeEach(() => {
  events.length = 0
  appState.workspaces = []
  appState.selectedWorkspaceId = ''
  pendingTerminalStarts.clear()
  terminalCreate.mockClear()
  terminalCreate.mockImplementation(async () => 'pty-fresh')
  panelTransferAck.mockClear()
  terminalKill.mockClear()
  replayTerminalLog.mockClear()
  getNodeDockLayout.mockReturnValue(null)
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      terminalCreate,
      terminalWrite: vi.fn(),
      terminalResize: vi.fn(),
      terminalKill,
      onTerminalData: vi.fn(() => () => {}),
      onTerminalExit: vi.fn(() => () => {}),
      settingsGet: vi.fn(async () => ''),
      panelTransferAck,
    },
  })
})

const GEOM = { origin: { x: 0, y: 0 }, size: { width: 800, height: 600 } }
const DOCK_LOC: PanelLocation = { type: 'dock', zone: 'center', stackId: 's-1' } as PanelLocation
const CANVAS_LOC: PanelLocation = { type: 'canvas', canvasId: 'c-root', canvasNodeId: 'n-root' } as PanelLocation

function termPanel(id: string): PanelState {
  return { id, type: 'terminal', title: 'zsh', isDirty: false } as PanelState
}

/** Sender side: spawn a live terminal entry and put content in its buffer. */
async function spawnSenderTerminal(panelId: string, ptyId: string, content: string) {
  terminalCreate.mockResolvedValueOnce(ptyId)
  const entry = await terminalRegistry.getOrCreate(panelId, { workspaceId: 'ws-src' })
  entry.terminal.write(content) // simulate PTY output that landed in the buffer
  return entry
}

/** Receiver side: mount the terminal panel's DOM and let attach() finalize. */
async function attachAndSettle(panelId: string): Promise<HTMLElement> {
  const container = document.createElement('div')
  Object.defineProperty(container, 'offsetWidth', { value: 800, configurable: true })
  Object.defineProperty(container, 'offsetHeight', { value: 600, configurable: true })
  document.body.appendChild(container)
  terminalRegistry.attach(panelId, container)
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  return container
}

function receiverPanels(wsId: string): Record<string, PanelState> | undefined {
  return appState.workspaces.find((w) => w.id === wsId)?.panels
}

// ===========================================================================
// 1. hydrateReceivedPanel — happy paths (full sender → receiver round trip)
// ===========================================================================
describe('hydrateReceivedPanel — happy path round trips', () => {
  it('terminal: receiver reconnects to the live PTY and replays the captured scrollback', async () => {
    const panel = termPanel('hrp-term')
    await spawnSenderTerminal('hrp-term', 'pty-live-1', 'PROMPT$ npm run dev\n')

    const snapshot = createTransferSnapshot(panel, DOCK_LOC, GEOM, { workspaceRootPath: '/repo' })
    expect(snapshot.terminalPtyId).toBe('pty-live-1')
    expect(snapshot.terminalScrollback).toBe('PROMPT$ npm run dev\n')

    // Sender teardown (panelTeardown.ts): release WITHOUT killing the PTY.
    terminalRegistry.release('hrp-term')
    expect(terminalKill).not.toHaveBeenCalled()

    // Receiver PANEL_RECEIVE preamble (DockWindowShell.onPanelReceive order).
    hydrateReceivedPanel('ws-recv', snapshot)
    ensurePanelsInAppStore('ws-recv', { [snapshot.panel.id]: snapshot.panel }, snapshot.rootPath, snapshot.worktrees)

    // TerminalPanel mounts: must take the reconnect path, NOT spawn fresh.
    terminalCreate.mockClear()
    const entry = await terminalRegistry.getOrCreate('hrp-term', { workspaceId: 'ws-recv' })
    expect(entry.ptyId).toBe('pty-live-1')
    expect(terminalCreate).not.toHaveBeenCalled()

    // attach() finalizes the reconnect: scrollback replayed, transfer ACKed.
    await attachAndSettle('hrp-term')
    const writes = (entry.terminal as unknown as { writes: string[] }).writes.join('')
    expect(writes).toContain('PROMPT$ npm run dev')
    expect(panelTransferAck).toHaveBeenCalledWith('pty-live-1')

    // And the receiving window's appStore stub holds the panel + rootPath.
    expect(receiverPanels('ws-recv')?.['hrp-term']).toMatchObject({ id: 'hrp-term', type: 'terminal' })
    expect(appState.workspaces.find((w) => w.id === 'ws-recv')?.rootPath).toBe('/repo')

    terminalRegistry.dispose('hrp-term')
  })

  it('editor: unsaved content rides the snapshot into the receiving appStore; no terminal state is armed', () => {
    const panel: PanelState = {
      id: 'hrp-editor',
      type: 'editor',
      title: 'Untitled',
      isDirty: true,
      unsavedContent: 'const x = 1',
    } as PanelState

    const snapshot = createTransferSnapshot(panel, DOCK_LOC, GEOM)
    expect(snapshot.panel.unsavedContent).toBe('const x = 1')

    expect(() => hydrateReceivedPanel('ws-recv', snapshot)).not.toThrow()
    ensurePanelsInAppStore('ws-recv', { [snapshot.panel.id]: snapshot.panel })

    // The unsaved buffer is observable on the receiver.
    expect(receiverPanels('ws-recv')?.['hrp-editor']).toMatchObject({
      isDirty: true,
      unsavedContent: 'const x = 1',
    })
    // The preamble must not touch terminal machinery for a non-terminal panel.
    expect(pendingTerminalStarts.size).toBe(0)
  })

  it('canvas: children, viewport and live child PTYs hydrate before the canvas mounts', async () => {
    const canvasPanel: PanelState = { id: 'hrp-canvas', type: 'canvas', title: 'C', isDirty: false } as PanelState
    const store = getOrCreateCanvasStoreForPanel('hrp-canvas')
    const nodeId = store
      .getState()
      .addNode('hrp-canvas-child', 'terminal', { x: 40, y: 20 }, { width: 320, height: 240 })
    store.setState({ zoomLevel: 1.25, viewportOffset: { x: 7, y: 9 } })
    await spawnSenderTerminal('hrp-canvas-child', 'pty-child-7', 'child output\n')

    const childPanel = termPanel('hrp-canvas-child')
    const snapshot = createTransferSnapshot(canvasPanel, CANVAS_LOC, GEOM, {
      resolveChildPanel: (id) => (id === 'hrp-canvas-child' ? childPanel : undefined),
    })
    expect(snapshot.canvasState?.childTerminals?.['hrp-canvas-child']).toEqual({
      ptyId: 'pty-child-7',
      scrollback: 'child output\n',
    })

    // Sender teardown: child released (PTY lives on), then simulate the fresh
    // receiving window's empty per-panel store (same process shares the map).
    terminalRegistry.release('hrp-canvas-child')
    store.setState({ nodes: {}, zoomLevel: 1, viewportOffset: { x: 0, y: 0 } })

    hydrateReceivedPanel('ws-recv', snapshot)
    ensurePanelsInAppStore('ws-recv', { [snapshot.panel.id]: snapshot.panel })

    // Layout + viewport restored into the receiver's canvas store.
    const hydrated = getOrCreateCanvasStoreForPanel('hrp-canvas').getState()
    expect(hydrated.nodes[nodeId]?.dockLayout).toMatchObject({ panelIds: ['hrp-canvas-child'] })
    expect(hydrated.zoomLevel).toBe(1.25)
    expect(hydrated.viewportOffset).toEqual({ x: 7, y: 9 })

    // Child PanelState seeded so the node renders a real terminal, not a stub.
    expect(receiverPanels('ws-recv')?.['hrp-canvas-child']).toEqual(childPanel)

    // Child terminal mount reconnects to the live PTY instead of spawning.
    terminalCreate.mockClear()
    const entry = await terminalRegistry.getOrCreate('hrp-canvas-child', { workspaceId: 'ws-recv' })
    expect(entry.ptyId).toBe('pty-child-7')
    expect(terminalCreate).not.toHaveBeenCalled()

    terminalRegistry.dispose('hrp-canvas-child')
  })
})

// ===========================================================================
// 2. depositPanelTerminalTransfer — the PTY hand-off
// ===========================================================================
describe('depositPanelTerminalTransfer — PTY hand-off', () => {
  it('arms a live transfer so the receiving terminal mount reconnects, not respawns', async () => {
    const snapshot: PanelTransferSnapshot = {
      panel: termPanel('dep-live'),
      geometry: GEOM,
      sourceLocation: DOCK_LOC,
      terminalPtyId: 'pty-armed',
      terminalScrollback: 'history',
    }

    depositPanelTerminalTransfer(snapshot)
    expect(pendingTerminalStarts.get('dep-live')).toMatchObject({
      kind: 'transfer',
      ptyId: 'pty-armed',
    })

    const entry = await terminalRegistry.getOrCreate('dep-live', { workspaceId: 'ws-recv' })
    expect(entry.ptyId).toBe('pty-armed')
    expect(terminalCreate).not.toHaveBeenCalled()

    await attachAndSettle('dep-live')
    expect((entry.terminal as unknown as { writes: string[] }).writes.join('')).toContain('history')
    expect(panelTransferAck).toHaveBeenCalledWith('pty-armed')

    terminalRegistry.dispose('dep-live')
  })

})

// ===========================================================================
// 3. Edge: registry entry released mid-drag (snapshot finds no live terminal)
// ===========================================================================
describe('snapshot of a terminal whose registry entry was released mid-drag', () => {
  it('carries no PTY; the receiver hydrates without throwing and spawns fresh on mount', async () => {
    const panel = termPanel('edge-released')
    await spawnSenderTerminal('edge-released', 'pty-vanishing', 'gone\n')
    // The entry is released BEFORE the snapshot is taken (drag raced teardown).
    terminalRegistry.release('edge-released')

    const snapshot = createTransferSnapshot(panel, DOCK_LOC, GEOM)
    expect(snapshot.terminalPtyId).toBeUndefined()
    expect(snapshot.terminalScrollback).toBeUndefined()

    expect(() => hydrateReceivedPanel('ws-recv', snapshot)).not.toThrow()
    // No hand-off and no replay were armed.
    expect(pendingTerminalStarts.size).toBe(0)

    // Mount: a FRESH PTY is spawned — the fresh-spawn signal is a terminalCreate
    // IPC call and a brand-new ptyId (not the stale 'pty-vanishing').
    terminalCreate.mockClear()
    terminalCreate.mockResolvedValueOnce('pty-fresh-9')
    const entry = await terminalRegistry.getOrCreate('edge-released', { workspaceId: 'ws-recv' })
    expect(terminalCreate).toHaveBeenCalledTimes(1)
    expect(entry.ptyId).toBe('pty-fresh-9')
    // Nothing tries to ACK a transfer that never existed.
    expect(panelTransferAck).not.toHaveBeenCalled()

    terminalRegistry.dispose('edge-released')
  })
})

// ===========================================================================
// 4. Edge: canvas child panel record vanished between snapshot and receive
// ===========================================================================
describe('canvas snapshot with a vanished child panel record', () => {
  it('hydrates without throwing and KEEPS the orphan node (renders as a generic stub)', () => {
    const canvasPanel: PanelState = { id: 'edge-ghost-canvas', type: 'canvas', title: 'C', isDirty: false } as PanelState
    const store = getOrCreateCanvasStoreForPanel('edge-ghost-canvas')
    const nodeId = store
      .getState()
      .addNode('ghost-child', 'terminal', { x: 0, y: 0 }, { width: 300, height: 200 })

    // The child's PanelState vanished before capture: resolveChildPanel finds
    // nothing and there is no registry entry either.
    const snapshot = createTransferSnapshot(canvasPanel, CANVAS_LOC, GEOM, {
      resolveChildPanel: () => undefined,
    })
    expect(snapshot.canvasState?.childPanels).toEqual({})
    expect(snapshot.canvasState?.nodes[nodeId]?.dockLayout).toMatchObject({ panelIds: ['ghost-child'] })

    store.setState({ nodes: {} }) // fresh receiver store
    expect(() => hydrateReceivedPanel('ws-recv', snapshot)).not.toThrow()

    // Documented behavior: the orphan node is KEPT (loadWorkspaceCanvas applies
    // the captured nodes verbatim; nothing prunes nodes whose dock panel has no
    // PanelState). The receiver renders it via resolvePanel's generic "Panel"
    // stub fallback — it is NOT dropped.
    const hydrated = getOrCreateCanvasStoreForPanel('edge-ghost-canvas').getState()
    expect(hydrated.nodes[nodeId]?.dockLayout).toMatchObject({ panelIds: ['ghost-child'] })
    // ...while the appStore receives no record for the ghost child.
    expect(receiverPanels('ws-recv')?.['ghost-child']).toBeUndefined()
    // And no terminal hand-off was armed for it.
    expect(pendingTerminalStarts.size).toBe(0)
  })
})

// ===========================================================================
// 5. Edge: second PANEL_RECEIVE deposit before the first panel mounts
// ===========================================================================
describe('two deposits race before the panel mounts', () => {
  it('same panel id: the SECOND deposit clobbers the first; the first PTY is orphaned', async () => {
    const first: PanelTransferSnapshot = {
      panel: termPanel('race-panel'),
      geometry: GEOM,
      sourceLocation: DOCK_LOC,
      terminalPtyId: 'pty-first',
      terminalScrollback: 'FIRST',
    }
    const second: PanelTransferSnapshot = {
      panel: termPanel('race-panel'),
      geometry: GEOM,
      sourceLocation: DOCK_LOC,
      terminalPtyId: 'pty-second',
      terminalScrollback: 'SECOND',
    }

    hydrateReceivedPanel('ws-recv', first)
    hydrateReceivedPanel('ws-recv', second) // arrives before the panel mounts

    const entry = await terminalRegistry.getOrCreate('race-panel', { workspaceId: 'ws-recv' })
    await attachAndSettle('race-panel')

    // The pending-start registry is keyed by panelId, so the second
    // set() overwrites the first — the mount reconnects to pty-second only.
    expect(entry.ptyId).toBe('pty-second')
    expect((entry.terminal as unknown as { writes: string[] }).writes.join('')).toContain('SECOND')
    expect(panelTransferAck).toHaveBeenCalledTimes(1)
    expect(panelTransferAck).toHaveBeenCalledWith('pty-second')

    // BUG?: the first hand-off is silently lost. 'pty-first' is never
    // reconnected, never ACKed (main keeps holding its buffered output for a
    // flush that never comes) and never killed — the first transfer's PTY
    // process leaks in the main process until app shutdown.
    expect(panelTransferAck).not.toHaveBeenCalledWith('pty-first')
    expect(terminalKill).not.toHaveBeenCalled()
    const writes = (entry.terminal as unknown as { writes: string[] }).writes.join('')
    expect(writes).not.toContain('FIRST')

    terminalRegistry.dispose('race-panel')
  })

  it('different panel ids: deposits do not interfere — each panel reconnects to its own PTY', async () => {
    hydrateReceivedPanel('ws-recv', {
      panel: termPanel('race-a'),
      geometry: GEOM,
      sourceLocation: DOCK_LOC,
      terminalPtyId: 'pty-a',
    })
    hydrateReceivedPanel('ws-recv', {
      panel: termPanel('race-b'),
      geometry: GEOM,
      sourceLocation: DOCK_LOC,
      terminalPtyId: 'pty-b',
    })

    const a = await terminalRegistry.getOrCreate('race-a', { workspaceId: 'ws-recv' })
    const b = await terminalRegistry.getOrCreate('race-b', { workspaceId: 'ws-recv' })
    expect(a.ptyId).toBe('pty-a')
    expect(b.ptyId).toBe('pty-b')
    expect(terminalCreate).not.toHaveBeenCalled()

    terminalRegistry.dispose('race-a')
    terminalRegistry.dispose('race-b')
  })
})

// ===========================================================================
// 6. Unhappy: malformed / partial snapshots
// ===========================================================================
describe('malformed or partial snapshots hydrate without throwing', () => {
  it('editor snapshot missing editorState', () => {
    const snapshot: PanelTransferSnapshot = {
      panel: { id: 'mal-editor', type: 'editor', title: 'E', isDirty: false } as PanelState,
      geometry: GEOM,
      sourceLocation: DOCK_LOC,
      // no editorState at all
    }
    expect(() => hydrateReceivedPanel('ws-recv', snapshot)).not.toThrow()
  })

  it('terminal snapshot with neither a live ptyId nor a replay hint arms nothing', () => {
    const snapshot: PanelTransferSnapshot = {
      panel: termPanel('mal-term'),
      geometry: GEOM,
      sourceLocation: DOCK_LOC,
    }
    expect(() => hydrateReceivedPanel('ws-recv', snapshot)).not.toThrow()
    expect(pendingTerminalStarts.size).toBe(0)
  })

  it('canvas snapshot with undefined childPanels and childTerminals still loads the layout', () => {
    const snapshot: PanelTransferSnapshot = {
      panel: { id: 'mal-canvas', type: 'canvas', title: 'C', isDirty: false } as PanelState,
      geometry: GEOM,
      sourceLocation: CANVAS_LOC,
      canvasState: {
        nodes: {},
        viewportOffset: { x: 3, y: 4 },
        zoomLevel: 2,
        // A stale sender (or hand-edited session file) can omit these despite
        // the type marking childPanels required.
        childPanels: undefined,
        childTerminals: undefined,
      } as unknown as NonNullable<PanelTransferSnapshot['canvasState']>,
    }

    expect(() => hydrateReceivedPanel('ws-recv', snapshot)).not.toThrow()
    const hydrated = getOrCreateCanvasStoreForPanel('mal-canvas').getState()
    expect(hydrated.viewportOffset).toEqual({ x: 3, y: 4 })
    expect(hydrated.zoomLevel).toBe(2)
    // Nothing seeded, nothing armed.
    expect(receiverPanels('ws-recv')).toBeUndefined()
    expect(pendingTerminalStarts.size).toBe(0)
  })

  it('canvas panel WITHOUT canvasState skips hydration entirely (no throw, store untouched)', () => {
    const store = getOrCreateCanvasStoreForPanel('mal-canvas-empty')
    store.getState().addNode('pre-existing', 'terminal', { x: 0, y: 0 }, { width: 100, height: 100 })
    const before = store.getState().nodes

    const snapshot: PanelTransferSnapshot = {
      panel: { id: 'mal-canvas-empty', type: 'canvas', title: 'C', isDirty: false } as PanelState,
      geometry: GEOM,
      sourceLocation: CANVAS_LOC,
      // canvasState missing — e.g. a sender that crashed mid-capture.
    }
    expect(() => hydrateReceivedPanel('ws-recv', snapshot)).not.toThrow()
    expect(store.getState().nodes).toBe(before)
  })
})
