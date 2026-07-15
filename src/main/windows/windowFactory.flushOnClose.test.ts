// =============================================================================
// createWindow close wiring — a closing dock window must trigger an immediate
// session save so session.json drops it: windowFactory's 'closed' handler sends
// SESSION_FLUSH_SAVE to the active MAIN window for any non-main window. Driven
// through the REAL createWindow + REAL windowRegistry (registration, active-main
// lookup, sendToWindow, closeWindowsForWorkspace) with only the Electron shell
// and window-scoped cleanup collaborators faked — the same harness shape as
// windowFactory.reveal.test.ts.
//
// The fake BrowserWindow mirrors Electron's documented lifecycle: close() emits
// 'close' (with a preventable event) then 'closed'; destroy() skips 'close' but
// still emits 'closed'.
//
// Note on the main window: its 'close' gate routes the last main window into the
// quit sequence (app.quit()) instead of closing, so the teardown these tests
// exercise only happens once the quit is committed — see
// windowFactory.quitGuard.test.ts. Cases below commit it explicitly.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

const hooks = vi.hoisted(() => {
  let nextId = 1
  const created: FakeWin[] = []

  interface FakeWin {
    id: number
    destroyed: boolean
    sent: Array<{ channel: string; args: unknown[] }>
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
    const sent: FakeWin['sent'] = []
    const win: FakeWin = {
      ...makeEmitter(),
      id: nextId++,
      destroyed: false,
      sent,
      webContents: {
        ...makeEmitter(),
        send(channel: string, ...args: unknown[]) { sent.push({ channel, args }) },
      },
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
      // Electron: close() runs the 'close' gate with a preventable event, then
      // (if no listener prevented it) tears down and emits 'closed'.
      close() {
        let prevented = false
        win.emit('close', { preventDefault: () => { prevented = true } })
        if (prevented) return
        win.destroyed = true
        win.emit('closed')
      },
      // Electron: destroy() skips 'close'/unload but GUARANTEES 'closed' fires.
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

vi.mock('electron', () => {
  const BrowserWindow = function () { return hooks.makeWin() }
  const electron = {
    BrowserWindow,
    app: { quit: () => {} },
    nativeImage: { createFromPath: () => ({}) },
    nativeTheme: { themeSource: 'system' },
  }
  return { ...electron, default: electron }
})

vi.mock('../logger', () => ({
  default: { info() {}, warn() {}, debug() {}, error() {} },
}))
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
vi.mock('../settingsFile', () => ({ getSetting: () => false }))
vi.mock('../ipc/shell', () => ({ getRunningTerminals: () => [] }))

const { createWindow } = await import('./windowFactory')
const { markQuitCommitted, resetQuitAttempt } = await import('../lifecycle/quitConfirm')
const { closeWindowsForWorkspace } = await import('../windowRegistry')
const { SESSION_FLUSH_SAVE } = await import('../../shared/ipc-channels')

type FakeWin = ReturnType<typeof hooks.makeWin>

const flushesTo = (win: FakeWin): number =>
  win.sent.filter((m) => m.channel === SESSION_FLUSH_SAVE).length

describe('createWindow close -> session flush wiring', () => {
  beforeEach(() => {
    resetQuitAttempt()
    // Drop any window a previous test left registered so the shared registry
    // (active-main tracking, workspace maps) starts clean. destroy() rather than
    // close() — close() on a lone main window now defers to the quit sequence.
    for (const w of [...hooks.created]) { if (!w.destroyed) w.destroy() }
    hooks.created.length = 0
  })

  it('closing a dock window sends SESSION_FLUSH_SAVE to the active main window', () => {
    const main = createWindow({ type: 'main' }) as unknown as FakeWin
    const dock = createWindow({ type: 'dock', workspaceId: 'ws-A' }) as unknown as FakeWin

    expect(flushesTo(main)).toBe(0)
    dock.close()

    expect(flushesTo(main)).toBe(1)
    expect(flushesTo(dock)).toBe(0)
  })

  it('closing the main window itself does not take the flush path', () => {
    const main = createWindow({ type: 'main' }) as unknown as FakeWin
    markQuitCommitted() // as before-quit does, once it has confirmed + flushed
    main.close()
    expect(main.destroyed).toBe(true)
    expect(flushesTo(main)).toBe(0)
  })

  it('destroy() via closeWindowsForWorkspace still hits the flush (Electron emits closed on destroy)', () => {
    // Pins current behavior: workspace teardown destroys dock windows to skip
    // their 'close'-time save/re-integration gates, but Electron guarantees
    // 'closed' fires even for destroy(), and windowFactory's 'closed' handler
    // does not distinguish the two — so the main window is still asked to
    // flush the session. Today that is redundant-but-harmless (the flush
    // re-saves a session without the destroyed windows); if teardown ever must
    // truly skip the save, the handler needs its own signal, not destroy().
    const main = createWindow({ type: 'main' }) as unknown as FakeWin
    createWindow({ type: 'dock', workspaceId: 'ws-A' })
    const otherDock = createWindow({ type: 'dock', workspaceId: 'ws-B' }) as unknown as FakeWin

    closeWindowsForWorkspace('ws-A')

    expect(flushesTo(main)).toBe(1)
    // Only ws-A's window was destroyed.
    expect(otherDock.destroyed).toBe(false)
  })

  it('a dock window closing after the main window is gone flushes nowhere (no-op, no throw)', () => {
    const main = createWindow({ type: 'main' }) as unknown as FakeWin
    const dock = createWindow({ type: 'dock', workspaceId: 'ws-A' }) as unknown as FakeWin

    // Real quit order: once the quit is committed, main's 'close' handler
    // close()s the docks while main is still registered, so each dock flush
    // targets the dying-but-live main. Pinned here: main.close() cascades into
    // dock.close(), whose 'closed' flush is sent to main BEFORE main's own
    // 'closed' unregisters it.
    markQuitCommitted()
    main.close()
    expect(dock.destroyed).toBe(true)
    expect(flushesTo(main)).toBe(1)

    // A straggler dock closing with NO main window left must not throw.
    const lateDock = createWindow({ type: 'dock', workspaceId: 'ws-A' }) as unknown as FakeWin
    expect(() => lateDock.close()).not.toThrow()
    expect(flushesTo(main)).toBe(1)
  })
})
