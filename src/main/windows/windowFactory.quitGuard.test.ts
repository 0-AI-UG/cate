// =============================================================================
// createWindow close gate — closing the LAST main window IS quitting the app, so
// it must route into the quit sequence (app.quit()) instead of tearing itself
// down, and it must do so while the window is still alive.
//
// The bugs this pins: the old path destroyed the main window (reaping every
// detached dock window with it) and only then hit window-all-closed →
// app.quit() → 'before-quit'. By then the confirmation had no window to attach
// to — cancelling left a running app with zero windows, which looks exactly like
// a quit, and the next 'activate' built a fresh window, which looks like a
// restart — and the session flush found no renderer, silently skipping the
// terminal CWD/scrollback save.
//
// Driven through the REAL createWindow + REAL windowRegistry with only the
// Electron shell and window-scoped collaborators faked — same harness shape as
// windowFactory.flushOnClose.test.ts, plus a 'close' event object carrying
// preventDefault (Electron passes one; that file's fake didn't need it).
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

const hooks = vi.hoisted(() => {
  let nextId = 1
  const created: FakeWin[] = []

  interface FakeWin {
    id: number
    destroyed: boolean
    emit(ev: string, e?: unknown): void
    close(): void
    destroy(): void
    webContents: { emit(ev: string, e?: unknown): void; send(channel: string, ...args: unknown[]): void }
    [key: string]: unknown
  }

  function makeEmitter() {
    const once: Record<string, Array<(e: unknown) => void>> = {}
    const on: Record<string, Array<(e: unknown) => void>> = {}
    return {
      once(ev: string, cb: (e: unknown) => void) { (once[ev] ??= []).push(cb) },
      on(ev: string, cb: (e: unknown) => void) { (on[ev] ??= []).push(cb) },
      emit(ev: string, e?: unknown) {
        const fired = once[ev] ?? []
        once[ev] = []
        fired.forEach((f) => f(e))
        ;(on[ev] ?? []).forEach((f) => f(e))
      },
    }
  }

  function makeWin(): FakeWin {
    const win: FakeWin = {
      ...makeEmitter(),
      id: nextId++,
      destroyed: false,
      webContents: { ...makeEmitter(), send() {} },
      loadURL() {},
      loadFile() {},
      show() {},
      focus() {},
      isDestroyed() { return win.destroyed },
      getPosition() { return [0, 0] },
      getSize() { return [800, 600] },
      isMinimized() { return false },
      isFullScreen() { return false },
      isMaximized() { return false },
      // Electron: close() runs the 'close' gate with a preventable event; a
      // listener calling preventDefault() keeps the window alive.
      close() {
        let prevented = false
        win.emit('close', { preventDefault: () => { prevented = true } })
        if (prevented) return
        win.destroyed = true
        win.emit('closed')
      },
      destroy() {
        win.destroyed = true
        win.emit('closed')
      },
    }
    created.push(win)
    return win
  }

  return { created, makeWin }
})

const appState = vi.hoisted(() => ({ quitCalls: 0 }))

vi.mock('electron', () => {
  const BrowserWindow = function () { return hooks.makeWin() }
  const electron = {
    BrowserWindow,
    app: { quit: () => { appState.quitCalls++ } },
    nativeImage: { createFromPath: () => ({}) },
    nativeTheme: { themeSource: 'system' },
  }
  return { ...electron, default: electron }
})

vi.mock('../logger', () => ({ default: { info() {}, warn() {}, debug() {}, error() {} } }))
vi.mock('./reveal', () => ({ revealWindow: () => {}, IS_E2E: false }))
vi.mock('./crashRecovery', () => ({ installRendererCrashRecovery: () => {} }))
vi.mock('./fullscreen', () => ({ anyWindowFullscreen: () => false }))
vi.mock('../store', () => ({ readBootSnapshot: () => null, writeBootSnapshot: () => {} }))
vi.mock('../perf/perfMonitor', () => ({ PERF_ENABLED: false, countIpc: () => {} }))
vi.mock('../ipc/filesystem', () => ({ stopWatchersForWindow: () => {} }))
vi.mock('../ipc/git-monitor', () => ({ stopMonitorsForWindow: () => {} }))
vi.mock('../ipc/search', () => ({ stopSearchesForWindow: () => {} }))
vi.mock('../ipc/pathValidation', () => ({
  clearFileGrantsForWindow: () => {},
  clearScopedWriteAllowancesForWindow: () => {},
  grantFileAccess: () => Promise.resolve(),
}))
vi.mock('../runtime/runtimeManager', () => ({
  forwardFileGrant: () => {},
  forwardClearFileGrantsForWindow: () => {},
  forwardClearScopedWriteAllowancesForWindow: () => {},
}))
vi.mock('../grantedPathStore', () => ({ listPersistentGrants: () => Promise.resolve([]) }))
vi.mock('../menu', () => ({ rebuildApplicationMenu: () => {} }))
vi.mock('../featureFlags', () => ({ disableRendererSandbox: () => false }))
// Real quitConfirm state — only its data sources are faked.
vi.mock('../settingsFile', () => ({ getSetting: () => false }))
vi.mock('../ipc/shell', () => ({ getRunningTerminals: () => [] }))

