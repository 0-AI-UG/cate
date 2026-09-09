import { describe, it, expect, vi } from 'vitest'

// runHardExit takes its collaborators as arguments, but shutdown.ts imports the
// whole main process graph (electron + native-backed siblings) at module load.
// Stub every top-level import so the module evaluates in a plain node test env;
// none of these are exercised by the function under test.
//
// The quit confirmation itself lives in ./quitConfirm — see quitConfirm.test.ts
// for decideQuitPrompt and the guard's Cancel/Quit behavior.
const lifecycle = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => void>(), ack: null as ((...args: any[]) => void) | null, quit: vi.fn(), requestId: undefined as string | undefined, active: null as any, committed: false, dockFlush: vi.fn(async () => {}) }))
vi.mock('electron', () => {
  const e = { app: { on: (name: string, fn: (...args: any[]) => void) => lifecycle.handlers.set(name, fn), quit: lifecycle.quit }, BrowserWindow: {}, ipcMain: { once: (_name: string, fn: (...args: any[]) => void) => { lifecycle.ack = fn }, on: (_name: string, fn: (...args: any[]) => void) => { lifecycle.ack = fn }, removeListener: vi.fn() }, dialog: { showErrorBox: vi.fn() }, session: { fromPartition: () => ({ cookies: { flushStore: async () => {} }, flushStorageData: () => {} }) } }
  return { ...e, default: e }
})
vi.mock('../logger', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }))
vi.mock('../windows/windowFactory', () => ({ createWindow: () => {} }))
vi.mock('./openPath', () => ({ setMainWindowReady: () => {}, flushPendingOpenPaths: () => {} }))
vi.mock('../windowRegistry', () => ({
  getActiveMainWindow: () => lifecycle.active,
  listWindows: () => [],
  windowFromEvent: (event: any) => event.sender,
  sendToWindow: (_id: number, channel: string, requestId?: string) => { if (channel === 'session:flushSave') lifecycle.requestId = requestId },
  listDockWindowIds: () => [],
}))
vi.mock('../windowPanels', () => ({ getWindowPanels: () => [] }))
vi.mock('../dockWindowFlush', () => ({ flushDockWindowsBeforeQuit: lifecycle.dockFlush }))
vi.mock('../ipc/terminal', () => ({ flushAllLoggers: () => {}, killAllTerminals: () => {} }))
vi.mock('../ipc/shell', () => ({ getRunningTerminals: () => [] }))
vi.mock('../settingsFile', () => ({ getSetting: () => false, flushPendingWritesSync: () => {} }))
vi.mock('../projectWorkspaceStore', () => ({ saveProjectStateSync: () => {} }))
vi.mock('../workspaceStateStore', () => ({ flushWorkspaceStateSync: () => {} }))
vi.mock('../browserStateStore', () => ({ flushBrowserStateSync: () => {} }))
vi.mock('../uiStateStore', () => ({ flushUIStateSync: () => {} }))
vi.mock('../projectLock', () => ({ releaseAllProjectLocks: () => {} }))
vi.mock('../runtime/runtimeManager', () => ({ runtimes: { disposeAll: () => Promise.resolve() } }))
vi.mock('../t3Agent/T3HarnessManager', () => ({
  t3HarnessManager: { disposeAll: () => Promise.resolve() },
}))
vi.mock('../auto-updater', () => ({ isUpdatePendingInstall: () => false }))

vi.mock('./quitConfirm', () => ({ guardQuit: () => 'pass', isQuitCommitted: () => lifecycle.committed, markQuitCommitted: () => { lifecycle.committed = true }, resetQuitAttempt: () => { lifecycle.committed = false } }))
vi.mock('../cateApi/workspaceCateApi', () => ({ workspaceCateApi: { disposeAll: async () => {} } }))

const { flushPersistentBrowserSession, runHardExit, registerLifecycleHandlers } = await import('./shutdown')

describe('flushPersistentBrowserSession', () => {
  it('flushes DOM storage and awaits the cookie store before quit continues', async () => {
    const order: string[] = []
    const flushStore = vi.fn(async () => { order.push('cookies') })
    const flushStorageData = vi.fn(() => { order.push('storage') })

    await flushPersistentBrowserSession({
      cookies: { flushStore },
      flushStorageData,
    } as unknown as Electron.Session)

    expect(flushStorageData).toHaveBeenCalledOnce()
    expect(flushStore).toHaveBeenCalledOnce()
    expect(order).toEqual(['storage', 'cookies'])
  })
})

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


