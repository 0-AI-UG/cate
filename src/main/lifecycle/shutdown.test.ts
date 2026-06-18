import { describe, it, expect, vi } from 'vitest'

// decideQuitPrompt is a pure function, but shutdown.ts imports the whole main
// process graph (electron + native-backed siblings) at module load. Stub every
// top-level import so the module evaluates in a plain node test env; none of
// these are exercised by the function under test.
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
vi.mock('../auto-updater', () => ({ isUpdatePendingInstall: () => false }))

const { decideQuitPrompt } = await import('./shutdown')

describe('decideQuitPrompt', () => {
  it('does not prompt when nothing is running and warn-before-quit is off', () => {
    expect(decideQuitPrompt({ warnBeforeQuit: false, running: [] })).toBeNull()
  })

  it('prompts a plain quit confirmation when warn-before-quit is on', () => {
    const prompt = decideQuitPrompt({ warnBeforeQuit: true, running: [] })
    expect(prompt).not.toBeNull()
    expect(prompt!.message).toBe('Quit Cate?')
    expect(prompt!.detail).toBeUndefined()
  })

  it('warns about a single running terminal, naming the process', () => {
    const prompt = decideQuitPrompt({
      warnBeforeQuit: false,
      running: [{ processName: 'npm run dev' }],
    })
    expect(prompt!.message).toBe('“npm run dev” is still running. Quit anyway?')
    expect(prompt!.detail).toContain('process running in this terminal')
  })

  it('falls back to a generic message when the single process name is unknown', () => {
    const prompt = decideQuitPrompt({ warnBeforeQuit: false, running: [{ processName: null }] })
    expect(prompt!.message).toBe('A terminal is still running. Quit anyway?')
  })

  it('counts multiple running terminals', () => {
    const prompt = decideQuitPrompt({
      warnBeforeQuit: false,
      running: [{ processName: 'vim' }, { processName: 'top' }],
    })
    expect(prompt!.message).toBe('2 terminals are still running. Quit anyway?')
    expect(prompt!.detail).toContain('these terminals')
  })

  it('lets a running-terminal warning take precedence over the plain quit prompt', () => {
    const prompt = decideQuitPrompt({
      warnBeforeQuit: true,
      running: [{ processName: 'vim' }],
    })
    expect(prompt!.message).toContain('still running')
  })
})
