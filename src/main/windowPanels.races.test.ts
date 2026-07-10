// =============================================================================
// ORDERING RACES — cross-window panel discovery (main process).
//
// windowPanels.test.ts covers the steady-state contract; this file covers the
// orderings where IPC and window lifecycle interleave badly:
//   - a panels report landing AFTER its window closed (late in-flight IPC)
//   - a window destroyed WITHOUT a clean 'closed' event (crash-ish teardown)
//   - register → immediate destroy → report
//   - two windows closing back-to-back with reports still in flight
//   - panel migration overlap (new owner reports before old owner closes)
//   - the closing window itself being destroyed before 'closed' fires
//
// Harness replicated from windowPanels.test.ts (importing a test file would
// register its tests here), extended with a mutable `destroyed` flag so
// isDestroyed() can flip independently of the 'closed' event.
// =============================================================================

import { describe, it, expect, afterEach, vi } from 'vitest'

// windowRegistry only uses BrowserWindow.fromWebContents (not exercised here);
// a stub class satisfies the import.
vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('./perf/perfMonitor', () => ({ PERF_ENABLED: false, countIpc: vi.fn() }))

import { registerWindow } from './windowRegistry'
import { setWindowPanels, getWindowPanels, revealWindowPanel } from './windowPanels'
import { WINDOW_PANELS_CHANGED } from '../shared/ipc-channels'
import type { WindowPanelInfo, WindowPanelReport, PanelState } from '../shared/types'

// -----------------------------------------------------------------------------
// Fake BrowserWindow harness (see windowPanels.test.ts) + `destroyed` flag.
// -----------------------------------------------------------------------------

