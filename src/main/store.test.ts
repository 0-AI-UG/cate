// =============================================================================
// store.ts resilience — a corrupt config.json must NOT break the store IPC
// surface for the whole session. AppSettings live in settings.json and the
// workspace-state keys live in their own files (see ./workspaceStateStore), so
// neither is affected by a corrupt legacy config.json:
//   1. SETTINGS_GET still returns defaults.
//   2. LAYOUT_LIST (backed by layouts.json) still resolves — to [] — and the
//      corrupt config.json is preserved as a `config.json.corrupt-*` backup
//      instead of crashing the migration.
// =============================================================================

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-store-test-'))
const cfgPath = path.join(userData, 'config.json')

const handlers = new Map<string, (...args: any[]) => any>()
vi.mock('electron', () => {
  const electron = {
    app: { getPath: () => userData, getVersion: () => '0.0.0-test', getName: () => 'cate-test', isPackaged: false },
    ipcMain: { on: vi.fn(), handle: vi.fn((c: string, fn: any) => handlers.set(c, fn)) },
    nativeTheme: { on: vi.fn(), themeSource: 'system' },
    BrowserWindow: { getAllWindows: () => [] },
    shell: {},
  }
  return { ...electron, default: electron }
})
vi.mock('./windowRegistry', () => ({ broadcastToAll: vi.fn() }))
vi.mock('./logger', () => ({
  default: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
}))
// settingsFile + jsonStateFile start chokidar watchers; stub it so the test
// doesn't create real filesystem watchers on the temp userData dir.
vi.mock('chokidar', () => ({ watch: () => ({ on: vi.fn(), close: vi.fn() }) }))
// ./menu pulls in the auto-updater graph; stub the one function store.ts uses.
vi.mock('./menu', () => ({ setLayoutNames: vi.fn() }))

const { registerHandlers } = await import('./store')
const { SETTINGS_GET, LAYOUT_LIST } = await import('../shared/ipc-channels')
const { DEFAULT_SETTINGS } = await import('../shared/types')

beforeAll(async () => {
  // A corrupt config.json must be present before registerHandlers() runs the
  // one-time migration.
  fs.writeFileSync(cfgPath, '{ this is : not valid json,,, ')
  registerHandlers()
})

afterAll(() => {
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* noop */ }
})

describe('store corruption resilience', () => {
  test('a corrupt config.json keeps the store IPC surface working', async () => {
    // Settings live in settings.json → unaffected by a corrupt config.json.
    const getHandler = handlers.get(SETTINGS_GET)
    expect(getHandler).toBeTypeOf('function')
    expect(await getHandler!({}, 'warnBeforeQuit')).toBe(DEFAULT_SETTINGS.warnBeforeQuit)
    // A workspace-state-backed IPC resolves to defaults instead of rejecting.
    const layoutHandler = handlers.get(LAYOUT_LIST)
    expect(layoutHandler).toBeTypeOf('function')
    expect(await layoutHandler!({})).toEqual([])
  })

  test('the corrupt config is preserved as a .corrupt-* backup and not deleted', () => {
    const backups = fs.readdirSync(userData).filter((f) => f.startsWith('config.json.corrupt-'))
    expect(backups.length).toBeGreaterThanOrEqual(1)
    const preserved = fs.readFileSync(path.join(userData, backups[0]), 'utf-8')
    expect(preserved).toContain('not valid json')
    // A corrupt config is left in place (migration bails) for support/recovery.
    expect(fs.existsSync(cfgPath)).toBe(true)
  })
})
