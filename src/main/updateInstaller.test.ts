import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const isInApplicationsFolder = vi.fn()
vi.mock('electron', () => ({
  app: {
    isInApplicationsFolder: () => isInApplicationsFolder(),
    getVersion: () => '1.2.1',
  },
}))

import {
  canSelfUpdate,
  startInstallWatchdog,
  performUpdateInstall,
  isUpdateInstalling,
  __resetInstallerForTests,
} from './updateInstaller'

describe('canSelfUpdate', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('returns true on non-darwin regardless of folder', () => {
    expect(canSelfUpdate('win32')).toBe(true)
    expect(canSelfUpdate('linux')).toBe(true)
  })

  it('returns true on darwin only when in /Applications (not translocated)', () => {
    isInApplicationsFolder.mockReturnValue(true)
    expect(canSelfUpdate('darwin')).toBe(true)
  })

  it('returns false on darwin when translocated / not in /Applications', () => {
    isInApplicationsFolder.mockReturnValue(false)
    expect(canSelfUpdate('darwin')).toBe(false)
  })

  it('returns true on darwin if the API throws (do not block the existing path)', () => {
    isInApplicationsFolder.mockImplementation(() => { throw new Error('unavailable') })
    expect(canSelfUpdate('darwin')).toBe(true)
  })
})

describe('startInstallWatchdog', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires onTimeout if not cancelled before the deadline', () => {
    const onTimeout = vi.fn()
    startInstallWatchdog(20000, onTimeout)
    vi.advanceTimersByTime(19999)
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledOnce()
  })

  it('does not fire if cancelled', () => {
    const onTimeout = vi.fn()
    const cancel = startInstallWatchdog(20000, onTimeout)
    cancel()
    vi.advanceTimersByTime(60000)
    expect(onTimeout).not.toHaveBeenCalled()
  })
})

describe('performUpdateInstall', () => {
  beforeEach(() => { vi.useRealTimers(); __resetInstallerForTests() })

  const baseDeps = () => ({
    platform: 'darwin' as NodeJS.Platform,
    canSelfUpdate: () => true,
    flushSession: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn(),
    quitAndInstall: vi.fn(),
    broadcast: vi.fn(),
    manualReleaseUrl: 'https://example/releases',
    version: '1.3.0',
  })

  it('runs flush → teardown → quitAndInstall when eligible', async () => {
    const d = baseDeps()
    await performUpdateInstall(d)
    expect(d.flushSession).toHaveBeenCalledOnce()
    expect(d.teardown).toHaveBeenCalledOnce()
    expect(d.quitAndInstall).toHaveBeenCalledOnce()
    expect(isUpdateInstalling()).toBe(true)
  })

  it('orders flush before teardown before quitAndInstall', async () => {
    const calls: string[] = []
    const d = {
      ...baseDeps(),
      flushSession: vi.fn().mockImplementation(async () => { calls.push('flush') }),
      teardown: vi.fn().mockImplementation(() => { calls.push('teardown') }),
      quitAndInstall: vi.fn().mockImplementation(() => { calls.push('quit') }),
    }
    await performUpdateInstall(d)
    expect(calls).toEqual(['flush', 'teardown', 'quit'])
  })

  it('does NOT quitAndInstall when ineligible; broadcasts manual', async () => {
    const d = { ...baseDeps(), canSelfUpdate: () => false }
    await performUpdateInstall(d)
    expect(d.quitAndInstall).not.toHaveBeenCalled()
    expect(d.teardown).not.toHaveBeenCalled()
    expect(d.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'manual', releaseUrl: 'https://example/releases', version: '1.3.0' }),
    )
    expect(isUpdateInstalling()).toBe(false)
  })

  it('is idempotent (second call is a no-op while installing)', async () => {
    const d = baseDeps()
    await performUpdateInstall(d)
    await performUpdateInstall(d)
    expect(d.quitAndInstall).toHaveBeenCalledOnce()
  })
})
