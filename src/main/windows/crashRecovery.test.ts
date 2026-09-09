import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ send: vi.fn(), stopTerminals: vi.fn(), stopWatchers: vi.fn(), stopSearches: vi.fn(), stopMonitors: vi.fn(), snapshot: { windowId: 7, workspaceId: 'ws', dockState: { zones: {} }, panels: { editor: { id: 'editor', type: 'editor', unsavedContent: 'recover me' } }, canvasStates: {} } }))
vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() }, BrowserWindow: {} }))
vi.mock('../logger', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))
vi.mock('../sentry', () => ({ captureMainMessage: vi.fn() }))
vi.mock('../windowRegistry', () => ({ listDockWindows: () => [h.snapshot], sendToWindow: h.send }))
vi.mock('../ipc/terminal', () => ({ stopTerminalsForRenderer: h.stopTerminals }))
vi.mock('../ipc/filesystem', () => ({ stopWatchersForWindow: h.stopWatchers }))
vi.mock('../ipc/search', () => ({ stopSearchesForWindow: h.stopSearches }))
vi.mock('../ipc/git-monitor', () => ({ stopMonitorsForWindow: h.stopMonitors }))
import { installRendererCrashRecovery } from './crashRecovery'
import { DOCK_WINDOW_INIT } from '../../shared/ipc-channels'
it('rehydrates a replacement dock renderer from current main-owned state', () => {
  const wc = Object.assign(new EventEmitter(), { reload: vi.fn() })
  const win = Object.assign(new EventEmitter(), { webContents: wc, isDestroyed: () => false })
  installRendererCrashRecovery(win as any, 'dock', 7)
  wc.emit('did-finish-load')
  wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  expect(h.stopTerminals).toHaveBeenCalledWith(7)
  expect(h.stopWatchers).toHaveBeenCalledWith(7)
  expect(wc.reload).toHaveBeenCalledOnce()
  wc.emit('did-finish-load')
  expect(h.send).toHaveBeenCalledWith(7, DOCK_WINDOW_INIT, expect.objectContaining({ workspaceId: 'ws', panels: h.snapshot.panels, dockState: h.snapshot.dockState.zones, restore: true }))
})
