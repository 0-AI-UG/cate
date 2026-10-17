import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { installCrashRecovery, MAX_RELOADS_IN_WINDOW } from './crashRecovery'

function fakeWindow() {
  const webContents = Object.assign(new EventEmitter(), { reload: vi.fn(), forcefullyCrashRenderer: vi.fn() })
  return Object.assign(new EventEmitter(), { webContents, isDestroyed: () => false, close: vi.fn() })
}

describe('crash recovery', () => {
  it('reloads a crashed window, and asks instead once it keeps crashing', async () => {
    const win = fakeWindow()
    let now = 1_000
    const showMessageBox = vi.fn(async () => ({ response: 1 }))
    const report = vi.fn()
    installCrashRecovery(win as never, 'main', { showMessageBox, report, now: () => now })
    for (let i = 0; i < MAX_RELOADS_IN_WINDOW; i++) {
      win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
      now += 1_000
    }
    expect(win.webContents.reload).toHaveBeenCalledTimes(MAX_RELOADS_IN_WINDOW)
    win.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 1 })
    expect(win.webContents.reload).toHaveBeenCalledTimes(MAX_RELOADS_IN_WINDOW)
    await vi.waitFor(() => expect(win.close).toHaveBeenCalled())
    expect(report).toHaveBeenCalledWith('renderer-process-gone', expect.objectContaining({ reason: 'oom', windowKind: 'main' }))
  })

  it('ignores a clean exit and forgets old crashes', () => {
    const win = fakeWindow()
    let now = 0
    installCrashRecovery(win as never, 'detached', { showMessageBox: vi.fn(), report: vi.fn(), now: () => now })
    win.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
    expect(win.webContents.reload).not.toHaveBeenCalled()
    for (let i = 0; i < MAX_RELOADS_IN_WINDOW + 2; i++) {
      win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
      now += 60_000
    }
    expect(win.webContents.reload).toHaveBeenCalledTimes(MAX_RELOADS_IN_WINDOW + 2)
  })

  it('offers to reload an unresponsive window', async () => {
    const win = fakeWindow()
    installCrashRecovery(win as never, 'main', { showMessageBox: vi.fn(async () => ({ response: 1 })), report: vi.fn() })
    win.emit('unresponsive')
    await vi.waitFor(() => expect(win.webContents.forcefullyCrashRenderer).toHaveBeenCalled())
  })
})
