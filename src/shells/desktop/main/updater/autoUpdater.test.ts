import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '../../contract'
import { createAutoUpdater, RELEASES_URL, type AutoUpdaterDeps } from './autoUpdater'
import { MAX_INSTALL_ATTEMPTS, type UpdateRecord } from './updateState'

function setup(overrides: Partial<AutoUpdaterDeps> & { packaged?: boolean; version?: string; record?: UpdateRecord } = {}) {
  const updater = Object.assign(new EventEmitter(), {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    forceDevUpdateConfig: false,
    disableDifferentialDownload: false,
    checkForUpdatesAndNotify: vi.fn(() => Promise.resolve(null)),
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    quitAndInstall: vi.fn(),
  })
  let record: UpdateRecord = overrides.record ?? { pendingVersion: null, attempts: 0 }
  const timers: (() => void)[] = []
  const statuses: UpdateStatus[] = []
  const deps: AutoUpdaterDeps = {
    updater,
    app: { isPackaged: overrides.packaged ?? true, getVersion: () => overrides.version ?? '1.2.2', moveToApplicationsFolder: vi.fn(() => true) },
    state: { get: () => record, set: (next) => { record = next } },
    track: vi.fn(),
    broadcast: (status) => { statuses.push(status) },
    showMessageBox: vi.fn(() => Promise.resolve({ response: 1 })),
    openExternal: vi.fn(),
    canSelfUpdate: () => true,
    betaUpdatesEnabled: () => false,
    setTimeout: (fn) => { timers.push(fn) },
    setInterval: () => {},
    ...overrides,
  }
  const auto = createAutoUpdater(deps)
  return { auto, updater, deps, statuses, timers, record: () => record }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('auto updater', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is disabled in an unpackaged build and explains why', () => {
    const { auto, updater, statuses } = setup({ packaged: false })
    auto.start()
    expect(updater.listenerCount('update-downloaded')).toBe(0)
    expect(statuses.at(-1)).toMatchObject({ state: 'disabled' })
    auto.checkManually()
    expect(statuses.at(-1)).toMatchObject({ state: 'disabled', manual: true })
  })

  it('mirrors eligibility into auto download/install and the beta opt-in into prereleases', () => {
    const ineligible = setup({ canSelfUpdate: () => false, betaUpdatesEnabled: () => true })
    ineligible.auto.start()
    expect(ineligible.updater.autoDownload).toBe(false)
    expect(ineligible.updater.autoInstallOnAppQuit).toBe(false)
    expect(ineligible.updater.allowPrerelease).toBe(true)
    expect(ineligible.updater.disableDifferentialDownload).toBe(true)
  })

  it('checks shortly after launch and stops once an update is staged', async () => {
    const { auto, updater, timers } = setup()
    auto.start()
    timers[0]()
    await flush()
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1)
    updater.emit('update-downloaded', { version: '1.2.3' })
    auto.checkManually()
    await flush()
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1)
    expect(auto.pendingInstall()).toBe(true)
  })

  it('tracks check_started once per session and progress in milestones', () => {
    const { auto, updater, deps } = setup()
    auto.start()
    updater.emit('checking-for-update')
    updater.emit('checking-for-update')
    for (const percent of [1, 10, 26, 30, 51, 76, 99, 100]) updater.emit('download-progress', { percent })
    const names = vi.mocked(deps.track).mock.calls.map(([name, props]) => (name === 'update_download_progress' ? `p${(props as { percent: number }).percent}` : name))
    expect(names.filter((n) => n === 'update_check_started')).toHaveLength(1)
    expect(names.filter((n) => n.startsWith('p'))).toEqual(['p0', 'p25', 'p50', 'p75', 'p100'])
  })

  it('keeps the attempt count when the same version is staged again', () => {
    // Launch on 1.2.2 with 1.2.3 staged: one failed attempt, then it downloads again.
    const same = setup({ record: { pendingVersion: '1.2.3', attempts: 0 } })
    same.auto.start()
    expect(same.record()).toEqual({ pendingVersion: '1.2.3', attempts: 1 })
    same.updater.emit('update-downloaded', { version: '1.2.3' })
    expect(same.record()).toEqual({ pendingVersion: '1.2.3', attempts: 1 })
    const other = setup({ record: { pendingVersion: '1.2.3', attempts: 0 } })
    other.auto.start()
    other.updater.emit('update-downloaded', { version: '2.0.0' })
    expect(other.record()).toEqual({ pendingVersion: '2.0.0', attempts: 0 })
  })

  it('clears the record when the staged version came up', () => {
    const { auto, deps, record } = setup({ version: '1.2.3', record: { pendingVersion: '1.2.3', attempts: 0 } })
    auto.start()
    expect(record()).toEqual({ pendingVersion: null, attempts: 0 })
    expect(deps.track).toHaveBeenCalledWith('update_install_succeeded', { version: '1.2.3' })
  })

  it('offers the manual download after repeated failed installs', () => {
    const { auto, deps } = setup({ record: { pendingVersion: '1.2.3', attempts: MAX_INSTALL_ATTEMPTS - 1 } })
    auto.start()
    expect(deps.showMessageBox).toHaveBeenCalledTimes(1)
    expect(deps.track).toHaveBeenCalledWith('update_install_failed_repeatedly', { version: '1.2.3' })
  })

  it('prompts once when ineligible and an update is found, and opens the releases page', async () => {
    const { auto, updater, deps } = setup({ canSelfUpdate: () => false, showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })) })
    auto.start()
    updater.emit('update-available', { version: '1.2.3' })
    updater.emit('update-available', { version: '1.2.3' })
    await flush()
    expect(deps.showMessageBox).toHaveBeenCalledTimes(1)
    expect(deps.openExternal).toHaveBeenCalledWith(RELEASES_URL)
  })

  it('an error after a download clears the pending install and offers the manual path', async () => {
    const { auto, updater, deps, statuses } = setup()
    auto.start()
    updater.emit('update-available', { version: '1.2.3' })
    updater.emit('update-downloaded', { version: '1.2.3' })
    updater.emit('error', new Error('ditto: could not read PKZip signature'))
    expect(auto.pendingInstall()).toBe(false)
    expect(deps.showMessageBox).toHaveBeenCalledTimes(1)
    expect(statuses.at(-1)).toMatchObject({ state: 'error', message: 'ditto: could not read PKZip signature' })
  })

  it('a bare check error does not prompt', () => {
    const { auto, updater, deps } = setup()
    auto.start()
    updater.emit('error', new Error('net::ERR_CONNECTION_REFUSED'))
    expect(deps.showMessageBox).not.toHaveBeenCalled()
  })

  it('a manual check re-surfaces a staged update with forceShow', () => {
    const { auto, updater, statuses } = setup()
    auto.start()
    updater.emit('update-downloaded', { version: '1.2.3' })
    auto.checkManually()
    expect(statuses.at(-1)).toEqual({ state: 'downloaded', version: '1.2.3', forceShow: true })
    expect(auto.status()).toEqual({ state: 'downloaded', version: '1.2.3' })
  })

  it('marks the answer to a manual check and not later background results', async () => {
    const { auto, updater, statuses } = setup()
    auto.start()
    auto.checkManually()
    await flush()
    updater.emit('update-not-available', {})
    expect(statuses.at(-1)).toEqual({ state: 'up-to-date', version: null, manual: true })
    updater.emit('checking-for-update')
    updater.emit('update-not-available', {})
    expect(statuses.at(-1)).toEqual({ state: 'up-to-date', version: null })
  })

  it('installs only a staged update', async () => {
    const { auto, updater } = setup()
    auto.start()
    expect(auto.installNow()).toBe(false)
    updater.emit('update-downloaded', { version: '1.2.3' })
    expect(auto.installNow()).toBe(true)
    await flush()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })
})