describe('quit session durability', () => {
  it('cancels an explicitly failed save without a later timeout quitting anyway', async () => {
    vi.useFakeTimers()
    lifecycle.committed = false
    lifecycle.quit.mockClear()
    lifecycle.active = { id: 7, webContents: { id: 42 }, isDestroyed: () => false }
    registerLifecycleHandlers()
    lifecycle.handlers.get('before-quit')!({ preventDefault: vi.fn() })
    await vi.advanceTimersByTimeAsync(0)
    lifecycle.ack!({ sender: lifecycle.active }, 'disk full', lifecycle.requestId)
    await vi.advanceTimersByTimeAsync(2000)
    expect(lifecycle.quit).not.toHaveBeenCalled()
    expect(lifecycle.committed).toBe(false)
    lifecycle.active = null
    vi.useRealTimers()
  })
  it('ignores acknowledgements from a different owner or abandoned attempt', async () => {
    vi.useFakeTimers()
    lifecycle.committed = false
    lifecycle.quit.mockClear()
    lifecycle.active = { id: 7, webContents: { id: 42 }, isDestroyed: () => false }
    registerLifecycleHandlers()
    lifecycle.handlers.get('before-quit')!({ preventDefault: vi.fn() })
    await vi.advanceTimersByTimeAsync(0)
    lifecycle.ack!({ sender: { id: 8 } }, undefined, lifecycle.requestId)
    lifecycle.ack!({ sender: lifecycle.active }, undefined, 'previous-attempt')
    await vi.advanceTimersByTimeAsync(0)
    expect(lifecycle.quit).not.toHaveBeenCalled()
    lifecycle.ack!({ sender: lifecycle.active }, undefined, lifecycle.requestId)
    await vi.advanceTimersByTimeAsync(0)
    expect(lifecycle.quit).toHaveBeenCalledTimes(1)
    lifecycle.active = null
    lifecycle.committed = false
    vi.useRealTimers()
  })

  it('keeps editors alive when no durable-save acknowledgement arrives', async () => {
    vi.useFakeTimers()
    lifecycle.committed = false
    lifecycle.quit.mockClear()
    lifecycle.active = { id: 7, webContents: { id: 42 }, isDestroyed: () => false }
    registerLifecycleHandlers()
    lifecycle.handlers.get('before-quit')!({ preventDefault: vi.fn() })
    await vi.advanceTimersByTimeAsync(16_000)
    expect(lifecycle.quit).not.toHaveBeenCalled()
    expect(lifecycle.committed).toBe(false)
    lifecycle.active = null
    vi.useRealTimers()
  })

})

it('flushes every created persistent Chromium session rather than only the shared browser partition', async () => {
  registerLifecycleHandlers()
  const shared = { isPersistent: () => true, cookies: { flushStore: vi.fn(async () => {}) }, flushStorageData: vi.fn() }
  const proxy = { isPersistent: () => true, cookies: { flushStore: vi.fn(async () => {}) }, flushStorageData: vi.fn() }
  const agent = { isPersistent: () => true, cookies: { flushStore: vi.fn(async () => {}) }, flushStorageData: vi.fn() }
  const transient = { isPersistent: () => false, cookies: { flushStore: vi.fn(async () => {}) }, flushStorageData: vi.fn() }
  for (const session of [shared, proxy, agent, transient, proxy]) lifecycle.handlers.get('session-created')?.(session)
  await flushPersistentBrowserSession()
  for (const session of [shared, proxy, agent]) {
    expect(session.cookies.flushStore).toHaveBeenCalledOnce()
    expect(session.flushStorageData).toHaveBeenCalledOnce()
  }
  expect(transient.cookies.flushStore).not.toHaveBeenCalled()
})


it('aborts quit when a detached owner cannot confirm durability', async () => {
  vi.useFakeTimers()
  try {
    lifecycle.committed = false
    lifecycle.requestId = undefined
    lifecycle.quit.mockClear()
    lifecycle.active = { id: 7, webContents: { id: 42 }, isDestroyed: () => false }
    lifecycle.dockFlush.mockRejectedValueOnce(new Error('Dock window sync timed out'))
    registerLifecycleHandlers()
    lifecycle.handlers.get('before-quit')!({ preventDefault: vi.fn() })
    await vi.advanceTimersByTimeAsync(0)
    expect(lifecycle.requestId).toBeUndefined()
    expect(lifecycle.quit).not.toHaveBeenCalled()
    expect(lifecycle.committed).toBe(false)
  } finally { lifecycle.active = null; vi.useRealTimers() }
})

it('keeps windows open when a persistent Chromium flush fails', async () => {
  vi.useFakeTimers()
  const sessions = await import('../browser/persistentSessions')
  const failingFlush = vi.spyOn(sessions, 'flushPersistentSessions').mockRejectedValueOnce(new Error('cookie write failed'))
  try {
    lifecycle.committed = false
    lifecycle.quit.mockClear()
    lifecycle.active = { id: 7, webContents: { id: 42 }, isDestroyed: () => false }
    registerLifecycleHandlers()
    lifecycle.handlers.get('before-quit')!({ preventDefault: vi.fn() })
    await vi.advanceTimersByTimeAsync(0)
    lifecycle.ack!({ sender: lifecycle.active }, undefined, lifecycle.requestId)
    await vi.advanceTimersByTimeAsync(0)
    expect(lifecycle.quit).not.toHaveBeenCalled()
    expect(lifecycle.committed).toBe(false)
  } finally { failingFlush.mockRestore(); lifecycle.active = null; vi.useRealTimers() }
})

it('flushes persistent sessions even when no main renderer remains', async () => {
  const sessions = await import('../browser/persistentSessions')
  const flush = vi.spyOn(sessions, 'flushPersistentSessions').mockResolvedValueOnce(undefined)
  lifecycle.committed = false
  lifecycle.quit.mockClear()
  lifecycle.active = null
  try {
    registerLifecycleHandlers()
    lifecycle.handlers.get('before-quit')!({ preventDefault: vi.fn() })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(flush).toHaveBeenCalledOnce()
  } finally { flush.mockRestore(); lifecycle.committed = false }
})
