// =============================================================================
// Telemetry consent gating — verifies analytics sends NOTHING until the user
// has made a first-run choice (telemetryConsentDecided), and respects the
// usage-analytics toggle afterward. No network call must happen while gated.
// =============================================================================

import { describe, expect, test, vi, beforeEach } from 'vitest'

const settings: Record<string, unknown> = {}
const netRequest = vi.fn()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', getLocale: () => 'en', isPackaged: false, getPath: () => '/tmp' },
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

const { sendEvent } = await import('./analytics')

beforeEach(() => {
  netRequest.mockClear()
  for (const k of Object.keys(settings)) delete settings[k]
})

describe('telemetry consent gating', () => {
  test('no send before a consent decision, even with usage analytics on', async () => {
    settings.telemetryConsentDecided = false
    settings.usageAnalyticsEnabled = true
    const ok = await sendEvent('app_start')
    expect(ok).toBe(false)
    expect(netRequest).not.toHaveBeenCalled()
  })

  test('no send when consent is given but usage analytics is declined', async () => {
    settings.telemetryConsentDecided = true
    settings.usageAnalyticsEnabled = false
    const ok = await sendEvent('app_start')
    expect(ok).toBe(false)
    expect(netRequest).not.toHaveBeenCalled()
  })

  test('attempts to send once consent is given and usage analytics is on', async () => {
    settings.telemetryConsentDecided = true
    settings.usageAnalyticsEnabled = true
    // netRequest is a bare stub (no callbacks), so the post will fail and the
    // event buffers — but the point is the gate now lets it reach the network.
    await sendEvent('app_start')
    expect(netRequest).toHaveBeenCalledTimes(1)
  })
})
