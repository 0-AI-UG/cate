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
    checkForUpdatesAndNotify: vi.fn(() => Promise.resolve<unknown>({})),
    checkForUpdates: vi.fn(() => Promise.resolve<unknown>({})),
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
    restartForUpdate: vi.fn(async (install) => { setImmediate(install); return true }),
    cancelUpdateRestart: vi.fn(),
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

  it('does not get stuck checking an installation without an active updater', async () => {
    const { auto, updater, deps } = setup({ showMessageBox: vi.fn(async () => ({ response: 0 })) })
    updater.checkForUpdatesAndNotify.mockResolvedValue(null)
    auto.start()
    auto.checkManually()
    await flush()
    expect(auto.status()).toMatchObject({ state: 'disabled', message: expect.stringContaining('this installation') })
    expect(deps.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ message: 'Update Cate manually' }))
    expect(deps.openExternal).toHaveBeenCalledWith(RELEASES_URL)
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
    expect(deps.openExternal).toHaveBeenCalledWith('https://github.com/0-AI-UG/cate/releases/tag/v1.2.3')
  })

  it('keeps the requested beta release in the manual fallback', async () => {
    const { auto, updater, deps } = setup({ canSelfUpdate: () => false, showMessageBox: vi.fn(async () => ({ response: 0 })) })
    auto.start()
    updater.emit('update-available', { version: '2.1.0-beta.2' })
    await flush()
    expect(deps.openExternal).toHaveBeenCalledWith('https://github.com/0-AI-UG/cate/releases/tag/v2.1.0-beta.2')
  })

  it('uses the latest release page when the failed staged update has no version', async () => {
    const { auto, updater, deps } = setup({ showMessageBox: vi.fn(async () => ({ response: 0 })) })
    auto.start()
    updater.emit('update-downloaded', {})
    updater.emit('error', new Error('Install failed'))
    await flush()
    expect(deps.openExternal).toHaveBeenCalledWith(RELEASES_URL)
  })

  it('an error after a download clears the pending install and offers the manual path', async () => {
    const { auto, updater, deps, statuses } = setup()
    auto.start()
    updater.emit('update-available', { version: '1.2.3' })
    updater.emit('update-downloaded', { version: '1.2.3' })
    updater.emit('error', new Error('ditto: could not read PKZip signature'))
    expect(auto.pendingInstall()).toBe(false)
    expect(deps.cancelUpdateRestart).toHaveBeenCalledOnce()
    expect(deps.showMessageBox).toHaveBeenCalledTimes(1)
    expect(statuses.at(-1)).toMatchObject({ state: 'error', message: 'ditto: could not read PKZip signature' })
  })

  it('a bare check error does not prompt', () => {
    const { auto, updater, deps } = setup()
    auto.start()
    updater.emit('error', new Error('net::ERR_CONNECTION_REFUSED'))
    expect(deps.showMessageBox).not.toHaveBeenCalled()
  })

  it('a manual check reopens the dismissed staged update for every window', () => {
    const { auto, updater, statuses } = setup()
    auto.start()
    updater.emit('update-downloaded', { version: '1.2.3' })
    auto.dismiss('1.2.3')
    auto.checkManually()
    expect(statuses.at(-1)).toEqual({ state: 'downloaded', version: '1.2.3', manual: true })
    expect(auto.status()).toEqual({ state: 'downloaded', version: '1.2.3' })
  })

  it('keeps dismissal in the status read by remounted dialogs and other windows', () => {
    const { auto, updater, statuses } = setup()
    auto.start()
    updater.emit('update-downloaded', { version: '1.2.3' })
    auto.dismiss('1.2.3')
    expect(auto.status()).toEqual({ state: 'downloaded', version: '1.2.3', dismissed: true })
    expect(statuses.at(-1)).toEqual(auto.status())
    expect(auto.pendingInstall()).toBe(true)
    updater.emit('update-downloaded', { version: '1.2.3' })
    expect(auto.status().dismissed).toBe(true)
    updater.emit('update-downloaded', { version: '1.2.4' })
    expect(auto.status()).toEqual({ state: 'downloaded', version: '1.2.4' })
    auto.dismiss('1.2.3')
    expect(auto.status().dismissed).toBeUndefined()
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
    await expect(auto.installNow()).resolves.toBe(false)
    updater.emit('update-downloaded', { version: '1.2.3' })
    await expect(auto.installNow()).resolves.toBe(true)
    await flush()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('keeps the update staged when the quit controller cancels restart', async () => {
    const { auto, updater, deps } = setup({ restartForUpdate: vi.fn(async () => false) })
    auto.start()
    updater.emit('update-downloaded', { version: '1.2.3' })
    await expect(auto.installNow()).resolves.toBe(false)
    await flush()
    expect(deps.restartForUpdate).toHaveBeenCalledOnce()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(auto.status().state).toBe('downloaded')
    expect(auto.pendingInstall()).toBe(true)
  })

  it('handles a synchronous installer failure like an updater error', async () => {
    const { auto, updater, deps } = setup({ showMessageBox: vi.fn(async () => ({ response: 0 })) })
    auto.start()
    updater.emit('update-downloaded', { version: '2.1.0-beta.2' })
    updater.quitAndInstall.mockImplementation(() => { throw new Error('Cannot launch installer') })
    await expect(auto.installNow()).resolves.toBe(true)
    await flush()
    expect(auto.status()).toMatchObject({ state: 'error', message: 'Cannot launch installer' })
    expect(auto.pendingInstall()).toBe(false)
    expect(deps.cancelUpdateRestart).toHaveBeenCalledOnce()
    expect(deps.openExternal).toHaveBeenCalledWith('https://github.com/0-AI-UG/cate/releases/tag/v2.1.0-beta.2')
  })
})
