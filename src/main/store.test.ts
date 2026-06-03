// =============================================================================
// store.ts corruption resilience — a corrupt config.json must NOT break the
// settings IPC surface for the whole session. We verify store.ts's own logic:
//   1. getStore() (via SETTINGS_GET) resolves to defaults instead of rejecting
//      when config.json is invalid JSON (it passes clearInvalidConfig: true).
//   2. the corrupt file is preserved as a `config.json.corrupt-*` backup.
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
const { SETTINGS_GET } = await import('../shared/ipc-channels')
const { DEFAULT_SETTINGS } = await import('../shared/types')

beforeAll(() => {
  // Corrupt config.json must exist before the first getStore() call.
  fs.writeFileSync(cfgPath, '{ this is : not valid json,,, ')
  registerHandlers()
})

afterAll(() => {
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* noop */ }
})

describe('store corruption resilience', () => {
  test('SETTINGS_GET resolves to defaults instead of rejecting on a corrupt config', async () => {
    const getHandler = handlers.get(SETTINGS_GET)
    expect(getHandler).toBeTypeOf('function')
    const value = await getHandler!({}, 'warnBeforeQuit')
    expect(value).toBe(DEFAULT_SETTINGS.warnBeforeQuit)
  })

  test('the corrupt config is preserved as a .corrupt-* backup', () => {
    const backups = fs.readdirSync(userData).filter((f) => f.startsWith('config.json.corrupt-'))
    expect(backups.length).toBeGreaterThanOrEqual(1)
    const preserved = fs.readFileSync(path.join(userData, backups[0]), 'utf-8')
    expect(preserved).toContain('not valid json')
  })
})
