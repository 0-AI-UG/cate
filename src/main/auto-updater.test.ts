import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DEFAULT_UPDATE_RECORD, type UpdateRecord } from './updateState'

// ---------------------------------------------------------------------------
// Mocks. electron-updater's autoUpdater is an EventEmitter with stubbed methods
// + settable config flags. electron app/dialog/shell, the settings store, the
// eligibility check, the analytics emitter, the logger, and the json-state
// factory are all faked so the module under test runs in plain node.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  const { EventEmitter } = require('events') as typeof import('events')
  const autoUpdater = Object.assign(new EventEmitter(), {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    forceDevUpdateConfig: false,
    checkForUpdatesAndNotify: vi.fn(() => Promise.resolve(null)),
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    downloadUpdate: vi.fn(() => Promise.resolve()),
    quitAndInstall: vi.fn(),
  })
  // In-memory createJsonStateFile: one record cell the test can read/seed.
  // The factory does NOT reset the cell — load()/get() return whatever the test
  // seeded, modelling "what's already on disk" for the launch-time detector.
  const cell: { value: UpdateRecord } = { value: { pendingVersion: null, attempts: 0 } }
  const createJsonStateFile = vi.fn(() => {
    return {
      load: () => cell.value,
      get: () => cell.value,
      set: (v: UpdateRecord) => { cell.value = v },
      update: (fn: (c: UpdateRecord) => UpdateRecord) => { cell.value = fn(cell.value) },
      getPath: () => '/tmp/update-state.json',
      ensureFile: async () => '/tmp/update-state.json',
      startWatching: () => {},
      stopWatching: () => {},
      flushPendingWritesSync: () => {},
    }
  })
  return {
    autoUpdater,
    cell,
    createJsonStateFile,
    app: {
      isPackaged: true,
      getVersion: vi.fn(() => '1.2.2'),
      getPath: vi.fn(() => '/tmp'),
      isInApplicationsFolder: vi.fn(() => true),
      moveToApplicationsFolder: vi.fn(),
    },
    dialog: { showMessageBox: vi.fn(() => Promise.resolve({ response: 1 })), showMessageBoxSync: vi.fn(() => 1) },
    shell: { openExternal: vi.fn(() => Promise.resolve()) },
    ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
    broadcastToAll: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    sendEvent: vi.fn((_name: string, _props?: Record<string, unknown>) => Promise.resolve(true)),
    getSettingSync: vi.fn(() => false),
    canSelfUpdate: vi.fn(() => true),
  }
})

vi.mock('electron-updater', () => ({ autoUpdater: h.autoUpdater }))
vi.mock('electron', () => ({ app: h.app, dialog: h.dialog, shell: h.shell, ipcMain: h.ipcMain }))
vi.mock('./windowRegistry', () => ({ broadcastToAll: h.broadcastToAll }))
vi.mock('./logger', () => ({ default: h.log }))
vi.mock('./store', () => ({ getSettingSync: h.getSettingSync }))
vi.mock('./updateInstaller', () => ({ canSelfUpdate: h.canSelfUpdate }))
vi.mock('./analytics', () => ({ sendEvent: h.sendEvent }))
vi.mock('./jsonStateFile', () => ({ createJsonStateFile: h.createJsonStateFile }))

// Fresh module state per test (module-level flags + the store singleton).
async function loadModule(): Promise<typeof import('./auto-updater')> {
  vi.resetModules()
  return import('./auto-updater')
}

function seedRecord(rec: UpdateRecord): void {
  h.cell.value = rec
}

// The manual-fallback dialog resolves via microtasks (a resolved
// showMessageBox), not timers — flush the microtask queue without touching the
// 15-minute setInterval (which vi.runAllTimersAsync would loop on forever).
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  h.autoUpdater.removeAllListeners()
  h.autoUpdater.autoDownload = false
  h.autoUpdater.autoInstallOnAppQuit = false
  h.autoUpdater.allowPrerelease = false
  h.autoUpdater.forceDevUpdateConfig = false
  h.app.isPackaged = true
  h.app.getVersion.mockReturnValue('1.2.2')
  h.canSelfUpdate.mockReturnValue(true)
  h.getSettingSync.mockReturnValue(false)
  h.dialog.showMessageBox.mockResolvedValue({ response: 1 })
  h.cell.value = { ...DEFAULT_UPDATE_RECORD }
  delete process.env.CATE_DEV_UPDATE
})

