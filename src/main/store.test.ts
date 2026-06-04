// =============================================================================
// store.ts corruption resilience — a corrupt config.json must NOT break the
// store IPC surface for the whole session. We verify store.ts's own logic:
//   1. AppSettings now live in settings.json (see ./settingsFile), so a corrupt
//      config.json can't affect SETTINGS_GET at all — it still returns defaults.
//   2. getStore() (reached via a config.json-backed IPC like LAYOUT_LIST)
//      resolves to defaults instead of rejecting when config.json is invalid
//      JSON (it passes clearInvalidConfig: true), and preserves the corrupt file
//      as a `config.json.corrupt-*` backup.
//
// electron-store is replaced with a faithful fake that reproduces its
// clearInvalidConfig contract (reset-to-defaults on a JSON SyntaxError) — the
// real package's Electron-runtime detection doesn't work under plain vitest,
// and the behavior under test is store.ts's, not electron-store's internals.
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
// settingsFile starts a chokidar watcher in registerHandlers(); stub it so the
// test doesn't create a real filesystem watcher on the temp userData dir.
vi.mock('chokidar', () => ({ watch: () => ({ on: vi.fn(), close: vi.fn() }) }))

// Faithful electron-store fake: honors clearInvalidConfig like the real one.
vi.mock('electron-store', () => {
  class FakeStore {
    private data: Record<string, any>
    constructor(opts: any) {
      let parsed: Record<string, any> = {}
      if (fs.existsSync(cfgPath)) {
        try {
          parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
        } catch (err) {
          // Real electron-store resets to defaults on SyntaxError when
          // clearInvalidConfig is set; otherwise it rethrows.
          if (!opts?.clearInvalidConfig) throw err
          parsed = {}
        }
      }
      this.data = { ...(opts?.defaults ?? {}), ...parsed }
    }
    get(key: string): unknown { return this.data[key] }
    get store(): Record<string, any> { return this.data }
  }
  return { default: FakeStore }
})

const { registerHandlers } = await import('./store')
const { SETTINGS_GET, LAYOUT_LIST } = await import('../shared/ipc-channels')
const { DEFAULT_SETTINGS } = await import('../shared/types')

beforeAll(async () => {
  // Corrupt config.json must exist before the first getStore() call.
  fs.writeFileSync(cfgPath, '{ this is : not valid json,,, ')
  registerHandlers()
  // Trigger getStore() through a config.json-backed IPC so the corrupt config is
  // detected, backed up, and reset to defaults.
  await handlers.get(LAYOUT_LIST)?.({})
})

afterAll(() => {
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* noop */ }
})

describe('store corruption resilience', () => {
  test('a corrupt config.json keeps the store IPC surface working', async () => {
    // Settings live in settings.json now → unaffected by a corrupt config.json.
    const getHandler = handlers.get(SETTINGS_GET)
    expect(getHandler).toBeTypeOf('function')
    expect(await getHandler!({}, 'warnBeforeQuit')).toBe(DEFAULT_SETTINGS.warnBeforeQuit)
    // A config.json-backed IPC resolves to defaults instead of rejecting.
    const layoutHandler = handlers.get(LAYOUT_LIST)
    expect(layoutHandler).toBeTypeOf('function')
    expect(await layoutHandler!({})).toEqual([])
  })

  test('the corrupt config is preserved as a .corrupt-* backup', () => {
    const backups = fs.readdirSync(userData).filter((f) => f.startsWith('config.json.corrupt-'))
    expect(backups.length).toBeGreaterThanOrEqual(1)
    const preserved = fs.readFileSync(path.join(userData, backups[0]), 'utf-8')
    expect(preserved).toContain('not valid json')
  })
})
