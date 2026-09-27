import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.directory } }))
vi.mock('./logger', () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('chokidar', () => ({ watch: () => ({ on: vi.fn(), close: vi.fn() }) }))
let settings: typeof import('./settingsFile') | undefined

afterEach(() => {
  settings?.flushPendingWritesSync()
  if (fixture.directory) rmSync(fixture.directory, { recursive: true, force: true })
})

test('obsolete approval overrides are ignored when loading settings', async () => {
  fixture.directory = mkdtempSync(path.join(tmpdir(), 'cate-approval-settings-'))
  const file = path.join(fixture.directory, 'settings.json')
  writeFileSync(file, JSON.stringify({ agentApprovalMode: { workspace: { codex: 'manual' } } }))
  vi.resetModules()
  settings = await import('./settingsFile')
  settings.loadSettingsSync()
  expect(settings.isSettingsKey('agentApprovalMode')).toBe(false)
  expect(settings.getAllSettings()).not.toHaveProperty('agentApprovalMode')
  settings.setSetting('warnBeforeQuit', false)
  settings.flushPendingWritesSync()
  expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('agentApprovalMode')
})
