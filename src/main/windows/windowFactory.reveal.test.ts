import { describe, it, expect, beforeEach, vi } from 'vitest'

// Regression cover for the startup bug where a hidden window could stay
// invisible forever: on some cold-launch paths 'ready-to-show' never fires, so
// the reveal must also be driven by the renderer's 'did-finish-load' — exactly
// once across both events.

// Shared test state lives in a hoisted block so the vi.mock factories (hoisted
// above imports) can reach it.
const hooks = vi.hoisted(() => {
  const revealWindow = vi.fn()
  let nextId = 1
  const created: Array<Record<string, unknown>> = []

  function makeEmitter() {
    const once: Record<string, Array<() => void>> = {}
    const on: Record<string, Array<() => void>> = {}
    return {
      once(ev: string, cb: () => void) { (once[ev] ??= []).push(cb) },
      on(ev: string, cb: () => void) { (on[ev] ??= []).push(cb) },
      emit(ev: string) {
        const fired = once[ev] ?? []
        once[ev] = []
        fired.forEach((f) => f())
        ;(on[ev] ?? []).forEach((f) => f())
      },
    }
  }

  function makeWin() {
    const webContents = { ...makeEmitter(), send() {} }
    const win = {
      ...makeEmitter(),
      id: nextId++,
      destroyed: false,
      webContents,
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
    } as unknown as Record<string, unknown>
    created.push(win)
    return win
  }

  return { revealWindow, created, makeWin }
})

vi.mock('electron', () => {
  const BrowserWindow = function () { return hooks.makeWin() } as unknown as {
    (): unknown
    getAllWindows: () => unknown[]
  }
  BrowserWindow.getAllWindows = () =>
    hooks.created.filter((w) => !(w as { destroyed: boolean }).destroyed)
  const electron = {
    BrowserWindow,
    nativeImage: { createFromPath: () => ({}) },
    nativeTheme: { themeSource: 'system' },
  }
  return { ...electron, default: electron }
})

vi.mock('../logger', () => ({
  default: { info() {}, warn() {}, debug() {}, error() {} },
}))
vi.mock('./reveal', () => ({ revealWindow: hooks.revealWindow, IS_E2E: false }))
vi.mock('./crashRecovery', () => ({ installRendererCrashRecovery: () => {} }))
vi.mock('./fullscreen', () => ({ anyWindowFullscreen: () => false }))
vi.mock('../store', () => ({ readBootSnapshot: () => null, writeBootSnapshot: () => {} }))
vi.mock('../windowRegistry', () => ({
  registerWindow: () => {},
  getWindowType: () => undefined,
  getActiveMainWindow: () => null,
}))
vi.mock('../ipc/filesystem', () => ({ stopWatchersForWindow: () => {} }))
vi.mock('../ipc/shell', () => ({ unregisterTerminalsForWindow: () => {} }))
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

const { createWindow } = await import('./windowFactory')

interface FakeWin {
  emit(ev: string): void
  webContents: { emit(ev: string): void }
}

describe('createWindow reveal wiring', () => {
  beforeEach(() => {
    hooks.revealWindow.mockClear()
    hooks.created.length = 0
  })

  it('reveals once on ready-to-show', () => {
    const win = createWindow({ type: 'main' }) as unknown as FakeWin
    expect(hooks.revealWindow).not.toHaveBeenCalled()
    win.emit('ready-to-show')
    expect(hooks.revealWindow).toHaveBeenCalledTimes(1)
  })

  // The actual regression: a startup path where ready-to-show never arrives.
  // Before the fix the window stayed hidden forever; now did-finish-load
  // reveals it as a fallback.
  it('reveals via did-finish-load when ready-to-show never fires', () => {
    const win = createWindow({ type: 'main' }) as unknown as FakeWin
    win.webContents.emit('did-finish-load')
    expect(hooks.revealWindow).toHaveBeenCalledTimes(1)
  })

  it('reveals exactly once when both events fire', () => {
    const win = createWindow({ type: 'main' }) as unknown as FakeWin
    win.emit('ready-to-show')
    win.webContents.emit('did-finish-load')
    expect(hooks.revealWindow).toHaveBeenCalledTimes(1)
  })
})
