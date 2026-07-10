import { describe, it, expect, afterEach, vi } from 'vitest'

// windowRegistry only touches win.id / win.on / win.isDestroyed for the bits
// under test, so a lightweight fake stands in for a real BrowserWindow.
vi.mock('electron', () => {
  const electron = { BrowserWindow: {} }
  return { ...electron, default: electron }
})
vi.mock('./perf/perfMonitor', () => ({ PERF_ENABLED: false, countIpc: () => {} }))

const {
  registerWindow,
  getActiveMainWindow,
  getWindowWorkspaceId,
  setDockWindowState,
  listDockWindows,
  closeWindowsForWorkspace,
} = await import('./windowRegistry')

interface FakeWin {
  id: number
  destroyed: boolean
  bounds: { x: number; y: number; width: number; height: number }
  on(ev: string, cb: () => void): void
  emit(ev: string): void
  isDestroyed(): boolean
  getBounds(): { x: number; y: number; width: number; height: number }
  destroy(): void
  webContents: { send: () => void }
}

let nextId = 1
const created: FakeWin[] = []

function makeWin(): FakeWin {
  const listeners: Record<string, Array<() => void>> = {}
  const win: FakeWin = {
    id: nextId++,
    destroyed: false,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    on(ev, cb) { (listeners[ev] ??= []).push(cb) },
    emit(ev) { (listeners[ev] ?? []).forEach((f) => f()) },
    isDestroyed() { return this.destroyed },
    getBounds() { return this.bounds },
    destroy() { this.destroyed = true; this.emit('closed') },
    webContents: { send: () => {} },
  }
  created.push(win)
  return win
}

function register(type: 'main' | 'dock', workspaceId?: string): FakeWin {
  const win = makeWin()
  registerWindow(win as never, type, workspaceId)
  return win
}

function destroy(win: FakeWin): void {
  win.destroyed = true
  win.emit('closed')
}

afterEach(() => {
  // Tear down every window so module-level maps don't leak across tests.
  for (const win of created) if (!win.destroyed) destroy(win)
  created.length = 0
})

describe('getActiveMainWindow', () => {
  it('returns the most recently registered main window by default', () => {
    register('main')
    const b = register('main')
    expect(getActiveMainWindow()).toBe(b)
  })

  it('tracks focus — the last-focused main window wins', () => {
    const a = register('main')
    register('main')
    a.emit('focus')
    expect(getActiveMainWindow()).toBe(a)
  })

  it('ignores focus from non-main windows', () => {
    const main = register('main')
    const dock = register('dock', 'w1')
    dock.emit('focus')
    expect(getActiveMainWindow()).toBe(main)
  })

  it('falls back to another live main window when the active one closes', () => {
    const a = register('main')
    const b = register('main')
    a.emit('focus')
    destroy(a)
    expect(getActiveMainWindow()).toBe(b)
  })

  it('returns undefined when no main window exists', () => {
    register('dock', 'w1')
    expect(getActiveMainWindow()).toBeUndefined()
  })
})

describe('getWindowWorkspaceId', () => {
  it('returns the workspace a dock/panel window was created for', () => {
    const dock = register('dock', 'workspace-abc')
    expect(getWindowWorkspaceId(dock.id)).toBe('workspace-abc')
  })

  it('dock-state sync can NOT change the window workspace id (creation is the single source of truth)', () => {
    const dock = register('dock', 'ws-created')
    // A stale renderer might still echo a workspaceId (e.g. its process-local
    // stub) — it must be ignored, or the window would drop out of session.json.
    setDockWindowState(dock.id, {
      dockState: { zones: {} } as never,
      panels: {},
      workspaceId: 'synced-ws',
    } as never)
    expect(getWindowWorkspaceId(dock.id)).toBe('ws-created')
  })

  it('returns undefined for an unknown window', () => {
    expect(getWindowWorkspaceId(99999)).toBeUndefined()
  })
})

describe('closeWindowsForWorkspace', () => {
  it('destroys dock windows of the given workspace and leaves others', () => {
    const main = register('main')
    const dockA = register('dock', 'ws-A')
    const dockA2 = register('dock', 'ws-A')
    const dockB = register('dock', 'ws-B')

    closeWindowsForWorkspace('ws-A')

    expect(dockA.destroyed).toBe(true)
    expect(dockA2.destroyed).toBe(true)
    expect(dockB.destroyed).toBe(false)
    expect(main.destroyed).toBe(false)
  })

  it('is a no-op for a workspace with no detached windows', () => {
    const dock = register('dock', 'ws-A')
    closeWindowsForWorkspace('ws-other')
    expect(dock.destroyed).toBe(false)
  })
})

describe('listDockWindows', () => {
  // FIX: DockWindowShell used to sync {...getSnapshot()} (i.e. {zones, locations})
  // with NO `dockState` field, so listDockWindows() produced snapshots whose
  // dockState was undefined and restore threw "Cannot read properties of
  // undefined (reading 'zones')". This locks in the contract that the shell now
  // feeds a populated `dockState`.
  function tabsDockState() {
    return {
      zones: {
        left: { position: 'left', visible: false, size: 0, layout: null },
        right: { position: 'right', visible: false, size: 0, layout: null },
        bottom: { position: 'bottom', visible: false, size: 0, layout: null },
        center: {
          position: 'center',
          visible: true,
          size: 0,
          layout: { type: 'tabs', id: 'center-stack', panelIds: ['p1'], activeIndex: 0 },
        },
      },
    }
  }

  it('round-trips a populated dockState set via setDockWindowState', () => {
    const dock = register('dock', 'ws-dock')
    dock.bounds = { x: 120, y: 80, width: 900, height: 700 }

    setDockWindowState(dock.id, {
      dockState: tabsDockState() as never,
      panels: { p1: { id: 'p1', type: 'terminal', title: 'zsh', isDirty: false } } as never,
      terminalCwds: { p1: '/work/p1' },
      canvasStates: {},
    })

    const listed = listDockWindows()
    const entry = listed.find((e) => e.windowId === dock.id)
    expect(entry).toBeDefined()
    // The bug: dockState was undefined here. Assert it (and its zones) is present.
    expect(entry!.dockState).toBeDefined()
    expect(entry!.dockState.zones).toBeDefined()
    expect(entry!.dockState.zones.center.layout).toEqual({
      type: 'tabs',
      id: 'center-stack',
      panelIds: ['p1'],
      activeIndex: 0,
    })
    expect(entry!.workspaceId).toBe('ws-dock')
    expect(entry!.bounds).toEqual({ x: 120, y: 80, width: 900, height: 700 })
    expect(entry!.terminalCwds).toEqual({ p1: '/work/p1' })
  })

  it('omits dock windows that have not synced any state yet', () => {
    const dock = register('dock', 'ws-unsynced')
    expect(listDockWindows().find((e) => e.windowId === dock.id)).toBeUndefined()
  })
})
