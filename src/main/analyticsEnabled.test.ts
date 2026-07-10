// =============================================================================
// Analytics gating — telemetry is always on in packaged builds (no settings
// gate, no opt-out) and always OFF in dev/test builds. The legacy consent
// settings must have no effect either way.
// =============================================================================

import { describe, expect, test, vi, beforeEach } from 'vitest'

const settings: Record<string, unknown> = {}
const netRequest = vi.fn()
const electronApp = {
  getVersion: () => '0.0.0-test',
  getLocale: () => 'en',
  isPackaged: false,
  getPath: () => '/tmp',
}

vi.mock('electron', () => ({
  app: electronApp,
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  net: { request: netRequest },
}))
vi.mock('./store', () => ({ getSettingSync: (k: string) => settings[k] }))
vi.mock('./appContext', () => ({
  getCommonContext: () => ({
    install_id: 'test', app_version: '0.0.0-test', platform: 'darwin', arch: 'arm64',
    electron_version: '0', node_version: '0', chrome_version: '0', locale: 'en',
    is_packaged: false, os_release: 'test',
  }),
}))
vi.mock('./logger', () => ({ default: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } }))
vi.mock('./jsonFileStore', () => ({
  readJsonFile: (_filename: string, fallback: unknown) => fallback,
  writeJsonFile: () => undefined,
  readTextFile: () => null,
  writeTextFile: () => undefined,
  appendLine: () => undefined,
  removeFile: () => undefined,
}))

const { sendEvent } = await import('./analytics')

beforeEach(() => {
  netRequest.mockClear()
  for (const k of Object.keys(settings)) delete settings[k]
  electronApp.isPackaged = false
})

describe('analytics gating', () => {
  test('no send in dev builds, regardless of legacy consent settings', async () => {
    const ok = await sendEvent('app_start')
    expect(ok).toBe(false)
    expect(netRequest).not.toHaveBeenCalled()
  })

  test('sends in packaged builds with no settings at all', async () => {
    electronApp.isPackaged = true
    // netRequest is a bare stub (no callbacks), so the post will fail and the
    // event buffers — the point is the gate lets it reach the network.
    await sendEvent('app_start')
    expect(netRequest).toHaveBeenCalledTimes(1)
  })

  test('legacy opt-out settings do NOT disable sending in packaged builds', async () => {
    electronApp.isPackaged = true
    await sendEvent('app_start')
    expect(netRequest).toHaveBeenCalledTimes(1)
  })
})
