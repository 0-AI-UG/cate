import { describe, it, expect, vi } from 'vitest'

// runHardExit takes its collaborators as arguments, but shutdown.ts imports the
// whole main process graph (electron + native-backed siblings) at module load.
// Stub every top-level import so the module evaluates in a plain node test env;
// none of these are exercised by the function under test.
//
// The quit confirmation itself lives in ./quitConfirm — see quitConfirm.test.ts
// for decideQuitPrompt and the guard's Cancel/Quit behavior.
vi.mock('electron', () => {
  const e = { app: {}, BrowserWindow: {}, ipcMain: {}, dialog: {} }
  return { ...e, default: e }
})
vi.mock('../logger', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }))
vi.mock('../windows/windowFactory', () => ({ createWindow: () => {} }))
vi.mock('./openPath', () => ({ setMainWindowReady: () => {}, flushPendingOpenPaths: () => {} }))
vi.mock('../windowRegistry', () => ({
  getActiveMainWindow: () => null,
  sendToWindow: () => {},
  listDockWindowIds: () => [],
}))
vi.mock('../windowPanels', () => ({ getWindowPanels: () => [] }))
vi.mock('../dockWindowFlush', () => ({ flushDockWindowsBeforeQuit: () => Promise.resolve() }))
vi.mock('../ipc/terminal', () => ({ flushAllLoggers: () => {}, killAllTerminals: () => {} }))
vi.mock('../ipc/shell', () => ({ getRunningTerminals: () => [] }))
vi.mock('../settingsFile', () => ({ getSetting: () => false, flushPendingWritesSync: () => {} }))
vi.mock('../projectWorkspaceStore', () => ({ saveProjectStateSync: () => {} }))
vi.mock('../workspaceStateStore', () => ({ flushWorkspaceStateSync: () => {} }))
vi.mock('../browserStateStore', () => ({ flushBrowserStateSync: () => {} }))
vi.mock('../uiStateStore', () => ({ flushUIStateSync: () => {} }))
vi.mock('../projectLock', () => ({ releaseAllProjectLocks: () => {} }))
vi.mock('../runtime/runtimeManager', () => ({ runtimes: { disposeAll: () => Promise.resolve() } }))
vi.mock('../extensions/ExtensionServerManager', () => ({
  extensionServerManager: { disposeAll: () => Promise.resolve() },
}))
vi.mock('../extensions/storage', () => ({ flushAllPendingWritesSync: () => {} }))
vi.mock('../auto-updater', () => ({ isUpdatePendingInstall: () => false }))

const { runHardExit } = await import('./shutdown')

describe('runHardExit', () => {
  it('prevents natural teardown, awaits dispose, then exits — in that order', async () => {
    const order: string[] = []
    const preventDefault = vi.fn(() => order.push('preventDefault'))
    const disposeAll = vi.fn(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            order.push('disposed')
            resolve()
          }, 5),
        ),
    )
    const exit = vi.fn(() => order.push('exit'))

    await runHardExit({ preventDefault }, { disposeAll, exit, timeoutMs: 1000 })

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(disposeAll).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(0)
    // preventDefault must run before dispose is even started, and exit only after
    // dispose settles.
    expect(order).toEqual(['preventDefault', 'disposed', 'exit'])
  })

  it('still exits when dispose exceeds the timeout (never hangs quit)', async () => {
    const preventDefault = vi.fn()
    // A dispose that never settles — the timeout must win and exit anyway.
    const disposeAll = vi.fn(() => new Promise<void>(() => {}))
    const exit = vi.fn()

    await runHardExit({ preventDefault }, { disposeAll, exit, timeoutMs: 1 })

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('exits even if dispose rejects', async () => {
    const preventDefault = vi.fn()
    const disposeAll = vi.fn(() => Promise.reject(new Error('boom')))
    const exit = vi.fn()

    await runHardExit({ preventDefault }, { disposeAll, exit, timeoutMs: 1000 })

    expect(exit).toHaveBeenCalledWith(0)
  })
})