afterEach(() => {
  vi.useRealTimers()
})

describe('initAutoUpdater — config', () => {
  it('is a no-op in dev (not packaged, no CATE_DEV_UPDATE): no events, no check', async () => {
    h.app.isPackaged = false
    const { initAutoUpdater } = await loadModule()
    initAutoUpdater()
    expect(h.autoUpdater.listenerCount('update-downloaded')).toBe(0)
    vi.advanceTimersByTime(10_000)
    expect(h.autoUpdater.checkForUpdatesAndNotify).not.toHaveBeenCalled()
  })

  it('mirrors canSelfUpdate() into autoDownload/autoInstallOnAppQuit', async () => {
    h.canSelfUpdate.mockReturnValue(true)
    const { initAutoUpdater } = await loadModule()
    initAutoUpdater()
    expect(h.autoUpdater.autoDownload).toBe(true)
    expect(h.autoUpdater.autoInstallOnAppQuit).toBe(true)
  })

  it('disables auto download/install when ineligible (translocated mac)', async () => {
    h.canSelfUpdate.mockReturnValue(false)
    const { initAutoUpdater } = await loadModule()
    initAutoUpdater()
    expect(h.autoUpdater.autoDownload).toBe(false)
    expect(h.autoUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('reflects the beta opt-in into allowPrerelease', async () => {
    h.getSettingSync.mockReturnValue(true)
    const { initAutoUpdater } = await loadModule()
    initAutoUpdater()
    expect(h.autoUpdater.allowPrerelease).toBe(true)
  })

  it('schedules a check shortly after launch', async () => {
    const { initAutoUpdater } = await loadModule()
    initAutoUpdater()
    vi.advanceTimersByTime(6000)
    expect(h.autoUpdater.checkForUpdatesAndNotify).toHaveBeenCalled()
  })

  it('dev-update mode: wires events, forces dev config, and treats as eligible', async () => {
    h.app.isPackaged = false
    process.env.CATE_DEV_UPDATE = '1'
    h.canSelfUpdate.mockReturnValue(false) // repo checkout is never in /Applications
    const { initAutoUpdater } = await loadModule()
    initAutoUpdater()
    expect(h.autoUpdater.forceDevUpdateConfig).toBe(true)
    expect(h.autoUpdater.autoDownload).toBe(true)
    expect(h.autoUpdater.listenerCount('update-downloaded')).toBe(1)
  })

  it('dev-update mode: does NOT persist or evaluate install-loop state', async () => {
    h.app.isPackaged = false
    process.env.CATE_DEV_UPDATE = '1'
    seedRecord({ pendingVersion: '1.2.3', attempts: 1 }) // would trip give-up if evaluated
    const { initAutoUpdater } = await loadModule()
    initAutoUpdater()
    // launch-time evaluation skipped → no manual prompt, record untouched
    expect(h.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(h.cell.value).toEqual({ pendingVersion: '1.2.3', attempts: 1 })
    // a downloaded dummy update must not write the record either
    h.autoUpdater.emit('update-downloaded', { version: '99.0.0' })
    expect(h.cell.value).toEqual({ pendingVersion: '1.2.3', attempts: 1 })
  })
})

describe('initAutoUpdater — event telemetry', () => {
  async function initAndGet() {
    const mod = await loadModule()
    mod.initAutoUpdater()
    return mod
  }

  it('emits update_check_started on checking-for-update', async () => {
    await initAndGet()
    h.autoUpdater.emit('checking-for-update')
    expect(h.sendEvent).toHaveBeenCalledWith('update_check_started', expect.anything())
  })

  it('emits update_check_started only once per session despite the 15-min poll', async () => {
    // The updater checks on launch and every 15 minutes thereafter. Tracking
    // every check turns this into an uptime heartbeat that swamps real
    // user-action events in analytics — collapse it to once per process.
    await initAndGet()
    h.autoUpdater.emit('checking-for-update')
    h.autoUpdater.emit('checking-for-update')
    h.autoUpdater.emit('checking-for-update')
    const calls = h.sendEvent.mock.calls.filter((c) => c[0] === 'update_check_started')
    expect(calls.length).toBe(1)
  })

  it('emits update_available with the version', async () => {
    await initAndGet()
    h.autoUpdater.emit('update-available', { version: '1.2.3' })
    expect(h.sendEvent).toHaveBeenCalledWith('update_available', expect.objectContaining({ version: '1.2.3' }))
  })

  it('logs but does not emit on update-not-available', async () => {
    await initAndGet()
    h.autoUpdater.emit('update-not-available', { version: '1.2.2' })
    expect(h.sendEvent).not.toHaveBeenCalledWith('update_not_available', expect.anything())
  })

  it('emits update_error and logs on error', async () => {
    await initAndGet()
    h.autoUpdater.emit('error', new Error('boom'))
    expect(h.log.error).toHaveBeenCalled()
    expect(h.sendEvent).toHaveBeenCalledWith('update_error', expect.objectContaining({ message: 'boom' }))
  })

  it('throttles download-progress to milestone buckets', async () => {
    await initAndGet()
    for (const p of [3, 10, 26, 30, 51, 76, 99, 100]) {
      h.autoUpdater.emit('download-progress', { percent: p })
    }
    const progressCalls = h.sendEvent.mock.calls.filter((c) => c[0] === 'update_download_progress')
    // 0/25/50/75/100 buckets crossed once each — not one per event.
    expect(progressCalls.length).toBeGreaterThan(0)
    expect(progressCalls.length).toBeLessThanOrEqual(5)
  })

  it('on update-downloaded: flips pending flag, emits, and records the version', async () => {
    const mod = await initAndGet()
    expect(mod.isUpdatePendingInstall()).toBe(false)
    h.autoUpdater.emit('update-downloaded', { version: '1.2.3' })
    expect(mod.isUpdatePendingInstall()).toBe(true)
    expect(h.sendEvent).toHaveBeenCalledWith('update_downloaded', expect.objectContaining({ version: '1.2.3' }))
    expect(h.cell.value).toEqual({ pendingVersion: '1.2.3', attempts: 0 })
  })

  it('on update-downloaded: preserves attempts when re-staging the same version', async () => {
    await initAndGet()
    // A silent install failure re-downloads the same version next launch — the
    // accumulated failure count must survive so the loop detector can progress.
    h.cell.value = { pendingVersion: '1.2.3', attempts: 1 }
    h.autoUpdater.emit('update-downloaded', { version: '1.2.3' })
    expect(h.cell.value).toEqual({ pendingVersion: '1.2.3', attempts: 1 })
  })

  it('on update-downloaded: resets attempts for a genuinely new version', async () => {
    await initAndGet()
    h.cell.value = { pendingVersion: '1.2.3', attempts: 1 }
    h.autoUpdater.emit('update-downloaded', { version: '2.0.0' })
    expect(h.cell.value).toEqual({ pendingVersion: '2.0.0', attempts: 0 })
  })
})

describe('install-loop detection on launch', () => {
  it('clears the record and emits success when we came up on the staged version', async () => {
    seedRecord({ pendingVersion: '1.2.2', attempts: 1 })
    h.app.getVersion.mockReturnValue('1.2.2')
    const { initAutoUpdater } = await loadModule()
    initAutoUpdater()
    expect(h.cell.value).toEqual(DEFAULT_UPDATE_RECORD)
    expect(h.sendEvent).toHaveBeenCalledWith('update_install_succeeded', expect.anything())
  })

  it('shows the manual fallback after repeated failed installs', async () => {
    seedRecord({ pendingVersion: '1.2.3', attempts: 1 }) // this launch tips it to the cap
    h.app.getVersion.mockReturnValue('1.2.2')
    const { initAutoUpdater } = await loadModule()
    initAutoUpdater()
    expect(h.sendEvent).toHaveBeenCalledWith('update_install_failed_repeatedly', expect.anything())
    expect(h.dialog.showMessageBox).toHaveBeenCalled()
  })

  it('does not prompt on the first failed install (still retrying)', async () => {
    seedRecord({ pendingVersion: '1.2.3', attempts: 0 })
    h.app.getVersion.mockReturnValue('1.2.2')
    const { initAutoUpdater } = await loadModule()
    initAutoUpdater()
    expect(h.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(h.cell.value).toEqual({ pendingVersion: '1.2.3', attempts: 1 })
  })

  it('reaches the manual fallback across launches despite re-downloading each launch', async () => {
    // Regression: the silent-install-failure loop re-downloads the same version
    // every launch. If update-downloaded zeroed the attempt counter, the give-up
    // path would be unreachable. Drive the real launch → re-download → launch loop.
    h.app.getVersion.mockReturnValue('1.2.2') // the install never advances

    const launch = async () => {
      h.autoUpdater.removeAllListeners() // fresh process: only this launch's handlers
      const { initAutoUpdater } = await loadModule()
      initAutoUpdater()
    }

    // Launch 1: update downloads and stages.
    await launch()
    h.autoUpdater.emit('update-downloaded', { version: '1.2.3' })
    expect(h.cell.value).toEqual({ pendingVersion: '1.2.3', attempts: 0 })

    // Launch 2: install silently failed → retry (no prompt); the updater then
    // re-downloads the SAME version, which must NOT reset the attempt counter.
    await launch()
    expect(h.cell.value).toEqual({ pendingVersion: '1.2.3', attempts: 1 })
    expect(h.dialog.showMessageBox).not.toHaveBeenCalled()
    h.autoUpdater.emit('update-downloaded', { version: '1.2.3' })
    expect(h.cell.value).toEqual({ pendingVersion: '1.2.3', attempts: 1 })

    // Launch 3: still on the old version → counter hits the cap → manual fallback.
    await launch()
    expect(h.sendEvent).toHaveBeenCalledWith('update_install_failed_repeatedly', expect.anything())
    expect(h.dialog.showMessageBox).toHaveBeenCalled()
  })
})

describe('manual-reinstall fallback', () => {
  it('ineligible + update-available opens a native prompt offering the download', async () => {
    h.canSelfUpdate.mockReturnValue(false)
    h.dialog.showMessageBox.mockResolvedValue({ response: 0 }) // "Download latest"
    const { initAutoUpdater } = await loadModule()
    initAutoUpdater()
    h.autoUpdater.emit('update-available', { version: '1.2.3' })
    await flushMicrotasks()
    expect(h.dialog.showMessageBox).toHaveBeenCalled()
    expect(h.shell.openExternal).toHaveBeenCalledWith(expect.stringContaining('github.com/0-AI-UG/cate/releases'))
  })

  it('prompts at most once per launch', async () => {
    h.canSelfUpdate.mockReturnValue(false)
    h.dialog.showMessageBox.mockResolvedValue({ response: 1 }) // "Later"
    const { initAutoUpdater } = await loadModule()
    initAutoUpdater()
    h.autoUpdater.emit('update-available', { version: '1.2.3' })
    await flushMicrotasks()
    h.autoUpdater.emit('update-available', { version: '1.2.3' })
    await flushMicrotasks()
    expect(h.dialog.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('an error AFTER an update was found offers the manual download', async () => {
    h.dialog.showMessageBox.mockResolvedValue({ response: 0 }) // "Download latest"
    const { initAutoUpdater } = await loadModule()
    initAutoUpdater()
    h.autoUpdater.emit('update-available', { version: '1.2.3' })
    h.autoUpdater.emit('error', new Error('ditto: Couldn’t read PKZip signature'))
    await flushMicrotasks()
    expect(h.dialog.showMessageBox).toHaveBeenCalled()
    expect(h.shell.openExternal).toHaveBeenCalledWith(expect.stringContaining('github.com/0-AI-UG/cate/releases'))
  })

  it('a bare error with no update found does NOT prompt (e.g. transient check failure)', async () => {
    const { initAutoUpdater } = await loadModule()
    initAutoUpdater()
    h.autoUpdater.emit('error', new Error('net::ERR_CONNECTION_REFUSED'))
    await flushMicrotasks()
    expect(h.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('an error after a download clears the pending-install flag (staging failed)', async () => {
    const mod = await loadModule()
    mod.initAutoUpdater()
    h.autoUpdater.emit('update-available', { version: '1.2.3' })
    h.autoUpdater.emit('update-downloaded', { version: '1.2.3' })
    expect(mod.isUpdatePendingInstall()).toBe(true)
    h.autoUpdater.emit('error', new Error('ditto: Couldn’t read PKZip signature'))
    expect(mod.isUpdatePendingInstall()).toBe(false)
  })

  it('checkForUpdatesManually re-arms the prompt', async () => {
    h.canSelfUpdate.mockReturnValue(false)
    h.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    const { initAutoUpdater, checkForUpdatesManually } = await loadModule()
    initAutoUpdater()
    h.autoUpdater.emit('update-available', { version: '1.2.3' })
    await flushMicrotasks()
    checkForUpdatesManually()
    h.autoUpdater.emit('update-available', { version: '1.2.3' })
    await flushMicrotasks()
    expect(h.dialog.showMessageBox).toHaveBeenCalledTimes(2)
  })
})
