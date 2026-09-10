import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-ui-state-test-'))

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  ipcMain: { handle: vi.fn() },
}))
vi.mock('chokidar', () => ({ watch: () => ({ on: vi.fn(), close: vi.fn() }) }))

const uiState = await import('./uiStateStore')

beforeAll(() => {
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    telemetryNoticeAcknowledgedVersion: 2,
    onboardingCompleted: true,
  }))
  uiState.loadUIStateSync()
})

afterAll(() => {
  fs.rmSync(userData, { recursive: true, force: true })
})

describe('uiStateStore lifecycle migration', () => {
  it('moves legacy lifecycle flags out of settings without replaying onboarding', () => {
    uiState.migrateLegacyLifecycleState(path.join(userData, 'settings.json'))
    expect(uiState.getUIStateSync('telemetryNoticeAcknowledgedVersion')).toBe(2)
    expect(uiState.getUIStateSync('onboardingCompleted')).toBe(true)
  })

  it('does not overwrite lifecycle values already present in ui-state.json', () => {
    uiState.setUIStateFromMain('telemetryNoticeAcknowledgedVersion', 3)
    uiState.setUIStateFromMain('onboardingCompleted', false)
    uiState.flushUIStateSync()
    uiState.migrateLegacyLifecycleState(path.join(userData, 'settings.json'))
    expect(uiState.getUIStateSync('telemetryNoticeAcknowledgedVersion')).toBe(3)
    expect(uiState.getUIStateSync('onboardingCompleted')).toBe(false)
  })
})
