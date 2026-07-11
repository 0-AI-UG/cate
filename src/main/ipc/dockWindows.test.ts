// =============================================================================
// Dock-window IPC handlers — integration seam between the renderer-facing
// channels and the real windowRegistry / windowPanels modules.
//
// registerDockWindowHandlers wires five channels; these tests invoke the
// captured handlers directly against REAL registry state (fake BrowserWindows
// registered via registerWindow, panels reported via setWindowPanels) and pin:
//   • DOCK_WINDOW_SYNC_STATE updates the persistence cache that
//     DOCK_WINDOWS_LIST reads, keyed by the SENDER window — and can never
//     change the window's creation-time workspaceId.
//   • sync from an unknown/unregistered sender is observably ignored.
//   • DOCK_WINDOW_RESTORE mints a window via the injected createWindow, applies
//     snapshot bounds, defers DOCK_WINDOW_INIT + reveal-without-focus to
//     did-finish-load, and returns the new window id — or null for a snapshot
//     with no restorable first tab.
//   • FOCUS_WINDOW_PANEL / CLOSE_WINDOW_PANEL route through the windowPanels
//     union to the panel's owner window.
// =============================================================================

import { describe, it, expect, afterEach, vi } from 'vitest'

// Captured ipcMain.handle map so tests can invoke handlers directly, and a
// sender -> fake-window map backing BrowserWindow.fromWebContents (which is how
// windowFromEvent resolves the sync sender). Hoisted so the mock factory
// (evaluated before imports) can reach them.
const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  senderToWin: new Map<unknown, unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      hoisted.handlers.set(channel, fn)
    },
  },
  BrowserWindow: {
    fromWebContents: (sender: unknown) => hoisted.senderToWin.get(sender),
  },
}))
vi.mock('../perf/perfMonitor', () => ({ PERF_ENABLED: false, countIpc: vi.fn() }))

import { registerWindow } from '../windowRegistry'
import { setWindowPanels } from '../windowPanels'
import { registerDockWindowHandlers } from './dockWindows'
import {
  DOCK_WINDOW_INIT,
  DOCK_WINDOW_SYNC_STATE,
  DOCK_WINDOWS_LIST,
  DOCK_WINDOW_RESTORE,
  FOCUS_WINDOW_PANEL,
  CLOSE_WINDOW_PANEL,
  REVEAL_PANEL_IN_WINDOW,
  CLOSE_PANEL_IN_WINDOW,
} from '../../shared/ipc-channels'
import type {
  DetachedDockWindowSnapshot,
  DockWindowInitPayload,
  DockWindowSyncState,
  PanelState,
  WindowDockState,
} from '../../shared/types'

// -----------------------------------------------------------------------------
// Fake BrowserWindow — same shape as windowPanels.test.ts, extended with the
// surfaces the restore path touches (setBounds, show, webContents.once).
// -----------------------------------------------------------------------------

interface FakeWin {
  id: number
  sent: Array<{ channel: string; args: unknown[] }>
  focus: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
  fireClosed: () => void
  fireDidFinishLoad: () => void
  win: never
}

const liveWindows = new Set<FakeWin>()

