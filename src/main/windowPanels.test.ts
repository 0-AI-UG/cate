// =============================================================================
// Cross-window panel discovery — main-process integration.
//
// Every window reports its panels via WINDOW_PANELS_REPORT; main keeps the latest
// report per window, flattens them into one shadow list, broadcasts it (only on
// change) to every window, drops a window's panels on close, and reveals a panel
// by focusing its owning window. Also pins the Phase-D split: the dock/panel
// SESSION-persistence syncs no longer drive discovery.
// =============================================================================

import { describe, it, expect, afterEach, vi } from 'vitest'

// windowRegistry only uses BrowserWindow.fromWebContents (not exercised here);
// a stub class satisfies the import.
vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('./perf/perfMonitor', () => ({ PERF_ENABLED: false, countIpc: vi.fn() }))

import {
  registerWindow,
  setDockWindowState,
} from './windowRegistry'
import {
  setWindowPanels,
  getWindowPanels,
  revealWindowPanel,
} from './windowPanels'
import { WINDOW_PANELS_CHANGED, REVEAL_PANEL_IN_WINDOW } from '../shared/ipc-channels'
import type { WindowPanelInfo, WindowPanelReport, PanelState } from '../shared/types'

// -----------------------------------------------------------------------------
// A fake BrowserWindow that records IPC sends and exposes its lifecycle handlers
// so a test can simulate focus/close. Each test tears its windows down so the
// module-level registry (and broadcast signature) start clean.
// -----------------------------------------------------------------------------

interface FakeWin {
  id: number
  sent: Array<{ channel: string; args: unknown[] }>
  focus: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  fireClosed: () => void
  win: never
}

const liveWindows = new Set<FakeWin>()

function makeWin(id: number): FakeWin {
  const handlers: Record<string, () => void> = {}
  const sent: FakeWin['sent'] = []
  const fake: FakeWin = {
    id,
    sent,
    focus: vi.fn(),
    restore: vi.fn(),
    fireClosed: () => handlers['closed']?.(),
    win: {
      id,
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: () => fake.restore(),
      focus: () => fake.focus(),
      // focusWindow toggles always-on-top on non-macOS to force foreground.
      isAlwaysOnTop: () => false,
      setAlwaysOnTop: vi.fn(),
      getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      on: (event: string, cb: () => void) => { handlers[event] = cb },
      webContents: { send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }) },
    } as never,
  }
  liveWindows.add(fake)
  return fake
}

/** Register a window of `type` for `workspaceId` and track it for teardown. */
function open(id: number, type: 'main' | 'dock', workspaceId?: string): FakeWin {
  const fake = makeWin(id)
  registerWindow(fake.win, type, workspaceId)
  return fake
}

const report = (panelId: string, type: PanelState['type'], title: string, parentCanvasId?: string): WindowPanelReport =>
  ({ panelId, type, title, workspaceId: 'ws-A', parentCanvasId })

/** All WINDOW_PANELS_CHANGED payloads a window received, in order. */
function broadcastsTo(win: FakeWin): WindowPanelInfo[][] {
  return win.sent
    .filter((m) => m.channel === WINDOW_PANELS_CHANGED)
    .map((m) => m.args[0] as WindowPanelInfo[])
}

afterEach(() => {
  // Close every window created in the test so the registry + signature reset.
  for (const w of [...liveWindows]) w.fireClosed()
  liveWindows.clear()
})

