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
} = await import('./windowRegistry')

interface FakeWin {
  id: number
  destroyed: boolean
  on(ev: string, cb: () => void): void
  emit(ev: string): void
  isDestroyed(): boolean
  webContents: { send: () => void }
}

let nextId = 1
const created: FakeWin[] = []

function makeWin(): FakeWin {
  const listeners: Record<string, Array<() => void>> = {}
  const win: FakeWin = {
    id: nextId++,
    destroyed: false,
    on(ev, cb) { (listeners[ev] ??= []).push(cb) },
    emit(ev) { (listeners[ev] ?? []).forEach((f) => f()) },
    isDestroyed() { return this.destroyed },
    webContents: { send: () => {} },
  }
  created.push(win)
  return win
}

function register(type: 'main' | 'dock' | 'panel', workspaceId?: string): FakeWin {
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

  it('falls back to the latest synced dock state', () => {
    const dock = register('dock')
    setDockWindowState(dock.id, {
      dockState: { zones: {} } as never,
      panels: {},
      workspaceId: 'synced-ws',
    })
    expect(getWindowWorkspaceId(dock.id)).toBe('synced-ws')
  })

  it('returns undefined for an unknown window', () => {
    expect(getWindowWorkspaceId(99999)).toBeUndefined()
  })
})