interface FakeWin {
  id: number
  sent: Array<{ channel: string; args: unknown[] }>
  focus: ReturnType<typeof vi.fn>
  /** Flip to true to simulate destruction WITHOUT firing 'closed'. */
  destroyed: boolean
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
    destroyed: false,
    fireClosed: () => handlers['closed']?.(),
    win: {
      id,
      isDestroyed: () => fake.destroyed,
      isMinimized: () => false,
      restore: vi.fn(),
      focus: () => fake.focus(),
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

function open(id: number, type: 'main' | 'dock', workspaceId?: string): FakeWin {
  const fake = makeWin(id)
  registerWindow(fake.win, type, workspaceId)
  return fake
}

const report = (panelId: string, type: PanelState['type'], title: string): WindowPanelReport =>
  ({ panelId, type, title, workspaceId: 'ws-A' })

function broadcastsTo(win: FakeWin): WindowPanelInfo[][] {
  return win.sent
    .filter((m) => m.channel === WINDOW_PANELS_CHANGED)
    .map((m) => m.args[0] as WindowPanelInfo[])
}

afterEach(() => {
  // Fire 'closed' on EVERY window (including destroyed-without-closed zombies)
  // so windowRegistry's module-level maps and the broadcast signature reset.
  for (const w of [...liveWindows]) w.fireClosed()
  liveWindows.clear()
})

describe('ordering races — late reports vs window close', () => {
  it('a panels report arriving AFTER the window closed is dropped: no resurrection, no throw, no rebroadcast', () => {
    const main = open(1, 'main', 'ws-A')
    const dock = open(201, 'dock', 'ws-A')
    setWindowPanels(201, [report('t1', 'terminal', 'Term')])
    expect(getWindowPanels()).toHaveLength(1)

    // RACE: the renderer sent a fresh report, then the window closed before
    // main processed it — the report is delivered after 'closed'.
    dock.fireClosed()
    const broadcastsAfterClose = broadcastsTo(main).length
    expect(broadcastsTo(main).at(-1)).toEqual([])

    expect(() =>
      setWindowPanels(201, [report('t1', 'terminal', 'Term'), report('t2', 'terminal', 'Term 2')]),
    ).not.toThrow()

    // The closed window's entry must NOT be resurrected, and the empty union
    // must not be rebroadcast for a dropped report.
    expect(getWindowPanels()).toHaveLength(0)
    expect(broadcastsTo(main).length).toBe(broadcastsAfterClose)
    expect(revealWindowPanel('t1')).toBe(false)
  })

  it('two windows closing in quick succession with reports in flight converge to a clean, ordered union', () => {
    const main = open(1, 'main', 'ws-A')
    const a = open(210, 'dock', 'ws-A')
    const b = open(211, 'dock', 'ws-A')
    setWindowPanels(210, [report('a1', 'terminal', 'A1')])
    setWindowPanels(211, [report('b1', 'terminal', 'B1')])

    // RACE: A closes; its in-flight report lands late; then B closes; B's
    // late (even retitled) report lands after that.
    a.fireClosed()
    setWindowPanels(210, [report('a1', 'terminal', 'A1')])
    b.fireClosed()
    setWindowPanels(211, [report('b1', 'terminal', 'B1 renamed')])

    expect(getWindowPanels()).toEqual([])
    // Exact broadcast progression observed by the main window — the late
    // reports must not have produced any extra or out-of-order broadcasts.
    const seq = broadcastsTo(main).map((bc) => bc.map((p) => p.panelId).sort().join(','))
    expect(seq).toEqual(['a1', 'a1,b1', 'b1', ''])
  })

  it('panel migration overlap: replacement window reports the panel before the old owner closes', () => {
    open(1, 'main', 'ws-A')
    const oldWin = open(220, 'dock', 'ws-A')
    setWindowPanels(220, [report('t1', 'terminal', 'Term')])

    // RACE: during a drag-migration the new window reports the panel while the
    // old window is still open — the union briefly holds BOTH owners.
    const newWin = open(221, 'dock', 'ws-A')
    setWindowPanels(221, [report('t1', 'terminal', 'Term')])
    expect(getWindowPanels().filter((p) => p.panelId === 't1')).toHaveLength(2)

    oldWin.fireClosed()
    const final = getWindowPanels()
    expect(final).toHaveLength(1)
    expect(final[0]).toMatchObject({ panelId: 't1', ownerWindowId: 221 })

    // Reveal targets the surviving owner, never the closed one.
    expect(revealWindowPanel('t1')).toBe(true)
    expect(newWin.focus).toHaveBeenCalled()
    expect(oldWin.focus).not.toHaveBeenCalled()
  })
})

describe('ordering races — destroyed without a clean closed event', () => {
  it('getWindowPanels hides a destroyed-but-not-closed window without throwing; reveal degrades to false', () => {
    open(1, 'main', 'ws-A')
    const dock = open(202, 'dock', 'ws-A')
    setWindowPanels(202, [report('t1', 'terminal', 'Term')])
    expect(getWindowPanels()).toHaveLength(1)

    // RACE: the window is destroyed but its 'closed' event was never observed
    // (e.g. teardown path that skips the handler). The registry entry is stale.
    dock.destroyed = true

    expect(() => getWindowPanels()).not.toThrow()
    // The getWindow() isDestroyed guard masks the stale entry from the union.
    expect(getWindowPanels()).toHaveLength(0)
    // Reveal must not focus or message a destroyed window.
    expect(revealWindowPanel('t1')).toBe(false)
    expect(dock.focus).not.toHaveBeenCalled()
  })

  it('register → immediate destroy → report: report is silently retained but invisible (no broadcast, no throw)', () => {
    const main = open(1, 'main', 'ws-A')
    const dock = open(203, 'dock', 'ws-A')
    dock.destroyed = true // destroyed before its first report arrives

    const before = broadcastsTo(main).length
    expect(() => setWindowPanels(203, [report('z1', 'terminal', 'Zombie')])).not.toThrow()

    // The union excludes it, and since the visible union didn't change, the
    // signature guard suppresses any broadcast.
    expect(getWindowPanels()).toHaveLength(0)
    expect(broadcastsTo(main).length).toBe(before)

    // Internal-retention probe (NOT a real Electron sequence — window ids are
    // never reused; this only proves the entry was stored, not dropped):
    // because getWindowType() still answers for the stale registry entry, the
    // zombie's report IS kept in the per-window map and only the getWindow()
    // isDestroyed guard hides it.
    dock.destroyed = false
    expect(getWindowPanels().map((p) => p.panelId)).toEqual(['z1'])
    dock.destroyed = true
    // BUG?: a window that dies without ever emitting 'closed' leaks its report
    // (plus its windowRegistry entries) forever — every consumer is shielded by
    // the isDestroyed guard, so it is a bounded memory leak rather than a
    // correctness bug, and real Electron does emit 'closed' on destroy().
  })

  it('the closing window itself is skipped by the removal rebroadcast when destroyed before closed fires', () => {
    const main = open(1, 'main', 'ws-A')
    const dock = open(230, 'dock', 'ws-A')
    setWindowPanels(230, [report('t1', 'terminal', 'T')])
    const dockSeen = broadcastsTo(dock).length

    // Real Electron ordering: the window is already destroyed by the time
    // 'closed' fires, so the removal rebroadcast must not try to send to it.
    dock.destroyed = true
    expect(() => dock.fireClosed()).not.toThrow()

    expect(broadcastsTo(dock).length).toBe(dockSeen) // nothing sent to the dead webContents
    expect(broadcastsTo(main).at(-1)).toEqual([]) // survivors still learn of the removal
    expect(getWindowPanels()).toEqual([])
  })
})
