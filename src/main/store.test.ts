// =============================================================================
// store.ts — SETTINGS_SET / SETTINGS_RESET broadcast the full settings as
// SETTINGS_RELOADED. AppSettings live in settings.json and the workspace-state
// keys live in their own files (see ./workspaceStateStore).
// =============================================================================

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-store-test-'))

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
const { SETTINGS_SET, SETTINGS_RESET, SETTINGS_RELOADED } = await import('../shared/ipc-channels')
const { DEFAULT_SETTINGS } = await import('../shared/types')
const { broadcastToAll } = await import('./windowRegistry')
const broadcastMock = broadcastToAll as unknown as ReturnType<typeof vi.fn>

beforeAll(async () => {
  registerHandlers()
})

afterAll(() => {
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* noop */ }
})

describe('SETTINGS_SET / SETTINGS_RESET broadcast', () => {
  test('SETTINGS_SET broadcasts the full settings as SETTINGS_RELOADED', async () => {
    broadcastMock.mockClear()
    const setHandler = handlers.get(SETTINGS_SET)
    expect(setHandler).toBeTypeOf('function')
    await setHandler!({}, 'editorFontSize', 19)

    const reloaded = broadcastMock.mock.calls.find((c: unknown[]) => c[0] === SETTINGS_RELOADED)
    expect(reloaded).toBeTruthy()
    // The funnel broadcasts the complete settings object (a pure projection),
    // reflecting the change just written.
    expect((reloaded![1] as Record<string, unknown>).editorFontSize).toBe(19)
  })

  test('a rejected SETTINGS_SET (wrong type) does not broadcast', async () => {
    broadcastMock.mockClear()
    const setHandler = handlers.get(SETTINGS_SET)
    await setHandler!({}, 'editorFontSize', 'not-a-number')
    expect(broadcastMock.mock.calls.some((c: unknown[]) => c[0] === SETTINGS_RELOADED)).toBe(false)
  })

  test('SETTINGS_RESET broadcasts the full settings as SETTINGS_RELOADED', async () => {
    broadcastMock.mockClear()
    const resetHandler = handlers.get(SETTINGS_RESET)
    expect(resetHandler).toBeTypeOf('function')
    await resetHandler!({}, 'editorFontSize')

    const reloaded = broadcastMock.mock.calls.find((c: unknown[]) => c[0] === SETTINGS_RELOADED)
    expect(reloaded).toBeTruthy()
    expect((reloaded![1] as Record<string, unknown>).editorFontSize).toBe(DEFAULT_SETTINGS.editorFontSize)
  })
})