function makeWin(id: number): FakeWin {
  const handlers: Record<string, () => void> = {}
  const wcOnce: Record<string, Array<() => void>> = {}
  const sent: FakeWin['sent'] = []
  const fake: FakeWin = {
    id,
    sent,
    focus: vi.fn(),
    show: vi.fn(),
    setBounds: vi.fn(),
    fireClosed: () => handlers['closed']?.(),
    fireDidFinishLoad: () => {
      const fired = wcOnce['did-finish-load'] ?? []
      wcOnce['did-finish-load'] = []
      fired.forEach((f) => f())
    },
    win: {
      id,
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      focus: () => fake.focus(),
      show: () => fake.show(),
      setBounds: (b: unknown) => fake.setBounds(b),
      isAlwaysOnTop: () => false,
      setAlwaysOnTop: vi.fn(),
      getBounds: () => ({ x: 5, y: 6, width: 800, height: 600 }),
      on: (event: string, cb: () => void) => { handlers[event] = cb },
      webContents: {
        send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
        once: (event: string, cb: () => void) => { (wcOnce[event] ??= []).push(cb) },
      },
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

// Register the handlers ONCE with a swappable createWindow spy (real wiring
// injects windowFactory.createWindow here).
const createWindow = vi.fn()
registerDockWindowHandlers({ createWindow: createWindow as never })

const invoke = (channel: string, sender: unknown, ...args: unknown[]): unknown =>
  hoisted.handlers.get(channel)!({ sender }, ...args)

/** Register a sender object resolving to `win` (or to nothing when win is null). */
function senderFor(win: FakeWin | null): object {
  const sender = {}
  if (win) hoisted.senderToWin.set(sender, win.win)
  return sender
}

const emptyZone = (position: 'left' | 'right' | 'bottom' | 'center') =>
  ({ position, visible: false, size: 0, layout: null })

/** Zones with a single center tab stack hosting the given panelIds. */
function zonesWith(panelIds: string[]): WindowDockState {
  return {
    left: emptyZone('left'),
    right: emptyZone('right'),
    bottom: emptyZone('bottom'),
    center: {
      position: 'center',
      visible: true,
      size: 0,
      layout: { type: 'tabs', id: 'stack-1', panelIds, activeIndex: 0 },
    },
  }
}

const panel = (id: string): PanelState =>
  ({ id, type: 'terminal', title: `Terminal ${id}`, isDirty: false }) as PanelState

function syncState(panelIds: string[]): DockWindowSyncState {
  return {
    dockState: { zones: zonesWith(panelIds) },
    panels: Object.fromEntries(panelIds.map((id) => [id, panel(id)])),
    canvasStates: {},
  }
}

function restoreSnapshot(
  panelIds: string[],
  panels: Record<string, PanelState>,
): DetachedDockWindowSnapshot & { initPayload: DockWindowInitPayload } {
  return {
    dockState: { zones: zonesWith(panelIds) },
    panels,
    bounds: { x: 10, y: 20, width: 640, height: 480 },
    workspaceId: 'ws-A',
    canvasStates: {},
    initPayload: {
      panels,
      dockState: zonesWith(panelIds),
      workspaceId: 'ws-A',
      restore: true,
      canvasStates: {},
    },
  }
}

afterEach(() => {
  // Close every window created in the test so the shared registry resets.
  for (const w of [...liveWindows]) w.fireClosed()
  liveWindows.clear()
  hoisted.senderToWin.clear()
  createWindow.mockReset()
})

describe('DOCK_WINDOW_SYNC_STATE / DOCK_WINDOWS_LIST', () => {
  it('caches the sender window\'s state for the list, keyed by the sender', async () => {
    const dock = open(201, 'dock', 'ws-A')
    open(1, 'main', 'ws-A')

    // A dock window that never synced has no persistable state yet.
    expect(await invoke(DOCK_WINDOWS_LIST, senderFor(null))).toEqual([])

    await invoke(DOCK_WINDOW_SYNC_STATE, senderFor(dock), syncState(['t1']))

    const list = (await invoke(DOCK_WINDOWS_LIST, senderFor(null))) as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      windowId: 201,
      workspaceId: 'ws-A',
      bounds: { x: 5, y: 6, width: 800, height: 600 }, // live window bounds, not synced
    })
    expect(Object.keys((list[0] as { panels: object }).panels)).toEqual(['t1'])

    // A later sync replaces the cached state for that window.
    await invoke(DOCK_WINDOW_SYNC_STATE, senderFor(dock), syncState(['t1', 't2']))
    const relisted = (await invoke(DOCK_WINDOWS_LIST, senderFor(null))) as Array<{ panels: object }>
    expect(Object.keys(relisted[0].panels)).toEqual(['t1', 't2'])
  })

  it('cannot change the window\'s creation-time workspaceId via a sync payload', async () => {
    const dock = open(202, 'dock', 'ws-A')

    // DockWindowSyncState deliberately carries no workspaceId; a hostile/stale
    // extra field must not leak through either (main's creation-time value wins).
    const poisoned = { ...syncState(['t1']), workspaceId: 'ws-EVIL' }
    await invoke(DOCK_WINDOW_SYNC_STATE, senderFor(dock), poisoned)

    const list = (await invoke(DOCK_WINDOWS_LIST, senderFor(null))) as Array<{ workspaceId: string }>
    expect(list[0].workspaceId).toBe('ws-A')
  })

  it('ignores a sync whose sender resolves to no window', async () => {
    open(203, 'dock', 'ws-A')
    // fromWebContents finds nothing for this sender (e.g. window already gone).
    await expect(
      invoke(DOCK_WINDOW_SYNC_STATE, senderFor(null), syncState(['t1'])),
    ).resolves.toBeUndefined()
    expect(await invoke(DOCK_WINDOWS_LIST, senderFor(null))).toEqual([])
  })

  it('never lists a sync from a window the registry does not track', async () => {
    // Electron knows the sender's window, but it was never registerWindow()ed.
    // Current behavior: the state IS cached by window id, but the list is
    // registry-driven so the entry is unobservable (harmless unless a window id
    // were ever reused). Pinning the observable part: it is not listed.
    const rogue = makeWin(999)
    await invoke(DOCK_WINDOW_SYNC_STATE, senderFor(rogue), syncState(['t1']))
    expect(await invoke(DOCK_WINDOWS_LIST, senderFor(null))).toEqual([])
  })
})

describe('DOCK_WINDOW_RESTORE', () => {
  it('mints a dock window, applies bounds, and defers init + reveal to did-finish-load', async () => {
    const restored = makeWin(300)
    createWindow.mockImplementation((params: { type: string; workspaceId?: string }) => {
      // Mirror the production contract: windowFactory.createWindow registers the
      // new window in the registry (sendToWindow silently drops otherwise).
      registerWindow(restored.win, params.type as 'dock', params.workspaceId)
      return restored.win
    })

    const payload = restoreSnapshot(['t1'], { t1: panel('t1') })
    const result = await invoke(DOCK_WINDOW_RESTORE, senderFor(null), payload)

    expect(result).toBe(300)
    expect(createWindow).toHaveBeenCalledExactlyOnceWith({ type: 'dock', workspaceId: 'ws-A' })
    expect(restored.setBounds).toHaveBeenCalledExactlyOnceWith(payload.bounds)

    // Nothing is sent or shown until the renderer finishes loading.
    expect(restored.sent).toEqual([])
    expect(restored.show).not.toHaveBeenCalled()

    restored.fireDidFinishLoad()

    expect(restored.sent).toEqual([{ channel: DOCK_WINDOW_INIT, args: [payload.initPayload] }])
    // Revealed without stealing focus from the main window mid-startup.
    expect(restored.show).toHaveBeenCalledTimes(1)
    expect(restored.focus).not.toHaveBeenCalled()
  })

  it('bails null when the dock state has no top-level panels', async () => {
    const payload = restoreSnapshot([], {})
    payload.dockState.zones.center.layout = null
    payload.initPayload.dockState.center.layout = null

    expect(await invoke(DOCK_WINDOW_RESTORE, senderFor(null), payload)).toBeNull()
    expect(createWindow).not.toHaveBeenCalled()
  })

  it('bails null when the FIRST top-level panel record is missing, even if later tabs are restorable', async () => {
    // Pins current behavior: only the first zone panel id is validated, so a
    // ghost first tab (stale layout after an incomplete flush) drops the WHOLE
    // window including the perfectly restorable 't1' behind it. Questionable
    // but current — see the matching renderer-side `.fails` pin in
    // session.restoreDockWindow.test.ts (ghost ids are not pruned upstream).
    const payload = restoreSnapshot(['ghost', 't1'], { t1: panel('t1') })

    expect(await invoke(DOCK_WINDOW_RESTORE, senderFor(null), payload)).toBeNull()
    expect(createWindow).not.toHaveBeenCalled()
  })
})

describe('FOCUS_WINDOW_PANEL / CLOSE_WINDOW_PANEL', () => {
  it('reveals a panel by focusing its owner window and asking it to surface', async () => {
    open(1, 'main', 'ws-A')
    const dock = open(210, 'dock', 'ws-A')
    setWindowPanels(210, [{ panelId: 't1', type: 'terminal', title: 'Terminal 1', workspaceId: 'ws-A' }])

    await invoke(FOCUS_WINDOW_PANEL, senderFor(null), 't1')

    expect(dock.focus).toHaveBeenCalled()
    expect(dock.sent).toContainEqual({ channel: REVEAL_PANEL_IN_WINDOW, args: ['t1'] })
  })

  it('routes a close request to the owner window (which runs its own gates)', async () => {
    open(1, 'main', 'ws-A')
    const dock = open(211, 'dock', 'ws-A')
    setWindowPanels(211, [{ panelId: 't1', type: 'terminal', title: 'Terminal 1', workspaceId: 'ws-A' }])

    await invoke(CLOSE_WINDOW_PANEL, senderFor(null), 't1')

    expect(dock.focus).toHaveBeenCalled()
    expect(dock.sent).toContainEqual({ channel: CLOSE_PANEL_IN_WINDOW, args: ['t1'] })
  })

  it('is a silent no-op for an unknown panel (the not-found boolean is swallowed)', async () => {
    const dock = open(212, 'dock', 'ws-A')
    setWindowPanels(212, [{ panelId: 't1', type: 'terminal', title: 'Terminal 1', workspaceId: 'ws-A' }])

    // Pins current behavior: the handlers discard reveal/close's boolean, so
    // the invoking renderer resolves undefined either way (the declared API is
    // Promise<void>) and nothing is sent anywhere for an unknown panel.
    expect(await invoke(FOCUS_WINDOW_PANEL, senderFor(null), 'nope')).toBeUndefined()
    expect(await invoke(CLOSE_WINDOW_PANEL, senderFor(null), 'nope')).toBeUndefined()
    expect(dock.focus).not.toHaveBeenCalled()
    // (The window still received the WINDOW_PANELS_CHANGED broadcast from
    // setWindowPanels above; only the routed reveal/close sends must be absent.)
    const routed = dock.sent.filter(
      (m) => m.channel === REVEAL_PANEL_IN_WINDOW || m.channel === CLOSE_PANEL_IN_WINDOW,
    )
    expect(routed).toEqual([])
  })
})