describe('cross-window panel discovery (main)', () => {
  it('flattens each window\'s reported panels, stamped with owner + type', () => {
    open(101, 'dock', 'ws-A')
    setWindowPanels(101, [
      { panelId: 't1', type: 'terminal', title: 'Terminal 1', workspaceId: 'ws-A' },
      { panelId: 'e1', type: 'editor', title: 'file.ts', workspaceId: 'ws-A' },
    ])
    open(102, 'dock', 'ws-B')
    setWindowPanels(102, [{ panelId: 'p1', type: 'browser', title: 'Docs', workspaceId: 'ws-B' }])
    open(1, 'main', 'ws-A')
    setWindowPanels(1, [{ panelId: 'm1', type: 'terminal', title: 'Main Term', workspaceId: 'ws-A' }])

    const byId = Object.fromEntries(getWindowPanels().map((p) => [p.panelId, p]))
    expect(byId.t1).toMatchObject({ type: 'terminal', title: 'Terminal 1', workspaceId: 'ws-A', ownerWindowId: 101, ownerWindowType: 'dock' })
    expect(byId.e1).toMatchObject({ type: 'editor', ownerWindowType: 'dock' })
    expect(byId.p1).toMatchObject({ type: 'browser', title: 'Docs', workspaceId: 'ws-B', ownerWindowId: 102, ownerWindowType: 'dock' })
    expect(byId.m1).toMatchObject({ workspaceId: 'ws-A', ownerWindowId: 1, ownerWindowType: 'main' })
  })

  it('passes through the renderer-resolved parentCanvasId for canvas children', () => {
    open(140, 'dock', 'ws-A')
    setWindowPanels(140, [
      report('cv', 'canvas', 'Canvas'),
      report('leaf1', 'terminal', 'Terminal 1', 'cv'),
      report('leaf2', 'editor', 'a.ts', 'cv'),
      report('top', 'terminal', 'Top Term'),
    ])
    const byId = Object.fromEntries(getWindowPanels().map((p) => [p.panelId, p]))
    expect(byId.leaf1.parentCanvasId).toBe('cv')
    expect(byId.leaf2.parentCanvasId).toBe('cv')
    expect(byId.cv.parentCanvasId).toBeUndefined()
    expect(byId.top.parentCanvasId).toBeUndefined()
  })

  it('passes through the panel worktreeId so the overview can tint detached rows', () => {
    open(141, 'dock', 'ws-A')
    setWindowPanels(141, [
      { panelId: 'wt1', type: 'terminal', title: 'feature shell', workspaceId: 'ws-A', worktreeId: 'wt-feature' },
      { panelId: 'plain', type: 'terminal', title: 'plain shell', workspaceId: 'ws-A' },
    ])
    const byId = Object.fromEntries(getWindowPanels().map((p) => [p.panelId, p]))
    expect(byId.wt1.worktreeId).toBe('wt-feature')
    expect(byId.plain.worktreeId).toBeUndefined()
  })

  it('rebroadcasts when only a panel\'s worktreeId changes (re-tag)', () => {
    const main = open(1, 'main', 'ws-A')
    open(150, 'dock', 'ws-A')
    setWindowPanels(150, [{ panelId: 't', type: 'terminal', title: 'shell', workspaceId: 'ws-A', worktreeId: 'wt-a' }])
    const before = broadcastsTo(main).length
    setWindowPanels(150, [{ panelId: 't', type: 'terminal', title: 'shell', workspaceId: 'ws-A', worktreeId: 'wt-b' }])
    expect(broadcastsTo(main).length).toBeGreaterThan(before)
    const last = broadcastsTo(main).at(-1)!
    expect(last.find((p) => p.panelId === 't')?.worktreeId).toBe('wt-b')
  })

  it('ignores a report from an untracked (unregistered) window', () => {
    setWindowPanels(999, [report('x', 'terminal', 'X')])
    expect(getWindowPanels()).toHaveLength(0)
  })

  it('broadcasts the shadow list to all windows, but only when it changes', () => {
    const main = open(1, 'main', 'ws-A')
    const dock = open(110, 'dock', 'ws-A')

    setWindowPanels(110, [report('t1', 'terminal', 'Terminal 1')])
    expect(broadcastsTo(main)).toHaveLength(1)
    expect(broadcastsTo(main)[0].map((p) => p.panelId)).toEqual(['t1'])
    // The dock window is also a tracked window, so it receives the broadcast too.
    expect(broadcastsTo(dock)).toHaveLength(1)

    // Re-report IDENTICAL panels → signature unchanged → NO new broadcast.
    setWindowPanels(110, [report('t1', 'terminal', 'Terminal 1')])
    expect(broadcastsTo(main)).toHaveLength(1)

    // Change a title → signature changes → a fresh broadcast.
    setWindowPanels(110, [report('t1', 'terminal', 'Renamed')])
    expect(broadcastsTo(main)).toHaveLength(2)
    expect(broadcastsTo(main)[1][0].title).toBe('Renamed')
  })

  it('drops a window\'s panels and rebroadcasts when it closes', () => {
    const main = open(1, 'main', 'ws-A')
    const dock = open(120, 'dock', 'ws-A')
    setWindowPanels(120, [report('t1', 'terminal', 'Terminal 1')])
    expect(getWindowPanels()).toHaveLength(1)
    const before = broadcastsTo(main).length

    dock.fireClosed()

    expect(getWindowPanels()).toHaveLength(0)
    const after = broadcastsTo(main)
    expect(after.length).toBe(before + 1)
    expect(after[after.length - 1]).toEqual([])
  })

  it('reveals a panel by focusing its owner window and asking it to surface', () => {
    open(1, 'main', 'ws-A')
    const dock = open(130, 'dock', 'ws-A')
    setWindowPanels(130, [report('t1', 'terminal', 'Terminal 1')])

    expect(revealWindowPanel('t1')).toBe(true)
    expect(dock.focus).toHaveBeenCalled()
    const reveal = dock.sent.filter((m) => m.channel === REVEAL_PANEL_IN_WINDOW)
    expect(reveal).toHaveLength(1)
    expect(reveal[0].args[0]).toBe('t1')

    // Unknown panel → no-op, reported as not found.
    expect(revealWindowPanel('nope')).toBe(false)
  })

  it('does NOT drive discovery from the dock session-persistence sync', () => {
    const main = open(1, 'main', 'ws-A')
    open(150, 'dock', 'ws-A')
    const before = broadcastsTo(main).length

    // Session-persistence syncs update windowRegistry state but must not touch
    // the discovery union (that comes only from WINDOW_PANELS_REPORT).
    setDockWindowState(150, {
      dockState: { zones: {} } as never,
      panels: { t1: { id: 't1', type: 'terminal', title: 'Terminal 1', isDirty: false } as PanelState },
      canvasStates: {},
    })

    expect(broadcastsTo(main).length).toBe(before)
    expect(getWindowPanels()).toHaveLength(0)
  })
})