const { createWindow } = await import('./windowFactory')
const { markQuitCommitted, resetQuitAttempt } = await import('../lifecycle/quitConfirm')

type FakeWin = ReturnType<typeof hooks.makeWin>

describe('createWindow main-window close → quit sequence routing', () => {
  beforeEach(() => {
    appState.quitCalls = 0
    resetQuitAttempt()
    // Drop any window a previous test left registered so the shared registry
    // (active-main tracking) starts clean. destroy() skips the 'close' gate.
    for (const w of [...hooks.created]) { if (!w.destroyed) w.destroy() }
    hooks.created.length = 0
  })

  // The core of both fixes: the window must still be alive when the quit
  // sequence runs, so 'before-quit' has something to prompt on and a live
  // renderer to flush the session from.
  it('closing the last main window defers to app.quit() and keeps the window alive', () => {
    const main = createWindow({ type: 'main' }) as unknown as FakeWin

    main.close()

    expect(appState.quitCalls).toBe(1)
    expect(main.destroyed).toBe(false)
  })

  it('keeps detached dock windows alive too while the quit sequence runs', () => {
    const main = createWindow({ type: 'main' }) as unknown as FakeWin
    const dock = createWindow({ type: 'dock', workspaceId: 'ws-A' }) as unknown as FakeWin

    main.close()

    // The reap loop lives past the gate's early return — nothing is torn down
    // until the quit actually commits (so a Cancel leaves the docks standing).
    expect(main.destroyed).toBe(false)
    expect(dock.destroyed).toBe(false)
  })

  it('once the quit is committed, the close goes through and reaps dock windows', () => {
    const main = createWindow({ type: 'main' }) as unknown as FakeWin
    const dock = createWindow({ type: 'dock', workspaceId: 'ws-A' }) as unknown as FakeWin

    // What before-quit does after confirming + flushing the session.
    markQuitCommitted()
    main.close()

    expect(main.destroyed).toBe(true)
    expect(dock.destroyed).toBe(true)
    // No re-entrant app.quit() — Electron is already tearing down.
    expect(appState.quitCalls).toBe(0)
  })

  it('does not re-enter app.quit() when the committed close cascades', () => {
    const main = createWindow({ type: 'main' }) as unknown as FakeWin
    main.close()
    expect(appState.quitCalls).toBe(1)

    // The quit sequence commits and Electron closes the window for real.
    markQuitCommitted()
    main.close()

    expect(main.destroyed).toBe(true)
    expect(appState.quitCalls).toBe(1) // still 1 — no loop
  })

  it('closing a non-last main window closes normally without quitting the app', () => {
    const first = createWindow({ type: 'main' }) as unknown as FakeWin
    createWindow({ type: 'main' })

    first.close()

    expect(first.destroyed).toBe(true)
    expect(appState.quitCalls).toBe(0)
  })

  it('routes only once the last main window of several is closed', () => {
    const first = createWindow({ type: 'main' }) as unknown as FakeWin
    const second = createWindow({ type: 'main' }) as unknown as FakeWin

    first.close() // not last — closes silently
    expect(appState.quitCalls).toBe(0)
    expect(first.destroyed).toBe(true)

    second.close() // now the last one — routes into the quit sequence
    expect(appState.quitCalls).toBe(1)
    expect(second.destroyed).toBe(false)
  })

  it('closing a dock window never routes into the quit sequence', () => {
    createWindow({ type: 'main' })
    const dock = createWindow({ type: 'dock', workspaceId: 'ws-A' }) as unknown as FakeWin

    dock.close()

    expect(appState.quitCalls).toBe(0)
    expect(dock.destroyed).toBe(true)
  })
})
